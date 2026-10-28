//! Local speech-to-text with OpenAI's Whisper (large-v3-turbo), run by whisper.cpp.
//!
//! The model is too big to bundle with the installer, so on first launch it is downloaded
//! into %LOCALAPPDATA%\com.voice.sonix\models (resuming a partial download), checked
//! against its SHA-256, then loaded once and kept in memory. Until it is ready, speech.rs
//! falls back to Windows' recognizer.
//!
//! The main window follows progress through `voice-model` events carrying a
//! `ModelStatus`; `voice_model_status` returns the current one.

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState};

use crate::download::{self, ModelFile};
use crate::mic::SAMPLE_RATE;

const MODEL_FILE: &str = "ggml-large-v3-turbo-q5_0.bin";
const MODEL: ModelFile = ModelFile {
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin",
    size: 574_041_195,
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
};

/// Steers spelling towards the commands Sonix understands ("VS Code", not "this code").
const COMMAND_PROMPT: &str = "Sonix voice commands: open Chrome, open VS Code, close Notepad, \
    open WhatsApp, play music on YouTube, turn on wifi, turn off Bluetooth, volume up, \
    set brightness to 50, take a screenshot, analyze my screen, send an email.";

#[derive(Clone, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum ModelStatus {
    Missing,
    Downloading { downloaded: u64, total: u64 },
    Loading,
    Ready,
    Error { message: String },
}

pub struct Whisper {
    status: Mutex<ModelStatus>,
    /// Set once the model has loaded. One state, reused: creating one allocates
    /// hundreds of MB.
    model: OnceLock<Mutex<WhisperState>>,
    /// A download or load is running.
    busy: AtomicBool,
}

impl Default for Whisper {
    fn default() -> Self {
        Self { status: Mutex::new(ModelStatus::Missing), model: OnceLock::new(), busy: AtomicBool::new(false) }
    }
}

impl Whisper {
    pub fn ready(&self) -> bool {
        self.model.get().is_some()
    }

    /// Transcribes 16 kHz mono speech. Blocks for the duration of the inference.
    pub fn transcribe(&self, audio: &[f32]) -> Result<String, String> {
        let state = self.model.get().ok_or("The voice model isn't loaded.")?;
        let mut state = state.lock().map_err(|e| e.to_string())?;
        let started = Instant::now();
        let text = run(&mut state, audio)?;
        log::info!(
            "whisper: {:.1} s of audio in {} ms",
            audio.len() as f32 / SAMPLE_RATE as f32,
            started.elapsed().as_millis()
        );
        Ok(text)
    }

    fn set_status(&self, app: &AppHandle, status: ModelStatus) {
        if let Ok(mut current) = self.status.lock() {
            *current = status.clone();
        }
        let _ = app.emit_to("main", "voice-model", status);
    }
}

/// Loads the model, downloading it first if needed, in the background. Does nothing if
/// it is already loaded or on its way.
pub fn ensure(app: &AppHandle) {
    let whisper = app.state::<Whisper>();
    if whisper.ready() || whisper.busy.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = prepare(&app).await;
        let whisper = app.state::<Whisper>();
        match result {
            Ok(()) => whisper.set_status(&app, ModelStatus::Ready),
            Err(message) => {
                log::warn!("whisper: {}", message);
                whisper.set_status(&app, ModelStatus::Error { message });
            }
        }
        whisper.busy.store(false, Ordering::SeqCst);
    });
}

/// Argument that makes Sonix's executable only test the GPU (see `run_gpu_probe`).
pub const GPU_PROBE_ARG: &str = "--probe-gpu";

/// The GPU test, run in a separate copy of Sonix started by `find_gpu`. Prints the GPU's
/// name and exits 0, or exits non-zero when there is none.
///
/// It runs apart from Sonix because it can't fail gracefully: vulkan-1.dll is
/// delay-loaded (build.rs), so without it the first Vulkan call faults; and a Vulkan
/// loader with no working driver makes ggml throw a C++ exception, which aborts the
/// process. Either way, only this copy dies, and Sonix carries on with Windows' recognizer.
pub fn run_gpu_probe() -> ! {
    use windows::core::w;
    use windows::Win32::System::LibraryLoader::LoadLibraryW;

    if unsafe { LoadLibraryW(w!("vulkan-1.dll")) }.is_err() {
        std::process::exit(2);
    }
    match whisper_rs::vulkan::list_devices().into_iter().next() {
        Some(gpu) => {
            println!("{}", gpu.name);
            std::process::exit(0)
        }
        None => std::process::exit(1),
    }
}

/// The name of a Vulkan GPU Whisper can use, or None. See `run_gpu_probe`.
fn find_gpu() -> Option<String> {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::Duration;

    let exe = std::env::current_exe().ok()?;
    let mut child = crate::system::hidden(exe)
        .arg(GPU_PROBE_ARG)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < Duration::from_secs(20) => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                log::warn!("whisper: GPU check didn't finish");
                return None;
            }
        }
    };
    let mut name = String::new();
    child.stdout.take()?.read_to_string(&mut name).ok()?;
    log::info!("whisper: GPU check exited with {:?}", status.code());
    status.success().then(|| name.trim().to_string())
}

