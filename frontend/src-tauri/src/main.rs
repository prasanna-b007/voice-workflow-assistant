// Prevent a console window appearing in Windows release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod assist;
mod download;
mod mic;
mod ocr;
mod speech;
mod system;
mod whisper;

use tauri::Manager;
use tauri::Emitter;
use tauri_plugin_global_shortcut::{Builder as ShortcutBuilder, GlobalShortcutExt, ShortcutState};
use std::fs;
use std::path::PathBuf;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

/// What `open_app` accepts: an executable or app name ("code", "winword", "google chrome")
/// or a Windows link ("ms-settings:"). No quotes, &, |, ^, %, <, > or parentheses, which
/// `cmd /C start` would treat as commands.
fn is_app_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_alphanumeric() || " ._:-".contains(c))
}

#[tauri::command]
fn open_app(app_name: String) -> Result<String, String> {
    log::info!("open_app: {}", app_name);
    if !is_app_name(&app_name) {
        return Err(format!("\"{}\" isn't an app name.", app_name));
    }
    match system::hidden("cmd").args(["/C", "start", "", &app_name]).spawn() {
        Ok(_) => Ok(format!("Opened {}", app_name)),
        Err(e) => Err(format!("Failed to open {}: {}", app_name, e)),
    }
}

#[tauri::command(async)]
fn save_in_app(app_name: String) -> Result<String, String> {
    log::info!("save_in_app: {}", app_name);
    // Focus the app (its name arrives as an environment variable, never as script text),
    // then press Ctrl+S in whatever is in front.
    let _ = system::hidden("powershell")
        .args(["-NoProfile", "-Command", "(New-Object -ComObject WScript.Shell).AppActivate($env:SONIX_APP) | Out-Null"])
        .env("SONIX_APP", &app_name)
        .output();
    std::thread::sleep(std::time::Duration::from_millis(200));
    system::press_keys(system::Keys::Save)?;
    Ok(format!("Sent save signal to {}", app_name))
}

/// Processes "close …" never touches: Windows' own, and Sonix's.
const PROTECTED_PROCESSES: &[&str] = &[
    "explorer", "svchost", "csrss", "wininit", "winlogon", "lsass", "services", "smss", "dwm", "sihost",
    "taskhostw", "ctfmon", "fontdrvhost", "runtimebroker", "searchhost", "searchapp", "startmenuexperiencehost",
    "shellexperiencehost", "textinputhost", "msedgewebview2", "system", "registry", "audiodg", "spoolsv",
    "conhost", "powershell", "cmd", "app", "sonix", "llama-server",
];

/// Closes the app whose process is exactly `app_name` ("winword", "chrome"; "note pad"
/// also tries "notepad"). Windows are asked to close, as if the user clicked X, so an app
/// with unsaved work can ask to save. Only processes without a window, like a music app
/// minimised to the tray, are ended outright, and only once no window is left open.
#[tauri::command(async)]
fn close_app(app_name: String) -> Result<String, String> {
    log::info!("close_app: {}", app_name);
    const SCRIPT: &str = "$procs = @(Get-Process -Name $env:SONIX_APP -ErrorAction SilentlyContinue); \
        if ($procs.Count -eq 0) { exit 3 }; \
        foreach ($p in $procs) { if ($p.MainWindowHandle -ne 0) { [void]$p.CloseMainWindow() } }; \
        Start-Sleep -Milliseconds 1500; \
        $open = @($procs | Where-Object { $_.Refresh(); -not $_.HasExited -and $_.MainWindowHandle -ne 0 }); \
        if ($open.Count -gt 0) { exit 4 }; \
        $procs | Where-Object { -not $_.HasExited } | Stop-Process -Force -ErrorAction SilentlyContinue; \
        exit 0";

    let name = app_name.trim().to_lowercase();
    let name = name.strip_suffix(".exe").unwrap_or(&name).to_string();
    let mut candidates = vec![name.clone()];
    if name.contains(' ') {
        candidates.push(name.replace(' ', ""));
    }
    for candidate in candidates.iter().filter(|c| system::is_process_name(c)) {
        if PROTECTED_PROCESSES.contains(&candidate.as_str()) {
            return Err(format!("I won't close {}: Windows or Sonix needs it.", app_name));
        }
        let status = system::hidden("powershell")
            .args(["-NoProfile", "-Command", SCRIPT])
            .env("SONIX_APP", candidate)
            .status()
            .map_err(|e| format!("Couldn't close {}: {}", app_name, e))?;
        match status.code() {
            Some(0) => return Ok(format!("Closed {}", app_name)),
            // It's showing "Save changes?" or similar: leave it to the user.
            Some(4) => return Ok(format!("Asked {} to close", app_name)),
            _ => continue,
        }
    }
    Err(format!("{} isn't running.", app_name))
}

