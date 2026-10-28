//! Built-in AI: a small language model that runs on this PC, so Sonix never needs
//! an API key, an account or a server. The frontend asks it only when a built-in
//! feature can't help (a command the rules don't understand, screen insights).
//!
//! - The model (Qwen2.5 1.5B Instruct, Apache-2.0) is too big for the installer, so
//!   on first launch it downloads in the background into
//!   %LOCALAPPDATA%\com.voice.sonix\models, like the Whisper model.
//! - It runs in llama.cpp's llama-server, shipped in the installer (resources/llama,
//!   fetched by scripts/fetch-llama.mjs). That build uses the GPU through Vulkan when
//!   there is one and the CPU otherwise. It is a separate process, rather than linked
//!   in, because whisper.cpp and llama.cpp both embed ggml and clash in one binary.
//! - The server starts on the first request and stops after a few idle minutes, so
//!   the model only holds memory while it is being used.
//!
//! The main window follows progress through `ai-model` events carrying a
//! `ModelStatus`; `ai_model_status` returns the current one.

use std::fs;
use std::net::TcpListener;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::download::{self, ModelFile};

const MODEL_FILE: &str = "qwen2.5-1.5b-instruct-q4_k_m.gguf";
const MODEL: ModelFile = ModelFile {
    url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/qwen2.5-1.5b-instruct-q4_k_m.gguf",
    size: 1_117_320_736,
    sha256: "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
};

/// Below this the model (about 1.5 GB while running) would crowd out everything else.
/// An "8 GB" laptop reports a little under 8, hence 6.
const MIN_RAM_GB: u64 = 6;
/// Stop the server after this long without a request, to give its memory back.
const IDLE_SHUTDOWN: Duration = Duration::from_secs(5 * 60);
/// Loading the model from disk on a slow laptop takes a while; give up after this.
const START_TIMEOUT: Duration = Duration::from_secs(120);
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum ModelStatus {
    Missing,
    Downloading { downloaded: u64, total: u64 },
    Ready,
    /// This PC can't run the model; Sonix keeps working with its built-in features.
    Unsupported { message: String },
    Error { message: String },
}

struct Server {
    child: Child,
    port: u16,
    last_used: Instant,
}

pub struct Ai {
    status: Mutex<ModelStatus>,
    /// Set once the model file is downloaded and verified.
    model_path: OnceLock<PathBuf>,
    server: Mutex<Option<Server>>,
    /// A download is running.
    busy: AtomicBool,
    /// The idle-shutdown loop has been started.
    reaper: AtomicBool,
}

impl Default for Ai {
    fn default() -> Self {
        Self {
            status: Mutex::new(ModelStatus::Missing),
            model_path: OnceLock::new(),
            server: Mutex::new(None),
            busy: AtomicBool::new(false),
            reaper: AtomicBool::new(false),
        }
    }
}

impl Ai {
    fn set_status(&self, app: &AppHandle, status: ModelStatus) {
        if let Ok(mut current) = self.status.lock() {
            *current = status.clone();
        }
        let _ = app.emit_to("main", "ai-model", status);
    }

    fn stop_server(&self) {
        if let Some(mut server) = self.server.lock().ok().and_then(|mut s| s.take()) {
            let _ = server.child.kill();
            let _ = server.child.wait();
            log::info!("ai: server stopped");
        }
    }
}

/// Downloads the model in the background if needed. Does nothing if it is already
/// here or on its way.
pub fn ensure(app: &AppHandle) {
    let ai = app.state::<Ai>();
    if ai.model_path.get().is_some() || ai.busy.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let ai = app.state::<Ai>();
        match prepare(&app).await {
            Ok(status) => ai.set_status(&app, status),
            Err(message) => {
                log::warn!("ai: {}", message);
                ai.set_status(&app, ModelStatus::Error { message });
            }
        }
        ai.busy.store(false, Ordering::SeqCst);
    });
}

