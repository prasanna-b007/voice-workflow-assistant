//! Narrow system actions for the frontend: key presses, volume, brightness, opening links
//! and files, switching apps and window actions. Each takes typed arguments, so nothing
//! the frontend (or the AI behind it) sends can turn into a command line or a script.

use std::ffi::OsStr;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use windows::core::PCWSTR;
use windows::Win32::System::Shutdown::LockWorkStation;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    MOUSEEVENTF_WHEEL, MOUSEINPUT, VIRTUAL_KEY, VK_CONTROL, VK_F4, VK_LWIN, VK_MEDIA_NEXT_TRACK,
    VK_MEDIA_PLAY_PAUSE, VK_MEDIA_PREV_TRACK, VK_MENU, VK_VOLUME_DOWN, VK_VOLUME_MUTE, VK_VOLUME_UP,
};
use windows::Win32::UI::Shell::SHEmptyRecycleBinW;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const VK_D: VIRTUAL_KEY = VIRTUAL_KEY(0x44);
const VK_R: VIRTUAL_KEY = VIRTUAL_KEY(0x52);
const VK_S: VIRTUAL_KEY = VIRTUAL_KEY(0x53);

/// A console program that runs without a console window. In a release build a visible
/// console would also take the keyboard focus, so Ctrl+S or Alt+F4 sent next would land
/// on it instead of the user's app.
pub fn hidden(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

fn key(vk: VIRTUAL_KEY, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn send(inputs: &[INPUT]) -> Result<(), String> {
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        Err("Windows blocked the key press.".into())
    }
}

/// Holds `keys` down in order, then releases them in reverse: a shortcut like Ctrl+S.
pub fn chord(keys: &[VIRTUAL_KEY]) -> Result<(), String> {
    let mut inputs: Vec<INPUT> = keys.iter().map(|&k| key(k, false)).collect();
    inputs.extend(keys.iter().rev().map(|&k| key(k, true)));
    send(&inputs)
}

fn tap(vk: VIRTUAL_KEY, times: u32) -> Result<(), String> {
    let inputs: Vec<INPUT> = (0..times).flat_map(|_| [key(vk, false), key(vk, true)]).collect();
    send(&inputs)
}

/// Win+Alt+R: Xbox Game Bar starts or stops recording the screen.
pub fn toggle_screen_recording() -> Result<(), String> {
    chord(&[VK_LWIN, VK_MENU, VK_R])
}

/// Turns the mouse wheel by `clicks` notches; positive is up.
pub fn scroll(clicks: i32) -> Result<(), String> {
    const WHEEL_DELTA: i32 = 120;
    send(&[INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: (clicks * WHEEL_DELTA) as _,
                dwFlags: MOUSEEVENTF_WHEEL,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }])
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Keys {
    /// Ctrl+S in the app in front.
    Save,
    /// Alt+F4 in the app in front.
    CloseWindow,
    VolumeMute,
    /// Five volume steps (10%).
    VolumeUp,
    VolumeDown,
    PlayPause,
    NextTrack,
    PreviousTrack,
}

#[tauri::command]
pub fn press_keys(keys: Keys) -> Result<(), String> {
    match keys {
        Keys::Save => chord(&[VK_CONTROL, VK_S]),
        Keys::CloseWindow => chord(&[VK_MENU, VK_F4]),
        Keys::VolumeMute => tap(VK_VOLUME_MUTE, 1),
        Keys::VolumeUp => tap(VK_VOLUME_UP, 5),
        Keys::VolumeDown => tap(VK_VOLUME_DOWN, 5),
        Keys::PlayPause => tap(VK_MEDIA_PLAY_PAUSE, 1),
        Keys::NextTrack => tap(VK_MEDIA_NEXT_TRACK, 1),
        Keys::PreviousTrack => tap(VK_MEDIA_PREV_TRACK, 1),
    }
}

/// Sets the volume to `level` percent. Each volume key moves 2%, so: all the way down,
/// then back up.
#[tauri::command]
pub fn set_volume(level: u8) -> Result<(), String> {
    tap(VK_VOLUME_DOWN, 50)?;
    tap(VK_VOLUME_UP, u32::from(level.min(100)) / 2)
}

/// Sets a laptop screen's brightness to `level` percent (external monitors don't support it).
#[tauri::command(async)]
pub fn set_brightness(level: u8) -> Result<(), String> {
    let script = format!(
        "(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1, {})",
        level.min(100)
    );
    let output = hidden("powershell")
        .args(["-NoProfile", "-Command", &script])
        .output()
        .map_err(|e| format!("Couldn't change the brightness: {}", e))?;
    if output.status.success() {
        Ok(())
    } else {
        Err("This screen's brightness can't be changed by Sonix.".into())
    }
}

/// Link types Sonix opens. Anything else (file:, a path, an unknown handler) is refused,
/// because Windows would run whatever it points at.
const URI_SCHEMES: &[&str] = &[
    "http", "https", "mailto", "spotify", "whatsapp", "tg", "discord", "msteams", "zoommtg", "skype",
    "ms-settings", "ms-screenclip", "ms-clock", "ms-windows-store", "bingmaps", "microsoft.windows.camera",
    "search-ms",
];

/// Opens a link with the app Windows has registered for it.
#[tauri::command]
pub fn open_uri(uri: String) -> Result<(), String> {
    let scheme = uri.split_once(':').map(|(s, _)| s.to_ascii_lowercase()).unwrap_or_default();
    // The one shell: folder Sonix opens ("show recent files").
    if !(URI_SCHEMES.contains(&scheme.as_str()) || uri.eq_ignore_ascii_case("shell:Recent")) {
        return Err(format!("Sonix doesn't open \"{}\" links.", scheme));
    }
    tauri_plugin_opener::open_url(&uri, None::<&str>).map_err(|e| format!("Couldn't open {}: {}", uri, e))
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowAction {
    MinimizeAll,
    Lock,
    EmptyRecycleBin,
}

#[tauri::command(async)]
pub fn window_action(action: WindowAction) -> Result<(), String> {
    match action {
        // Win+D: show the desktop.
        WindowAction::MinimizeAll => chord(&[VK_LWIN, VK_D]),
        WindowAction::Lock => unsafe { LockWorkStation() }.map_err(|e| format!("Couldn't lock the PC: {}", e)),
        WindowAction::EmptyRecycleBin => {
            // Flags 0: Windows shows its own "Are you sure?" dialog first. It reports an
            // error when the bin is already empty, which needs no message.
            if let Err(e) = unsafe { SHEmptyRecycleBinW(None, PCWSTR::null(), 0) } {
                log::info!("system: recycle bin not emptied: {}", e);
            }
            Ok(())
        }
    }
}

/// A process name such as "winword" or "chrome": letters, digits, dots, dashes, underscores.
pub fn is_process_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// Brings a running app's window to the front (restoring it if minimised), or starts it.
#[tauri::command(async)]
pub fn switch_to_app(process_name: String) -> Result<(), String> {
    if !is_process_name(&process_name) {
        return Err(format!("\"{}\" isn't an app name.", process_name));
    }
    // The name reaches PowerShell as an environment variable, never as script text.
    const SCRIPT: &str = "$p = Get-Process -Name $env:SONIX_APP -ErrorAction SilentlyContinue | \
        Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; \
        if ($p) { \
          Add-Type -Namespace Sonix -Name Win -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr h, int c); [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr h);'; \
          if ([Sonix.Win]::IsIconic($p.MainWindowHandle)) { [Sonix.Win]::ShowWindowAsync($p.MainWindowHandle, 9) | Out-Null }; \
          (New-Object -ComObject WScript.Shell).AppActivate($p.Id) | Out-Null \
        } else { Start-Process $env:SONIX_APP }";
    hidden("powershell")
        .args(["-NoProfile", "-Command", SCRIPT])
        .env("SONIX_APP", &process_name)
        .output()
        .map_err(|e| format!("Couldn't switch to {}: {}", process_name, e))?;
    Ok(())
}

/// Opens the first file whose name contains `name`, searching Desktop, Documents and
/// Downloads (and their subfolders).
#[tauri::command(async)]
pub fn open_file(app: AppHandle, name: String) -> Result<String, String> {
    let wanted = name.trim().to_lowercase();
    if wanted.is_empty() {
        return Err("Which file?".into());
    }
    let paths = app.path();
    let roots: Vec<PathBuf> = [paths.desktop_dir(), paths.document_dir(), paths.download_dir()]
        .into_iter()
        .filter_map(Result::ok)
        .collect();
    let mut budget = 50_000; // directory entries to look at before giving up
    for root in &roots {
        if let Some(found) = find_file(root, &wanted, 6, &mut budget) {
            tauri_plugin_opener::open_path(&found, None::<&str>)
                .map_err(|e| format!("Couldn't open {}: {}", found.display(), e))?;
            return Ok(found.display().to_string());
        }
    }
    Err(format!("I couldn't find a file called {}.", name.trim()))
}

fn find_file(dir: &Path, wanted: &str, depth: u32, budget: &mut u32) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        if *budget == 0 {
            return None;
        }
        *budget -= 1;
        let file_name = entry.file_name().to_string_lossy().to_lowercase();
        if file_name.starts_with('.') || file_name == "node_modules" {
            continue;
        }
        match entry.file_type() {
            Ok(t) if t.is_file() && file_name.contains(wanted) => return Some(entry.path()),
            Ok(t) if t.is_dir() => subdirs.push(entry.path()),
            _ => {}
        }
    }
    if depth == 0 {
        return None;
    }
    subdirs.iter().find_map(|d| find_file(d, wanted, depth - 1, budget))
}

/// The local date and time as "2026-10-28_22-05-09", for file names.
pub fn timestamp() -> String {
    let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    format!("{:04}-{:02}-{:02}_{:02}-{:02}-{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond)
}