/// Types `text` into `app_name` (or the app in front when empty) by pasting it, then puts
/// the user's clipboard back. Pasting keeps any character intact (₹, é, emoji, new lines),
/// which typed keystrokes don't. The text and app name reach PowerShell as a file and an
/// environment variable, never as script text.
#[tauri::command(async)]
fn type_text(text: String, app_name: String) -> Result<String, String> {
    log::info!("type_text into {:?} ({} characters)", app_name, text.chars().count());
    const SCRIPT: &str = "$wshell = New-Object -ComObject WScript.Shell; \
        if ($env:SONIX_APP) { if ($wshell.AppActivate($env:SONIX_APP)) { Start-Sleep -Milliseconds 250 } }; \
        $old = Get-Clipboard -Raw -ErrorAction SilentlyContinue; \
        Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 -LiteralPath $env:SONIX_TEXT_FILE); \
        Start-Sleep -Milliseconds 150; \
        $wshell.SendKeys('^v'); \
        Start-Sleep -Milliseconds 500; \
        if ($null -ne $old) { Set-Clipboard -Value $old }";

    let file = std::env::temp_dir().join(format!("sonix-type-{}.txt", std::process::id()));
    fs::write(&file, &text).map_err(|e| format!("Failed to prepare the text: {}", e))?;
    let result = system::hidden("powershell")
        .args(["-NoProfile", "-Command", SCRIPT])
        .env("SONIX_APP", &app_name)
        .env("SONIX_TEXT_FILE", &file)
        .output();
    let _ = fs::remove_file(&file);
    match result {
        Ok(_) => Ok(format!("Typed message in {}", app_name)),
        Err(e) => Err(format!("Failed to type the text: {}", e)),
    }
}