async fn prepare(app: &AppHandle) -> Result<(), String> {
    // On the CPU a command takes minutes, so without a GPU don't even download the model.
    let gpu = tauri::async_runtime::spawn_blocking(find_gpu).await.map_err(|e| e.to_string())?;
    let Some(gpu) = gpu else {
        return Err("No compatible graphics card (Vulkan) found, so Sonix keeps using Windows speech recognition.".into());
    };
    log::info!("whisper: using GPU {}", gpu);

    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("models");
    fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {}", dir.display(), e))?;
    let path = dir.join(MODEL_FILE);

    if fs::metadata(&path).map(|m| m.len()).ok() != Some(MODEL.size) {
        let _ = fs::remove_file(&path);
        let whisper = app.state::<Whisper>();
        download::download(&MODEL, &path, |downloaded| {
            whisper.set_status(app, ModelStatus::Downloading { downloaded, total: MODEL.size });
        })
        .await?;
    }

    app.state::<Whisper>().set_status(app, ModelStatus::Loading);
    let load_path = path.clone();
    let state = tauri::async_runtime::spawn_blocking(move || load(&load_path))
        .await
        .map_err(|e| e.to_string())?
        .inspect_err(|_| {
            // Most likely a damaged file: fetch a fresh copy on the next attempt.
            let _ = fs::remove_file(&path);
        })?;
    let _ = app.state::<Whisper>().model.set(Mutex::new(state));
    log::info!("whisper: model ready");
    Ok(())
}

fn load(path: &Path) -> Result<WhisperState, String> {
    let started = Instant::now();
    let mut params = WhisperContextParameters::default();
    params.use_gpu(true).flash_attn(true);
    let failed = |e: whisper_rs::WhisperError| format!("Couldn't load the voice model: {}", e);
    // whisper.cpp opens files through the ANSI code page, so a path with non-ASCII
    // characters (a user name like "José") must be read here and passed in memory.
    let context = match path.to_str() {
        Some(p) if p.is_ascii() => WhisperContext::new_with_params(p, params).map_err(failed)?,
        _ => {
            let bytes = fs::read(path).map_err(|e| format!("Couldn't read {}: {}", path.display(), e))?;
            WhisperContext::new_from_buffer_with_params(&bytes, params).map_err(failed)?
        }
    };
    let mut state = context.create_state().map_err(failed)?;
    // The first inference pays one-off setup costs (and GPU shader compilation); pay
    // them now rather than on the user's first command.
    let _ = run(&mut state, &[0.0; SAMPLE_RATE as usize]);
    log::info!("whisper: model loaded in {} ms", started.elapsed().as_millis());
    Ok(state)
}

fn run(state: &mut WhisperState, audio: &[f32]) -> Result<String, String> {
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_n_threads(threads());
    params.set_language(Some("en"));
    params.set_translate(false);
    params.set_no_context(true);
    params.set_suppress_nst(true);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_special(false);
    params.set_print_timestamps(false);
    params.set_initial_prompt(COMMAND_PROMPT);

    // whisper.cpp ignores anything under a second.
    let min = SAMPLE_RATE as usize * 6 / 5;
    let mut padded;
    let audio = if audio.len() < min {
        padded = audio.to_vec();
        padded.resize(min, 0.0);
        &padded[..]
    } else {
        audio
    };

    state.full(params, audio).map_err(|e| format!("Speech recognition failed: {}", e))?;
    let mut text = String::new();
    for segment in state.as_iter() {
        text.push_str(&segment.to_str_lossy().map_err(|e| e.to_string())?);
    }
    Ok(clean(&text))
}

/// Strips the sound annotations Whisper writes for non-speech: "[BLANK_AUDIO]",
/// "[Music]", or a transcript that is only "(laughs)" or "*sigh*".
fn clean(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut depth = 0;
    for c in text.chars() {
        match c {
            '[' => depth += 1,
            ']' if depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    let out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let annotation = (out.starts_with('(') && out.ends_with(')')) || (out.starts_with('*') && out.ends_with('*'));
    if annotation {
        String::new()
    } else {
        out
    }
}

/// whisper.cpp runs best on physical cores, and gains little past 8.
fn threads() -> i32 {
    let logical = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    (logical / 2).clamp(1, 8) as i32
}

#[tauri::command]
pub fn voice_model_status(whisper: State<'_, Whisper>) -> ModelStatus {
    whisper.status.lock().map(|s| s.clone()).unwrap_or(ModelStatus::Missing)
}

/// Retries after a failed download or load.
#[tauri::command]
pub fn voice_model_download(app: AppHandle) {
    ensure(&app);
}
