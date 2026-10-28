# Sonix — Voice Workflow Assistant

A Windows desktop voice assistant built with **Tauri 2 + React 19**. Say "hey Sonix"
(or press a hotkey), speak a command, and it drives your machine: opens apps, toggles
system settings, types text, analyses what's on screen, and files reports.

Everything runs on your PC, free, with no account, API key or server: commands are
understood by a built-in command table, the screen is read with Windows' own OCR, and
replies are fixed sentences. When the built-in part can't help, Sonix hands the job to its
own AI model, which also runs on your PC. The user never sets anything up.

## Install (end users)

1. Download `Sonix_<version>_x64-setup.exe` from the
   [latest release](https://github.com/prasanna-b007/voice-workflow-assistant/releases/latest)
   and run it.
2. Leave Sonix open on first launch while it downloads its two models in the background
   (progress shows in the Sonix window); after that it works offline:
   - the voice model (OpenAI's Whisper large-v3-turbo, about 574 MB). Until it finishes,
     Sonix falls back to Windows' speech recognizer, which needs **Online speech
     recognition** turned on in Windows Settings > Privacy & security > Speech.
   - the AI model (Qwen2.5 1.5B Instruct, about 1.1 GB). Sonix works fully without it
     meanwhile; see [Built-in AI](#built-in-ai).

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
- **CMake** — `winget install Kitware.CMake` (builds whisper.cpp, the speech engine)
- **LLVM** — `winget install LLVM.LLVM` (generates whisper.cpp's Rust bindings; the
  bindings shipped with the crate were made on Linux and don't compile on Windows)
- **Vulkan SDK** — `winget install KhronosGroup.VulkanSDK` (runs Whisper on the GPU)
- **WebView2 Runtime** — preinstalled on Windows 11

Run every build from **Developer PowerShell for VS** (Start menu), not a plain terminal.
LLVM can't find Visual Studio's C headers on its own when Visual Studio is installed
outside its default folder, and the developer shell points it at them. Open a new one
after installing the tools above so it sees the updated `PATH` and `VULKAN_SDK`.

Build output goes to `C:\sonix-build`, not `frontend/src-tauri/target`
(set in `frontend/src-tauri/.cargo/config.toml`). The Vulkan build creates deeply nested
files that must stay under Windows' 260-character path limit, which a build folder inside
the repository exceeds.

## Setup

```bash
cd frontend
npm install
```

No API key or account is needed to build or run Sonix. `npm run tauri dev` and
`npm run tauri build` first run `scripts/fetch-llama.mjs`, which downloads the llama.cpp
server for the built-in AI (pinned build, SHA-256 checked) into
`src-tauri/resources/llama/`; it does nothing once the files are there. Run it by hand
with `npm run fetch-llama` before a bare `cargo check` on a fresh clone.

## Built-in AI

Sonix works without AI: the built-in part always runs first. When it can't help, Sonix
hands the job to its own AI model, which runs on the user's PC like the voice model. No
key, account or server is involved, and the user never sets anything up:

| Feature | Built-in (always first) | Built-in AI (automatic) |
|---|---|---|
| Understanding commands | Command table, fuzzy app names, dates via chrono-node | Sentences no rule matches, answered as strict JSON |
| Spoken replies | Fixed sentences | Not used |
| Screen report | Windows OCR + a report of headings, numbers and full text | Adds an "AI Insights" section |
| Answers to searches | Wikipedia summary for "who/what is" questions | Not used: an offline model would guess at facts that change |

How it runs (`src-tauri/src/ai.rs`):

- **Model:** [Qwen2.5 1.5B Instruct](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF)
  (Q4_K_M, 1.1 GB, Apache-2.0), downloaded on first launch to
  `%LOCALAPPDATA%\com.voice.sonix\models\`, resumed if interrupted and checked against its
  SHA-256 (`src-tauri/src/download.rs`, shared with Whisper).
- **Engine:** llama.cpp's `llama-server` (build b11606), shipped in the installer
  (`resources/llama`, about 80 MB). It is a separate process rather than linked in, because
  whisper.cpp and llama.cpp both embed ggml and clash in one binary. It uses the GPU
  through Vulkan when there is one and the CPU otherwise; the package carries CPU code for
  every x64 processor generation.
- **When:** the engine starts when the user starts speaking (so the model is loaded by the
  time a command needs it), listens on 127.0.0.1 only, and stops after 5 idle minutes to
  give its memory back. A Windows job object ends it with Sonix, even after a crash.
- **Where:** PCs with at least 6 GB of memory. On smaller ones Sonix skips the download
  and uses its built-in features only.

If the model isn't downloaded yet, is still loading, is too slow (timeouts of 12 to 60 s)
or fails, Sonix carries on with the built-in result, so AI never breaks a command. On a
laptop CPU expect a few seconds per command and up to a minute for screen insights; with
a GPU it is much faster.

Nothing is hosted by this project: the app talks only to Hugging Face (the one-time model
downloads) and Wikipedia.

## Running

```bash
npm run tauri dev     # dev build with hot reload
npm run tauri build   # packaged installer -> C:\sonix-build\release\bundle\
```

Whisper runs on the GPU through Vulkan (NVIDIA, AMD and Intel graphics, integrated ones
included). Measured on a Ryzen 7 250 with Radeon 780M graphics: about 2 s per command on
the GPU, against several minutes on the CPU, so there is no CPU mode. On a PC with no
Vulkan-capable GPU, Sonix skips the model download and keeps using Windows speech
recognition. `vulkan-1.dll` is delay-loaded (`src-tauri/build.rs`) and the GPU is tested
in a separate copy of the process started with `--probe-gpu` (`whisper.rs`), so a missing
or broken Vulkan driver can't stop Sonix from starting.

The first build compiles whisper.cpp from source and takes several minutes; later builds
reuse it. Both models download to `%LOCALAPPDATA%\com.voice.sonix\models\` on first run;
delete that folder to force a fresh download.

To publish a release, upload `C:\sonix-build\release\bundle\nsis\Sonix_<version>_x64-setup.exe`
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

1. **Wake** — `src-tauri/src/speech.rs` listens continuously for "hey Sonix" (an offline
   phrase list in Windows' speech recognizer, driven by `src/voice/wakeWordListener.js`);
   alternatively the `Ctrl+Shift+Space` global shortcut,
   registered in `src-tauri/src/main.rs`.
2. **Listen** — a transparent, always-on-top overlay window appears and the microphone is
   recorded until the user stops talking, judged by the earshot voice-activity detector
   (`src-tauri/src/mic.rs`). Whisper large-v3-turbo then transcribes it on the PC
   (`src-tauri/src/whisper.rs`), primed with the names of the apps and commands Sonix
   knows. While the model is still downloading, Windows' speech recognizer is used instead.
   Both are driven from `src-tauri/src/speech.rs` and `src/voice/speechRecognition.js`.
   The browser Web Speech API is not used: inside WebView2 it fails immediately with a
   "network" error.
3. **Parse** — `src/ai/aiParser.js` walks a command table (instant, offline): app names
   are fuzzy-matched against `src/workflows/apps.js`, and dates and times are read with
   chrono-node. Only a sentence no rule matches goes to the built-in AI model
   (`src/ai/aiClient.js` → the Rust `ai_generate` command); if it can't help either,
   questions become a Google search and anything else gets "Sorry, I didn't catch that."
   Rules that change something on the PC only match orders ("close Word", "turn off
   wifi"); questions that mention an app or setting ("how do I quit Word") are searched.
   Intents from the AI are checked before use: only known app names for close and switch,
   only allowed settings, and never shutdown or restart.
4. **Execute** — `src/workflows/workflowExecutor.js` and `src/workflows/assistantActions.js`
   dispatch the intent to Rust commands over Tauri's `invoke` bridge.
5. **Act** — `src-tauri/src/main.rs` and `src-tauri/src/system.rs` perform the OS work. Each
   command takes typed values (a key name, a volume level, a link with an allowed scheme),
   so nothing from the frontend or the AI becomes a script: key presses and the mouse
   wheel go through `SendInput`, radios and hotspot through WinRT, and the few
   PowerShell calls get their input as environment variables. Console programs run with
   no window, which would otherwise take the keyboard focus. "Close" matches the exact
   process name, asks the window to close so unsaved work can be saved, and refuses
   Windows' own processes.
6. **Reply** — text-to-speech confirmation, plus written reports to
   `Desktop/reports/screen_report_<date-time>.txt` (the real Desktop, even when OneDrive
   has moved it).

## Capabilities

**Voice control** — wake-word detection, speech-to-text, and text-to-speech replies.

**Application management** — open, switch to, and close apps (VS Code, Excel, Word, Discord,
Spotify, browsers and more); save files in the current or a named app; direct shortcuts to web
apps (YouTube, Gmail, WhatsApp, Google, GitHub, LinkedIn, …).

**System control** — volume and brightness (up, down, or an exact level); toggles for WiFi,
Bluetooth, mobile hotspot, airplane mode, night light, and battery saver; scroll, screenshot,
screen recording, shutdown, and restart.

**Information retrieval** — current time, current date, weather, arithmetic, Google
searches with a spoken Wikipedia summary for "who is / what is" questions.

**Screen analysis** — captures the screen, reads it with Windows' built-in OCR
(`src-tauri/src/ocr.rs`, offline), and writes a report of its headings, numbers and text
to Notepad and, on request, `Desktop/reports/`. When AI is available, the report automatically gains
an "AI Insights" section.

**Workflow and task management** — multi-step command sequences, task storage with dates and
times, and calendar/meeting creation.

**Email and communication** — compose emails with recipient, subject, and body; send messages
via WhatsApp, Discord, and Telegram.

**Conversation control** — continuous listening across multiple commands until you say
"stop listening", "bye" or "thanks", and sequential command queueing.

**Feedback** — a wake chime, spoken confirmation of actions, and live status in the overlay.

## Known limitations

- **Windows only.** The Rust backend leans on PowerShell and Win32/WinRT APIs throughout.
- **Speech is recognised in English.** Whisper can do Hindi too, but language detection on
  two-word commands guesses wrong too often, so it is fixed to English.
- **No live transcript with Whisper.** Text appears once the user stops talking (the orb
  follows the mic level meanwhile).
- **First run needs internet** to download the 574 MB model, which then sits in graphics
  memory (about 600 MB) while Sonix runs. Each command takes about 2 s to transcribe
  after you stop talking; shrinking Whisper's 30-second input window made it faster but
  garbled short commands, so it stays at full size.
- **Whisper needs a GPU.** Without one, Sonix uses Windows speech recognition, which needs
  Online speech recognition switched on.
- **Conversation mode stops after Sonix starts music or video**, and after any action
  that hides the overlay (typing, saving, changing a setting): the mic would otherwise
  hear the playback, or listen behind a hidden window. Say "Hey Sonix" again.