/// Runs a quick-setting or power action. `minutes` is only for "shutdown_timer".
/// Runs off the main thread: some of these wait on Windows for seconds.
#[tauri::command(async)]
fn system_control(action: String, state: String, minutes: Option<u32>) -> Result<String, String> {
    log::info!("system_control: action={}, state={}", action, state);

    match action.as_str() {
        "toggle_wifi" | "toggle_bluetooth" => return toggle_radio_native(&action, &state),
        "toggle_airplane_mode" => return toggle_airplane_mode(&state),
        "toggle_hotspot" => return toggle_hotspot_native(&state),
        "toggle_energy_saver" => return toggle_energy_saver_native(&state),
        "scroll_down" => return system::scroll(-6).map(|_| "Scrolled down".into()),
        "scroll_up" => return system::scroll(6).map(|_| "Scrolled up".into()),
        "close_active" => return system::press_keys(system::Keys::CloseWindow).map(|_| "Closed the window".into()),
        "toggle_screenshot" => {
            return system::open_uri("ms-screenclip:".into()).map(|_| "Opened the snipping tool".into())
        }
        "toggle_screen_recording" => {
            return system::toggle_screen_recording().map(|_| "Toggled screen recording".into())
        }
        "shutdown" | "restart" | "cancel_shutdown" | "shutdown_timer" => {
            let mut args: Vec<String> = match action.as_str() {
                "shutdown" => vec!["/s".into(), "/t".into(), "30".into()],
                "restart" => vec!["/r".into(), "/t".into(), "30".into()],
                "cancel_shutdown" => vec!["/a".into()],
                _ => {
                    let minutes = minutes.unwrap_or(10).clamp(1, 24 * 60);
                    vec!["/s".into(), "/t".into(), (minutes * 60).to_string()]
                }
            };
            if action != "cancel_shutdown" {
                args.extend(["/c".into(), "Sonix scheduled this. Say \"cancel shutdown\" to stop it.".into()]);
            }
            let status = system::hidden("shutdown.exe")
                .args(&args)
                .status()
                .map_err(|e| format!("Couldn't run {}: {}", action, e))?;
            // Cancelling when nothing is scheduled fails harmlessly.
            return if status.success() || action == "cancel_shutdown" {
                Ok(format!("Done: {}", action))
            } else {
                Err(format!("Windows refused to {}.", action.replace('_', " ")))
            };
        }
        _ => {}
    }

    // Settings with no native API: a fixed script, no outside input in it.
    let ps_script = match action.as_str() {
        "toggle_night_light" => r#"
             try {
                 # Use Registry to toggle Night Light (most reliable method)
                 $regPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Settings\Display\NightLight'
                 $setting = Get-ItemProperty -Path $regPath -Name 'NightLightState' -ErrorAction SilentlyContinue
                 $currentState = if ($setting) { $setting.NightLightState } else { 0 }
                 $newState = if ($currentState -eq 1) { 0 } else { 1 }
                 Set-ItemProperty -Path $regPath -Name 'NightLightState' -Value $newState -Force
                 
                 # Notify Windows of the change by toggling a related setting
                 $settings = New-Object -ComObject 'Windows.UI.ViewManagement.UISettings'
                 [void]$settings
             } catch {
                 # Fallback: Open Settings
                 Start-Process 'ms-settings:nightlight'
             }
        "#.to_string(),
        _ => return Err(format!("Unknown system action: {}", action))
    };

    match system::hidden("powershell")
        .args(["-NoProfile", "-Command", &ps_script])
        .output()
    {
        Ok(output) => {
            if output.status.success() {
                println!("{} executed successfully", action);
                Ok(format!("Successfully executed {}", action))
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let stdout = String::from_utf8_lossy(&output.stdout);
                eprintln!("{} failed - stderr: {}, stdout: {}", action, stderr, stdout);
                Ok(format!("Executed {} (check logs for details)", action))
            }
        },
        Err(e) => {
            eprintln!("Failed to spawn powershell for {}: {}", action, e);
            Err(format!("Failed to execute {}: {}", action, e))
        },
    }
}

/// Airplane mode as Windows does it: every radio (Wi-Fi, Bluetooth, mobile data) off, or
/// back on. "Toggle" turns them all off if any is on.
fn toggle_airplane_mode(state: &str) -> Result<String, String> {
    use windows::Devices::Radios::{Radio, RadioState};

    let radios = Radio::GetRadiosAsync()
        .and_then(|op| op.get())
        .map_err(|e| format!("Couldn't read the radios: {}", e))?;
    let radios: Vec<Radio> = radios.into_iter().collect();
    let any_on = radios.iter().any(|r| r.State().map(|s| s == RadioState::On).unwrap_or(false));
    let airplane_on = match state {
        "on" => true,
        "off" => false,
        _ => any_on,
    };
    let target = if airplane_on { RadioState::Off } else { RadioState::On };
    let mut changed = 0;
    for radio in &radios {
        if radio.SetStateAsync(target).and_then(|op| op.get()).is_ok() {
            changed += 1;
        }
    }
    if changed == 0 {
        // Some PCs only allow it from Settings.
        let _ = system::open_uri("ms-settings:network-airplanemode".into());
        return Ok("Opened airplane mode settings".into());
    }
    Ok(format!("Airplane mode {}", if airplane_on { "on" } else { "off" }))
}