async fn prepare(app: &AppHandle) -> Result<ModelStatus, String> {
    let ram = total_ram_gb();
    if ram < MIN_RAM_GB {
        return Ok(ModelStatus::Unsupported {
            message: format!(
                "This PC has {} GB of memory and the AI model needs about {} GB, so Sonix uses its built-in features only.",
                ram, MIN_RAM_GB + 2
            ),
        });
    }
    if !server_exe(app)?.exists() {
        return Err("The AI engine is missing from this installation. Reinstall Sonix to restore it.".into());
    }

    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("models");
    fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {}", dir.display(), e))?;
    let path = dir.join(MODEL_FILE);

    if fs::metadata(&path).map(|m| m.len()).ok() != Some(MODEL.size) {
        let _ = fs::remove_file(&path);
        let ai = app.state::<Ai>();
        download::download(&MODEL, &path, |downloaded| {
            ai.set_status(app, ModelStatus::Downloading { downloaded, total: MODEL.size });
        })
        .await?;
    }

    let _ = app.state::<Ai>().model_path.set(path);
    start_reaper(app);
    log::info!("ai: model ready");
    Ok(ModelStatus::Ready)
}

fn server_exe(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().resource_dir().map_err(|e| e.to_string())?.join("llama").join("llama-server.exe"))
}

/// Stops the server once it has sat idle for IDLE_SHUTDOWN.
fn start_reaper(app: &AppHandle) {
    if app.state::<Ai>().reaper.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio_sleep(Duration::from_secs(60)).await;
            let ai = app.state::<Ai>();
            let idle = ai
                .server
                .lock()
                .ok()
                .and_then(|s| s.as_ref().map(|s| s.last_used.elapsed() >= IDLE_SHUTDOWN))
                .unwrap_or(false);
            if idle {
                ai.stop_server();
            }
        }
    });
}

async fn tokio_sleep(duration: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration)).await;
}

/// Starts loading the model in the background, so it is ready by the time the
/// command the user is speaking needs it. Called when listening starts; does
/// nothing until the model is downloaded.
pub fn warm_up(app: &AppHandle) {
    if app.state::<Ai>().model_path.get().is_none() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = server_port(&app).await {
            log::warn!("ai: warm-up failed: {}", e);
        }
    });
}

/// The port of a running server, starting one if needed and waiting until the model
/// has loaded.
async fn server_port(app: &AppHandle) -> Result<u16, String> {
    let ai = app.state::<Ai>();
    let model = ai.model_path.get().ok_or("The AI model isn't downloaded yet.")?.clone();

    let port = {
        let mut server = ai.server.lock().map_err(|e| e.to_string())?;
        // A server that crashed is replaced.
        if let Some(s) = server.as_mut() {
            if matches!(s.child.try_wait(), Ok(Some(_))) {
                *server = None;
            }
        }
        match server.as_mut() {
            Some(s) => {
                s.last_used = Instant::now();
                s.port
            }
            None => {
                let started = spawn_server(app, &model)?;
                let port = started.port;
                *server = Some(started);
                port
            }
        }
    };

    wait_until_loaded(app, port).await.inspect_err(|_| ai.stop_server())?;
    Ok(port)
}

fn spawn_server(app: &AppHandle, model: &Path) -> Result<Server, String> {
    let exe = server_exe(app)?;
    let port = TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| format!("No free port for the AI engine: {}", e))?;

    let child = Command::new(&exe)
        .arg("-m")
        .arg(ascii_path(model))
        .args(["--host", "127.0.0.1", "--port", &port.to_string()])
        // Short prompts, one at a time: a small context and one slot keep memory low.
        .args(["-c", "4096", "-np", "1", "--no-webui"])
        .current_dir(exe.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Couldn't start the AI engine: {}", e))?;

    kill_with_sonix(&child);
    log::info!("ai: server starting on port {}", port);
    Ok(Server { child, port, last_used: Instant::now() })
}

