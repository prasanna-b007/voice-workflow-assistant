// Prevent a console window appearing in Windows release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use tauri::Emitter;
use tauri_plugin_global_shortcut::{Builder as ShortcutBuilder, GlobalShortcutExt, ShortcutState};
use std::fs;
use std::path::PathBuf;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

#[tauri::command]
fn open_app(app_name: String) -> Result<String, String> {
    println!("open_app command triggered for: {}", app_name);
    match std::process::Command::new("cmd")
        .args(["/C", "start", "", &app_name])
        .spawn()
    {
        Ok(_) => Ok(format!("Opened {}", app_name)),
        Err(e) => Err(format!("Failed to open {}: {}", app_name, e)),
    }
}

#[tauri::command]
fn save_in_app(app_name: String) -> Result<String, String> {
    println!("save_in_app command triggered for: {}", app_name);
    // Use PowerShell to focus the app and send Ctrl+S (^s)
    let ps_script = format!(
        "$wshell = New-Object -ComObject WScript.Shell; \
         if ($wshell.AppActivate('{}')) {{ \
             Start-Sleep -m 200; \
             $wshell.SendKeys('^s'); \
         }} else {{ \
             # Fallback: Just send keys to current active window
             $wshell.SendKeys('^s'); \
         }}",
        app_name
    );

    match std::process::Command::new("powershell")
        .args(["-Command", &ps_script])
        .spawn()
    {
        Ok(_) => Ok(format!("Sent save signal to {}", app_name)),
        Err(e) => Err(format!("Failed to execute save command: {}", e)),
    }
}

#[tauri::command]
fn close_app(app_name: String) -> Result<String, String> {
    println!("close_app command triggered for: {}", app_name);
    
    let trimmed = app_name.trim().to_lowercase();
    // Also try without spaces (speech may say "note pad" instead of "notepad")
    let no_spaces = trimmed.replace(" ", "");
    
    // Collect all name variants to try
    let mut names_to_try = vec![trimmed.clone()];
    if no_spaces != trimmed {
        names_to_try.push(no_spaces.clone());
    }
    
    for name in &names_to_try {
        // Strategy 1: Try taskkill with .exe
        if let Ok(output) = std::process::Command::new("taskkill")
            .args(["/IM", &format!("{}.exe", name), "/F"])
            .output()
        {
            if output.status.success() {
                return Ok(format!("Closed {} via taskkill", name));
            }
        }
        
        // Strategy 2: Try taskkill without .exe
        if let Ok(output) = std::process::Command::new("taskkill")
            .args(["/IM", name, "/F"])
            .output()
        {
            if output.status.success() {
                return Ok(format!("Closed {} via taskkill (no ext)", name));
            }
        }
    }

    // Strategy 3: PowerShell wildcard match with all variants
    let wildcard_name = if no_spaces != trimmed { &no_spaces } else { &trimmed };
    let ps_script = format!(
        "Get-Process | Where-Object {{ $_.ProcessName -like '*{}*' }} | Stop-Process -Force -ErrorAction SilentlyContinue",
        wildcard_name
    );

    match std::process::Command::new("powershell")
        .args(["-Command", &ps_script])
        .spawn()
    {
        Ok(_) => Ok(format!("Closed {} via wildcard match", app_name)),
        Err(e) => Err(format!("Failed to close {}: {}", app_name, e)),
    }
}

#[tauri::command]
fn type_text(text: String, app_name: String) -> Result<String, String> {
    println!("type_text command triggered for app: {} with text: {}", app_name, text);

    if text.len() > 200 || text.contains('\n') || text.contains('\r') {
        let temp_path = std::env::temp_dir().join("sonix_report_clipboard.txt");
        fs::write(&temp_path, &text)
            .map_err(|e| format!("Failed to prepare clipboard text: {}", e))?;

        let temp_path_str = temp_path.to_string_lossy().replace('\'', "''");
        let app_activation = if !app_name.is_empty() {
            format!("if ($wshell.AppActivate('{}')) {{ Start-Sleep -m 250; }}", app_name.replace('\'', "''"))
        } else {
            "".to_string()
        };

        let ps_script = format!(
            "$wshell = New-Object -ComObject WScript.Shell; \
             $text = Get-Content -Raw -LiteralPath '{}'; \
             Set-Clipboard -Value $text; \
             {} \
             Start-Sleep -m 150; \
             $wshell.SendKeys('^v');",
            temp_path_str, app_activation
        );

        return match std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &ps_script])
            .spawn()
        {
            Ok(_) => Ok(format!("Pasted message in {}", app_name)),
            Err(e) => Err(format!("Failed to paste text: {}", e)),
        };
    }
    
    // Escaping special characters for SendKeys: { } [ ] ( ) + ^ % ~
    let escaped_text = text
        .replace('{', "{{}")
        .replace('}', "{}}")
        .replace('[', "{[}")
        .replace(']', "{]}")
        .replace('(', "{(}")
        .replace(')', "{)}")
        .replace('+', "{+}")
        .replace('^', "{^}")
        .replace('%', "{%}")
        .replace('~', "{~}")
        .replace('\'', "''"); // PowerShell single quote escaping

    let app_activation = if !app_name.is_empty() {
        format!("if ($wshell.AppActivate('{}')) {{ Start-Sleep -m 200; }}", app_name)
    } else {
        "".to_string()
    };

    let ps_script = format!(
        "$wshell = New-Object -ComObject WScript.Shell; \
         {} \
         $wshell.SendKeys('{}');",
        app_activation, escaped_text
    );

    match std::process::Command::new("powershell")
        .args(["-Command", &ps_script])
        .spawn()
    {
        Ok(_) => Ok(format!("Typed message in {}", app_name)),
        Err(e) => Err(format!("Failed to execute type command: {}", e)),
    }
}