fn toggle_energy_saver_native(state: &str) -> Result<String, String> {
    // Balanced: 381b4222-f694-41f0-9685-ff5bb260df2e
    // Power saver: a1841308-3541-40af-b0ce-9b86fa98a6d3
    
    let target_scheme = if state == "on" {
        "a1841308-3541-40af-b0ce-9b86fa98a6d3"
    } else if state == "off" {
        "381b4222-f694-41f0-9685-ff5bb260df2e"
    } else {
        // Toggle: check current
        let is_currently_saver = if let Ok(output) = system::hidden("powercfg").args(["/getactivescheme"]).output() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            stdout.contains("a1841308-3541-40af-b0ce-9b86fa98a6d3")
        } else {
            false
        };
        if is_currently_saver { "381b4222-f694-41f0-9685-ff5bb260df2e" } else { "a1841308-3541-40af-b0ce-9b86fa98a6d3" }
    };

    println!("Switching to power scheme: {}", target_scheme);
    
    match system::hidden("powercfg")
        .args(["/setactive", target_scheme])
        .output()
    {
        Ok(output) if output.status.success() => {
            println!("Energy saver toggled successfully");
            Ok(format!("Energy saver set to {}", if target_scheme.contains("a184") { "ON" } else { "OFF" }))
        },
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            eprintln!("Powercfg failed: {}", stderr);
            // Don't fail - system may not support or user doesn't have permissions
            Ok("Energy saver request sent (may require admin privileges)".to_string())
        },
        Err(e) => {
            eprintln!("Failed to execute powercfg: {}", e);
            Err(format!("Failed to execute powercfg: {}", e))
        },
    }
}

fn toggle_hotspot_native(state: &str) -> Result<String, String> {
    use windows::Networking::Connectivity::NetworkInformation;
    use windows::Networking::NetworkOperators::{NetworkOperatorTetheringManager, TetheringOperationalState};

    let profile = NetworkInformation::GetInternetConnectionProfile()
        .map_err(|e| format!("Failed to get connection profile: {}", e))?;

    let manager = NetworkOperatorTetheringManager::CreateFromConnectionProfile(&profile)
        .map_err(|e| format!("Failed to create tethering manager: {}", e))?;

    let current_state = manager.TetheringOperationalState().unwrap_or(TetheringOperationalState::Off);
    let is_on = current_state == TetheringOperationalState::On;
    
    let turn_on = match state {
        "on" => true,
        "off" => false,
        _ => !is_on,
    };

    if turn_on {
        if let Err(e) = manager.StartTetheringAsync().and_then(|op| op.get()) {
            return Err(format!("Failed to start hotspot: {}", e));
        }
    } else {
        if let Err(e) = manager.StopTetheringAsync().and_then(|op| op.get()) {
            return Err(format!("Failed to stop hotspot: {}", e));
        }
    }

    Ok(format!("Successfully toggled hotspot to {}", if turn_on { "ON" } else { "OFF" }))
}

