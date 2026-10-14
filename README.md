# Sonix — Voice Workflow Assistant

A Windows desktop voice assistant built with **Tauri 2 + React 19**. Say "hey Sonix"
(or press a hotkey), speak a command, and it drives your machine: opens apps, toggles
system settings, dictates text, analyses what's on screen, and files reports.

Intent parsing runs a fast local rule engine first, falling back to **Google Gemini**
for anything the rules don't cover.

## Install (end users)

1. Download `Sonix_<version>_x64-setup.exe` from the
   [latest release](https://github.com/prasanna-b007/voice-workflow-assistant/releases/latest)
   and run it.
2. *(Optional, enables AI parsing and screen analysis)* get a Gemini API key at
   <https://aistudio.google.com/apikey> and save it in
   `%APPDATA%\com.voice.sonix\config.json`:

   ```json
   { "gemini_api_key": "your-key-here" }
   ```

   Without it, Sonix still works using its built-in local commands.

## Repository layout

| Path | What it is |
|---|---|
| `frontend/` | The desktop app — React UI (`src/`) + Rust backend (`src-tauri/`) |
| `website/` | Marketing landing page (React + Tailwind) |

## Prerequisites

- **Node.js 20+**
- **Rust** (stable) — `winget install Rustlang.Rustup`
- **Visual Studio Build Tools** with the "Desktop development with C++" workload
  (supplies the MSVC linker Rust needs on Windows)
- **WebView2 Runtime** — preinstalled on Windows 11

## Setup

```bash
cd frontend
npm install
```

Then supply a Gemini API key (get one at <https://aistudio.google.com/apikey>).
The key is read by the **Rust** backend at runtime, never by the frontend, so it
stays out of the shipped JavaScript bundle. Two ways to provide it, checked in order:

1. **Environment variable** — convenient for development:

   ```powershell
   $env:GEMINI_API_KEY = "your-key-here"
   npm run tauri dev
   ```

2. **Config file** — persists across sessions. Create
   `%APPDATA%\com.voice.sonix\config.json`:

   ```json
   { "gemini_api_key": "your-key-here" }
   ```

With no key configured the assistant still runs: every AI call falls back to the
local rule engine, and screen/dashboard analysis reports that it is unavailable.

## Running

```bash
npm run tauri dev     # dev build with hot reload
npm run tauri build   # packaged installer -> src-tauri/target/release/bundle/
```

To publish a release, upload `src-tauri/target/release/bundle/nsis/Sonix_<version>_x64-setup.exe`
to a GitHub Release tagged `v<version>`. The website's download links
(`INSTALLER_URL` in `website/src/App.jsx`) point at that tag and filename, so update
them whenever the version in `src-tauri/tauri.conf.json` changes.

The Vite dev server runs on port **1420** (pinned via `strictPort`).

For the landing page: `cd website && npm install && npm run dev`.

## Checks

```bash
npm run lint          # ESLint
npm run build         # production frontend bundle
cargo check           # from frontend/src-tauri, type-checks the Rust side
```

## How it works

1. **Wake** — `src/voice/wakeWordListener.js` listens continuously for "hey Sonix";
   alternatively `Ctrl+Shift+Space` (workflow mode) or `Ctrl+Shift+H` (dictation mode),
   registered as global shortcuts in `src-tauri/src/main.rs`.
2. **Listen** — a transparent, always-on-top overlay window appears and
   `src/voice/speechRecognition.js` transcribes speech in real time.
3. **Parse** — `src/ai/aiParser.js` matches ~40 local regex rules first (instant, offline);
   anything unmatched goes to Gemini via the Rust `call_gemini` command (see `src/ai/geminiConfig.js`),
   which returns a strict JSON intent.
4. **Execute** — `src/workflows/workflowExecutor.js` dispatches the intent to one of ten
   Rust commands over Tauri's `invoke` bridge.
5. **Act** — `src-tauri/src/main.rs` performs the OS work, via PowerShell/`taskkill`/`powercfg`
   for UI automation and native Windows APIs (the `windows` crate) for radios and hotspot.
6. **Reply** — text-to-speech confirmation, plus written reports to `Desktop/reports/`.

## Capabilities

**Voice control** — wake-word detection, speech-to-text, text-to-speech replies, and two
modes: Workflow (command execution) and Dictation (text input).

**Application management** — open, switch to, and close apps (VS Code, Excel, Word, Discord,
Spotify, browsers and more); save files in the current or a named app; direct shortcuts to web
apps (YouTube, Gmail, WhatsApp, Google, GitHub, LinkedIn, …).

**System control** — volume and brightness (up, down, or an exact level); toggles for WiFi,
Bluetooth, mobile hotspot, airplane mode, night light, and battery saver; scroll, screenshot,
screen recording, shutdown, and restart.

**Information retrieval** — current time, current date, weather.

**Screen and dashboard analysis** — captures the screen, runs it through Gemini Vision with
OCR (tesseract.js) and clipboard extraction as fallbacks, cleans the result, and writes a
report to `Desktop/reports/`.

**Workflow and task management** — multi-step command sequences, task storage with dates and
times, and calendar/meeting creation.

**Email and communication** — compose emails with recipient, subject, and body; send messages
via WhatsApp, Discord, and Telegram.

**Conversation control** — continuous listening across multiple commands, continuation
detection, interrupt handling, and sequential command queueing.

**Feedback** — a wake chime, spoken confirmation of actions, and live status in the overlay.

## Known limitations

- **Windows only.** The Rust backend leans on PowerShell and Win32/WinRT APIs throughout.
- **Speech recognition depends on the Web Speech API**, whose availability in the WebView2
  runtime is not guaranteed.