/// Polls /health, which answers 200 once the model has loaded.
async fn wait_until_loaded(app: &AppHandle, port: u16) -> Result<(), String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(2)).build().map_err(|e| e.to_string())?;
    let started = Instant::now();
    loop {
        if let Ok(response) = client.get(format!("http://127.0.0.1:{}/health", port)).send().await {
            if response.status().is_success() {
                return Ok(());
            }
        }
        let exited = app
            .state::<Ai>()
            .server
            .lock()
            .ok()
            .and_then(|mut s| s.as_mut().map(|s| matches!(s.child.try_wait(), Ok(Some(_)))))
            .unwrap_or(true);
        if exited {
            return Err("The AI engine stopped while loading the model.".into());
        }
        if started.elapsed() > START_TIMEOUT {
            return Err("The AI engine took too long to load the model.".into());
        }
        tokio_sleep(Duration::from_millis(250)).await;
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    prompt: String,
    /// The built-in model reads text only; a request with an image is declined.
    #[serde(default)]
    image: Option<String>,
    /// Ask for a JSON reply (the server then constrains the output to valid JSON).
    #[serde(default)]
    json: bool,
    #[serde(default)]
    max_tokens: Option<u32>,
    /// Questions about live facts. Declined: an offline model would only guess.
    #[serde(default)]
    web_search: bool,
}

/// Runs one prompt through the built-in model and returns the reply.
pub async fn generate(app: &AppHandle, request: Request) -> Result<String, String> {
    if request.web_search {
        return Err("The built-in AI works offline and can't look things up on the web.".into());
    }
    if request.image.is_some() {
        return Err("The built-in AI reads text only.".into());
    }

    let port = server_port(app).await?;

    let mut body = json!({
        "messages": [{ "role": "user", "content": request.prompt }],
        "temperature": 0.2,
        "max_tokens": request.max_tokens.unwrap_or(512),
    });
    if request.json {
        body["response_format"] = json!({ "type": "json_object" });
    }

    let started = Instant::now();
    let reply: Value = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{}/v1/chat/completions", port))
        .timeout(Duration::from_secs(120))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("The AI engine didn't answer: {}", e))?
        .json()
        .await
        .map_err(|e| format!("The AI engine sent an unreadable reply: {}", e))?;

    if let Ok(mut server) = app.state::<Ai>().server.lock() {
        if let Some(s) = server.as_mut() {
            s.last_used = Instant::now();
        }
    }

    if let Some(message) = reply["error"]["message"].as_str() {
        return Err(format!("AI error: {}", message));
    }
    let text = reply["choices"][0]["message"]["content"].as_str().unwrap_or("").trim();
    if text.is_empty() {
        return Err("The AI returned no text.".into());
    }
    log::info!("ai: answered in {} ms", started.elapsed().as_millis());
    Ok(text.to_string())
}

/// Installed memory in whole GB; a large number if Windows won't say, so the check passes.
fn total_ram_gb() -> u64 {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    match unsafe { GlobalMemoryStatusEx(&mut status) } {
        Ok(()) => status.ullTotalPhys / (1 << 30),
        Err(_) => u64::MAX,
    }
}

/// llama.cpp reads its command line in the ANSI code page, so a path with other
/// characters (a user name like "José") is passed in its short 8.3 form instead.
fn ascii_path(path: &Path) -> PathBuf {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetShortPathNameW;

    if path.to_str().is_some_and(|p| p.is_ascii()) {
        return path.to_path_buf();
    }
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut buf = vec![0u16; 1024];
    let len = unsafe { GetShortPathNameW(PCWSTR(wide.as_ptr()), Some(&mut buf)) } as usize;
    if len == 0 || len > buf.len() {
        return path.to_path_buf();
    }
    PathBuf::from(String::from_utf16_lossy(&buf[..len]))
}

/// Puts the server in a job object that Windows kills when Sonix exits, even if
/// Sonix crashes, so it never lingers in the background on its own.
fn kill_with_sonix(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    // One job for the life of Sonix; its handle closes (killing the job) when Sonix exits.
    static JOB: OnceLock<Option<usize>> = OnceLock::new();
    let job = JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(None, None).ok()?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .ok()?;
        Some(job.0 as usize)
    });
    if let Some(job) = job {
        unsafe {
            let _ = AssignProcessToJobObject(HANDLE(*job as _), HANDLE(child.as_raw_handle()));
        }
    }
}

#[tauri::command]
pub fn ai_model_status(ai: State<'_, Ai>) -> ModelStatus {
    ai.status.lock().map(|s| s.clone()).unwrap_or(ModelStatus::Missing)
}

/// Retries after a failed download.
#[tauri::command]
pub fn ai_model_download(app: AppHandle) {
    ensure(&app);
}