fn toggle_radio_native(action: &str, state: &str) -> Result<String, String> {
    use windows::Devices::Radios::{Radio, RadioKind, RadioState};

    println!("toggle_radio_native called: action={}, state={}", action, state);

    let target_kind = match action {
        "toggle_wifi" => RadioKind::WiFi,
        "toggle_bluetooth" => RadioKind::Bluetooth,
        _ => return Err(format!("Unsupported radio action: {}", action)),
    };

    match Radio::GetRadiosAsync() {
        Ok(async_op) => {
            match async_op.get() {
                Ok(radios) => {
                    let mut toggled = false;
                    for radio in radios {
                        if let Ok(kind) = radio.Kind() {
                            if kind == target_kind {
                                match radio.State() {
                                    Ok(current_state) => {
                                        let desired_state = match state {
                                            "on" => RadioState::On,
                                            "off" => RadioState::Off,
                                            _ => {
                                                if current_state == RadioState::On {
                                                    RadioState::Off
                                                } else {
                                                    RadioState::On
                                                }
                                            }
                                        };
                                        
                                        println!("Current state: {:?}, Desired state: {:?}", current_state, desired_state);
                                        
                                        match radio.SetStateAsync(desired_state) {
                                            Ok(set_op) => {
                                                match set_op.get() {
                                                    Ok(_) => {
                                                        println!("Successfully set {} state to {:?}", action, desired_state);
                                                        toggled = true;
                                                    },
                                                    Err(e) => {
                                                        eprintln!("SetStateAsync failed: {}", e);
                                                    }
                                                }
                                            },
                                            Err(e) => {
                                                eprintln!("SetStateAsync creation failed: {}", e);
                                            }
                                        }
                                    },
                                    Err(e) => {
                                        eprintln!("Failed to get radio state: {}", e);
                                    }
                                }
                            }
                        }
                    }

                    if toggled {
                        Ok(format!("Successfully toggled {}", action))
                    } else {
                        eprintln!("Could not find or toggle radio for {}", action);
                        Err(format!("Could not find a radio for {}", action))
                    }
                },
                Err(e) => {
                    eprintln!("Failed to get radios list: {}", e);
                    Err(format!("Failed to get radios list: {}", e))
                }
            }
        },
        Err(e) => {
            eprintln!("Failed to GetRadiosAsync: {}", e);
            Err(format!("Failed to GetRadiosAsync: {}", e))
        }
    }
}

/// Captures the entire primary screen (all monitors joined) and returns a
/// Base64-encoded JPEG string, which the frontend runs OCR on.
#[tauri::command(async)]
fn capture_screenshot() -> Result<String, String> {
    use screenshots::Screen;
    use image::ImageFormat;
    use std::io::Cursor;

    // Grab all available screens; fall back to just the primary if enumeration fails
    let screens = Screen::all().map_err(|e| format!("Failed to enumerate screens: {}", e))?;

    if screens.is_empty() {
        return Err("No screens found.".to_string());
    }

    // Use the first screen (primary monitor).  For multi-monitor support we
    // could stitch them together, but a single-screen capture is the most
    // reliable for AI analysis.
    let screen = &screens[0];
    let capture = screen.capture().map_err(|e| format!("Screen capture failed: {}", e))?;

    // capture is an image::ImageBuffer<image::Rgba<u8>, Vec<u8>>
    let width = capture.width();
    let height = capture.height();
    let raw_pixels = capture.into_raw(); // consumes the buffer, gives Vec<u8>

    // Build RgbaImage from raw pixels
    let rgba_image = image::RgbaImage::from_raw(width, height, raw_pixels)
        .ok_or_else(|| "Failed to construct RGBA image from capture.".to_string())?;

    let rgb_image = image::DynamicImage::ImageRgba8(rgba_image).to_rgb8();

    let mut jpeg_buf: Vec<u8> = Vec::new();
    let mut cursor = Cursor::new(&mut jpeg_buf);
    image::DynamicImage::ImageRgb8(rgb_image)
        .write_to(&mut cursor, ImageFormat::Jpeg)
        .map_err(|e| format!("Failed to encode JPEG: {}", e))?;

    Ok(BASE64.encode(&jpeg_buf))
}

/// Writes a report to Desktop\reports\screen_report_<date-time>.txt, so earlier reports
/// are kept. Uses the real Desktop folder, which OneDrive often moves.
fn write_report(app: &tauri::AppHandle, report: &str) -> Result<PathBuf, String> {
    let desktop = app.path().desktop_dir().map_err(|e| format!("Could not find the Desktop folder: {}", e))?;
    let reports_dir = desktop.join("reports");
    fs::create_dir_all(&reports_dir).map_err(|e| format!("Could not create reports directory: {}", e))?;
    let report_path = reports_dir.join(format!("screen_report_{}.txt", system::timestamp()));
    fs::write(&report_path, report).map_err(|e| format!("Could not save screen report: {}", e))?;
    Ok(report_path)
}

#[tauri::command]
fn save_screen_report(app: tauri::AppHandle, report: String) -> Result<String, String> {
    Ok(write_report(&app, &report)?.to_string_lossy().to_string())
}