#[tauri::command]
fn save_dashboard_report(report: String) -> Result<String, String> {
    let user_profile = std::env::var("USERPROFILE")
        .map_err(|e| format!("Could not resolve user profile: {}", e))?;
    let reports_dir = PathBuf::from(user_profile).join("Desktop").join("reports");

    fs::create_dir_all(&reports_dir)
        .map_err(|e| format!("Could not create reports directory: {}", e))?;

    let report_path = reports_dir.join("dashboard_report.txt");
    fs::write(&report_path, report)
        .map_err(|e| format!("Could not save dashboard report: {}", e))?;

    Ok(report_path.to_string_lossy().to_string())
}

#[tauri::command]
fn system_control(action: String, state: String) -> Result<String, String> {
    println!("system_control triggered: action={}, state={}", action, state);
    
    if action == "toggle_wifi" || action == "toggle_bluetooth" {
        return toggle_radio_native(&action, &state);
    }
    
    if action == "toggle_hotspot" {
        return toggle_hotspot_native(&state);
    }
    
    if action == "toggle_energy_saver" {
        return toggle_energy_saver_native(&state);
    }
    
    // Fallback UI automation for settings that don't have direct accessible native APIs
    let ps_script = match action.as_str() {
        "shutdown" => "shutdown.exe /s /t 30 /c \"Sonix is shutting down your PC. Type 'shutdown -a' to abort.\"".to_string(),
        "restart" => "shutdown.exe /r /t 30 /c \"Sonix is restarting your PC. Type 'shutdown -a' to abort.\"".to_string(),
        "scroll_down" => r#"
             $code = @"
using System;
using System.Runtime.InteropServices;
public class ActionScrollDown {
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
    public static void DoScroll() {
        // -800 is a decent chunk of scroll (equivalent to approx 6-7 lines)
        mouse_event(0x0800, 0, 0, -800, 0); 
    }
}
"@
             Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
             [ActionScrollDown]::DoScroll()
        "#.to_string(),

        "scroll_up" => r#"
             $code = @"
using System;
using System.Runtime.InteropServices;
public class ActionScrollUp {
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
    public static void DoScroll() {
        mouse_event(0x0800, 0, 0, 800, 0);
    }
}
"@
             Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
             [ActionScrollUp]::DoScroll()
        "#.to_string(),
        "toggle_screenshot" => "Start-Process ms-screenclip:".to_string(),
        "toggle_screen_recording" => r#"
             $code = @"
using System;
using System.Runtime.InteropServices;
public class GameBarHotkey {
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
    public const int KEYEVENTF_KEYUP = 0x0002;
    public static void PressWinAltR() {
        keybd_event(0x5B, 0, 0, 0); // LWin down
        keybd_event(0x12, 0, 0, 0); // Alt down
        keybd_event(0x52, 0, 0, 0); // R down
        keybd_event(0x52, 0, KEYEVENTF_KEYUP, 0); // R up
        keybd_event(0x12, 0, KEYEVENTF_KEYUP, 0); // Alt up
        keybd_event(0x5B, 0, KEYEVENTF_KEYUP, 0); // LWin up
    }
}
"@
             Add-Type -TypeDefinition $code
             [GameBarHotkey]::PressWinAltR()
        "#.to_string(),
        "toggle_airplane_mode" => r#"
             try {
                 $radioMgr = New-Object -ComObject 'Windows.Devices.Radios.RadioManager'
                 $radios = $radioMgr.GetRadiosAsync().GetResults()
                 foreach ($radio in $radios) {
                     if ($radio.Kind -eq 1) { # WiFi
                         $state = $radio.State
                         if ($state -eq 0) { # On
                             $radio.SetStateAsync(1) # Off
                         } else {
                             $radio.SetStateAsync(0) # On
                         }
                         Start-Sleep -m 200
                     }
                 }
             } catch {
                 # Fallback: Use Settings URI
                 Start-Process 'ms-settings:network-airplanemode'
                 Start-Sleep -m 3000
             }
        "#.to_string(),
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
        "close_active" => r#"
             $wshell = New-Object -ComObject WScript.Shell;
             $wshell.SendKeys('%{F4}');
        "#.to_string(),
        _ => return Err(format!("Unknown system action: {}", action))
    };

    match std::process::Command::new("powershell")
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

fn toggle_energy_saver_native(state: &str) -> Result<String, String> {
    // Balanced: 381b4222-f694-41f0-9685-ff5bb260df2e
    // Power saver: a1841308-3541-40af-b0ce-9b86fa98a6d3
    
    let target_scheme = if state == "on" {
        "a1841308-3541-40af-b0ce-9b86fa98a6d3"
    } else if state == "off" {
        "381b4222-f694-41f0-9685-ff5bb260df2e"
    } else {
        // Toggle: check current
        let is_currently_saver = if let Ok(output) = std::process::Command::new("powercfg").args(["/getactivescheme"]).output() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            stdout.contains("a1841308-3541-40af-b0ce-9b86fa98a6d3")
        } else {
            false
        };
        if is_currently_saver { "381b4222-f694-41f0-9685-ff5bb260df2e" } else { "a1841308-3541-40af-b0ce-9b86fa98a6d3" }
    };

    println!("Switching to power scheme: {}", target_scheme);
    
    match std::process::Command::new("powercfg")
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
            Ok(format!("Energy saver request sent (may require admin privileges)"))
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

#[tauri::command]
fn system_control_raw(script: String) -> Result<String, String> {
    println!("system_control_raw triggered with script: {}", script);
    match std::process::Command::new("powershell")
        .args(["-Command", &script])
        .spawn()
    {
        Ok(_) => Ok("Executed script".to_string()),
        Err(e) => Err(format!("Failed to execute script: {}", e)),
    }
}

#[tauri::command]
fn get_clipboard_text() -> Result<String, String> {
    match std::process::Command::new("powershell")
        .args(["-Command", "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard"])
        .output()
    {
        Ok(output) => {
            let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Ok(text)
        },
        Err(e) => Err(format!("Failed to read clipboard: {}", e)),
    }
}

/// Captures the entire primary screen (all monitors joined) and returns a
/// Base64-encoded JPEG string that can be sent directly to Gemini Vision as
/// `inlineData { mimeType: "image/jpeg", data: <return value> }`.
#[tauri::command]
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

/// Saves a screen analysis report to Desktop/reports/screen_report.txt.
#[tauri::command]
fn save_screen_report(report: String) -> Result<String, String> {
    let user_profile = std::env::var("USERPROFILE")
        .map_err(|e| format!("Could not resolve user profile: {}", e))?;
    let reports_dir = PathBuf::from(user_profile).join("Desktop").join("reports");

    fs::create_dir_all(&reports_dir)
        .map_err(|e| format!("Could not create reports directory: {}", e))?;

    let report_path = reports_dir.join("screen_report.txt");
    fs::write(&report_path, report)
        .map_err(|e| format!("Could not save screen report: {}", e))?;

    Ok(report_path.to_string_lossy().to_string())
}

fn main() {
    tauri::Builder::default()
        // Enable opener plugin
        .plugin(tauri_plugin_opener::init())
        // Enable shell plugin
        .plugin(tauri_plugin_shell::init())
        // Enable logging plugin
        .plugin(tauri_plugin_log::Builder::default().build())
        // Global shortcut: register handler + key in builder (works in both dev & release)
                .plugin(
                    ShortcutBuilder::new()
                        .with_handler(|app, shortcut, event| {
                            if event.state == ShortcutState::Pressed {
                                let mode = if shortcut == &"Ctrl+Shift+Space".parse().unwrap() {
                                    "workflow"
                                } else if shortcut == &"Ctrl+Shift+H".parse().unwrap() {
                                    "dictation"
                                } else {
                                    return;
                                };

                                println!("Shortcut triggered: mode={}", mode);

                                if let Some(window) = app.get_webview_window("assistant") {
                                    let _ = window.emit("trigger-assistant", mode);
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        })
                        .build(),
                )
                // Single setup block — register the shortcuts exactly once
                .setup(|app| {
                    let gs = app.global_shortcut();
                    if let Err(e) = gs.register("Ctrl+Shift+Space") {
                        eprintln!("Failed to register workflow shortcut: {}", e);
                    }
                    if let Err(e) = gs.register("Ctrl+Shift+H") {
                        eprintln!("Failed to register dictation shortcut: {}", e);
                    }

                    Ok(())
                })
        // Register command handlers
        .invoke_handler(tauri::generate_handler![open_app, save_in_app, close_app, type_text, save_dashboard_report, save_screen_report, capture_screenshot, system_control, system_control_raw, get_clipboard_text])
        // Run app
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