/// Shows text in Notepad by opening it as a file. With `save`, the file is a report on
/// the Desktop; otherwise a temporary file. Opening a file, rather than pasting into a
/// freshly started Notepad, can't put the text into some other window that happened
/// to be in front.
#[tauri::command]
fn show_in_notepad(app: tauri::AppHandle, text: String, save: bool) -> Result<String, String> {
    let path = if save {
        write_report(&app, &text)?
    } else {
        let path = std::env::temp_dir().join(format!("Sonix report {}.txt", system::timestamp()));
        fs::write(&path, &text).map_err(|e| format!("Could not write the report: {}", e))?;
        path
    };
    std::process::Command::new("notepad.exe")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Could not open Notepad: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

/// Reads the text on a screenshot with Windows' built-in OCR (see ocr.rs).
#[tauri::command]
async fn ocr_image(image: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ocr::read_text(&image))
        .await
        .map_err(|e| format!("OCR task failed: {}", e))?
}

/// Runs a prompt through the built-in AI model (see ai.rs).
#[tauri::command]
async fn ai_generate(app: tauri::AppHandle, request: ai::Request) -> Result<String, String> {
    ai::generate(&app, request).await
}

fn main() {
    // Sonix starts a copy of itself with this flag to test the GPU (see whisper.rs).
    if std::env::args().nth(1).as_deref() == Some(whisper::GPU_PROBE_ARG) {
        whisper::run_gpu_probe();
    }

    tauri::Builder::default()
        // Enable opener plugin
        .plugin(tauri_plugin_opener::init())
        // Enable shell plugin
        .plugin(tauri_plugin_shell::init())
        // Enable logging plugin
        // whisper.cpp logs every decoded token at debug level; keep only its warnings.
        .plugin(tauri_plugin_log::Builder::default().level_for("whisper_rs", log::LevelFilter::Warn).build())
        // Native speech recognition state (see speech.rs)
        .manage(speech::SpeechState::default())
        // Local Whisper model (see whisper.rs)
        .manage(whisper::Whisper::default())
        // Built-in AI model (see ai.rs)
        .manage(ai::Ai::default())
        // Global shortcut: register handler + key in builder (works in both dev & release)
                .plugin(
                    ShortcutBuilder::new()
                        .with_handler(|app, shortcut, event| {
                            if event.state == ShortcutState::Pressed
                                && shortcut == &"Ctrl+Shift+Space".parse().unwrap()
                            {
                                println!("Shortcut triggered");

                                if let Some(window) = app.get_webview_window("assistant") {
                                    // emit_to, not emit: emit broadcasts to every window,
                                    // and only the overlay should start listening.
                                    let _ = app.emit_to("assistant", "trigger-assistant", ());
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        })
                        .build(),
                )
                // Single setup block — register the shortcut exactly once
                .setup(|app| {
                    let gs = app.global_shortcut();
                    if let Err(e) = gs.register("Ctrl+Shift+Space") {
                        eprintln!("Failed to register workflow shortcut: {}", e);
                    }

                    // Load the Whisper model in the background, downloading it on first run.
                    whisper::ensure(app.handle());
                    // Likewise the built-in AI model.
                    ai::ensure(app.handle());

                    Ok(())
                })
        // Register command handlers
        .invoke_handler(tauri::generate_handler![open_app, save_in_app, close_app, type_text, save_screen_report, show_in_notepad, capture_screenshot, system_control, system::press_keys, system::set_volume, system::set_brightness, system::open_uri, system::window_action, system::switch_to_app, system::open_file, ocr_image, ai_generate, ai::ai_model_status, ai::ai_model_download, assist::youtube_first_video, assist::read_selection, assist::has_url_handler, assist::search_results, assist::news_headlines, speech::speech_start_wake, speech::speech_stop_wake, speech::speech_listen, speech::speech_cancel, whisper::voice_model_status, whisper::voice_model_download])
        // Run app
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
