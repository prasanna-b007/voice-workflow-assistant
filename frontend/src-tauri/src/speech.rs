//! Speech recognition.
//!
//! Commands are transcribed on this PC by Whisper (whisper.rs, with microphone
//! capture in mic.rs). Until its model has downloaded and loaded, they fall
//! back to Windows' built-in recognizer (Windows.Media.SpeechRecognition), which needs
//! Settings > Privacy & security > Speech > "Online speech recognition". The "hey Sonix"
//! wake word always uses Windows' recognizer with a fixed phrase list, which it
//! recognises offline.
//!
//! The browser Web Speech API can't be used: inside WebView2 it fails straight away
//! with a "network" error. The overlay drives recognition through the commands below
//! and gets results back as events on the "assistant" window:
//!
//! - `wake-word`           — "hey Sonix" was heard
//! - `speech-partial`      text — live hypothesis while the user is speaking (Windows only)
//! - `speech-level`        0..1 — microphone level while listening (Whisper only)
//! - `speech-transcribing` — the user stopped talking; Whisper is working (Whisper only)
//! - `speech-final`        text — the recognised command; "" when nothing was said
//! - `speech-error`        { code, message } — recognition could not run

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use windows::core::{Ref, HSTRING};
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Media::SpeechRecognition::{
    SpeechContinuousRecognitionCompletedEventArgs, SpeechContinuousRecognitionResultGeneratedEventArgs,
    SpeechContinuousRecognitionSession, SpeechRecognitionCompilationResult, SpeechRecognitionConfidence,
    SpeechRecognitionHypothesisGeneratedEventArgs, SpeechRecognitionListConstraint, SpeechRecognitionResult,
    SpeechRecognitionResultStatus, SpeechRecognizer,
};
use windows_collections::IIterable;
use windows_future::{AsyncActionCompletedHandler, AsyncOperationCompletedHandler, AsyncStatus, IAsyncAction, IAsyncOperation};

use crate::mic;
use crate::whisper::Whisper;

const OVERLAY: &str = "assistant";

/// SPERR_PRIVACY_POLICY_NOT_ACCEPTED: "Online speech recognition" is switched off.
const PRIVACY_NOT_ACCEPTED: i32 = 0x8004_5509_u32 as i32;
/// COR_E_INVALIDOPERATION: "a method was called at an unexpected time".
const WRONG_STATE: i32 = 0x8013_1509_u32 as i32;

const WAKE_PHRASES: &[&str] = &[
    "hey sonix",
    "hi sonix",
    "okay sonix",
    "ok sonix",
];

#[derive(Default)]
pub struct SpeechState {
    inner: Mutex<Inner>,
    /// Whether the wake-word session should be running. Read by the session's
    /// Completed handler to decide whether to restart it.
    wake_wanted: AtomicBool,
}

#[derive(Default)]
struct Inner {
    wake: Option<SpeechRecognizer>,
    command: Option<SpeechRecognizer>,
    /// The in-flight command recognition, kept so it can be cancelled.
    pending: Option<Pending>,
}

enum Pending {
    Windows(IAsyncOperation<SpeechRecognitionResult>),
    Whisper(Arc<mic::Control>),
}

#[derive(Clone, Serialize)]
struct SpeechError {
    code: &'static str,
    message: String,
}

fn ms(ms: i64) -> TimeSpan {
    TimeSpan { Duration: ms * 10_000 }
}

fn describe(e: &windows::core::Error) -> SpeechError {
    if e.code().0 == PRIVACY_NOT_ACCEPTED {
        // Only the Windows fallback needs this setting, so the voice model isn't ready yet.
        SpeechError {
            code: "privacy",
            message: "Sonix's voice model is still getting ready (see the Sonix window). Until then, turn on \
                Online speech recognition in Windows Settings > Privacy & security > Speech."
                .into(),
        }
    } else {
        SpeechError { code: "failed", message: format!("Speech recognition failed: {} (0x{:08X})", e.message(), e.code().0) }
    }
}

fn compile(recognizer: &SpeechRecognizer) -> windows::core::Result<()> {
    let result: SpeechRecognitionCompilationResult = recognizer.CompileConstraintsAsync()?.get()?;
    let status = result.Status()?;
    if status != SpeechRecognitionResultStatus::Success {
        return Err(windows::core::Error::new(
            windows::core::HRESULT(0x8000_4005_u32 as i32),
            format!("grammar compilation failed (status {})", status.0),
        ));
    }
    Ok(())
}

fn wake_recognizer(app: &AppHandle) -> windows::core::Result<SpeechRecognizer> {
    let recognizer = SpeechRecognizer::new()?;
    let phrases: Vec<HSTRING> = WAKE_PHRASES.iter().map(|p| HSTRING::from(*p)).collect();
    let constraint = SpeechRecognitionListConstraint::Create(&IIterable::<HSTRING>::from(phrases))?;
    recognizer.Constraints()?.Append(&constraint)?;
    compile(&recognizer)?;

    let session = recognizer.ContinuousRecognitionSession()?;
    // Default is 20 s, after which the session ends on its own.
    session.SetAutoStopSilenceTimeout(ms(24 * 60 * 60 * 1000))?;

    let handle = app.clone();
    session.ResultGenerated(&TypedEventHandler::new(
        move |_: Ref<SpeechContinuousRecognitionSession>, args: Ref<SpeechContinuousRecognitionResultGeneratedEventArgs>| {
            let result = args.ok()?.Result()?;
            // A phrase list always yields its closest phrase; only trust confident matches.
            let confidence = result.Confidence()?;
            if result.Status()? != SpeechRecognitionResultStatus::Success
                || confidence == SpeechRecognitionConfidence::Low
                || confidence == SpeechRecognitionConfidence::Rejected
            {
                return Ok(());
            }
            let _ = handle.emit_to(OVERLAY, "wake-word", ());
            Ok(())
        },
    ))?;

    let handle = app.clone();
    session.Completed(&TypedEventHandler::new(
        move |_: Ref<SpeechContinuousRecognitionSession>, _: Ref<SpeechContinuousRecognitionCompletedEventArgs>| {
            // Ended without us asking (audio glitch, device change): restart it. Done on a
            // separate thread because this handler must not block on the state lock.
            let handle = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(2));
                let state = handle.state::<SpeechState>();
                if state.wake_wanted.load(Ordering::SeqCst) {
                    if let Err(e) = start_wake(&handle, &state) {
                        log::warn!("speech: wake-word restart failed: {}", e);
                    }
                }
            });
            Ok(())
        },
    ))?;

    Ok(recognizer)
}

fn command_recognizer(app: &AppHandle) -> windows::core::Result<SpeechRecognizer> {
    // No constraints = Windows' free-form dictation grammar.
    let recognizer = SpeechRecognizer::new()?;
    compile(&recognizer)?;

    let handle = app.clone();
    recognizer.HypothesisGenerated(&TypedEventHandler::new(
        move |_: Ref<SpeechRecognizer>, args: Ref<SpeechRecognitionHypothesisGeneratedEventArgs>| {
            let text = args.ok()?.Hypothesis()?.Text()?.to_string_lossy();
            let _ = handle.emit_to(OVERLAY, "speech-partial", text);
            Ok(())
        },
    ))?;

    Ok(recognizer)
}

// The recognizer's State() reports Idle even while a continuous session is running,
// so it can't tell us whether to start or stop. Instead we always call Start/Stop and
// treat "called at an unexpected time" as "already running" / "already stopped".
fn is_wrong_state(e: &windows::core::Error) -> bool {
    e.code().0 == WRONG_STATE
}

/// Wait for a session Start/Stop, but never forever: these run while holding the state
/// lock, so one call that never completes would freeze every other speech command.
fn wait(op: IAsyncAction, what: &str) -> windows::core::Result<()> {
    let (tx, rx) = std::sync::mpsc::channel();
    op.SetCompleted(&AsyncActionCompletedHandler::new(move |_: Ref<IAsyncAction>, _: AsyncStatus| {
        let _ = tx.send(());
        Ok(())
    }))?;
    if rx.recv_timeout(Duration::from_secs(5)).is_err() {
        log::warn!("speech: {} did not finish within 5 s, cancelling", what);
        let _ = op.Cancel();
        return Err(windows::core::Error::new(
            windows::core::HRESULT(0x8000_4005_u32 as i32),
            format!("{} timed out", what),
        ));
    }
    op.GetResults()
}

fn stop_wake(inner: &Inner) {
    if let Some(recognizer) = &inner.wake {
        // CancelAsync, not StopAsync: StopAsync waits to finish processing audio and in
        // practice never completes on an idle session, which froze the next command.
        let stopped = recognizer
            .ContinuousRecognitionSession()
            .and_then(|s| s.CancelAsync())
            .and_then(|op| wait(op, "stopping wake-word session"));
        match stopped {
            Ok(()) => log::info!("speech: wake-word session stopped"),
            Err(e) if is_wrong_state(&e) => log::info!("speech: wake-word session was not running"),
            Err(e) => log::warn!("speech: stopping wake-word session failed: {:?}", e),
        }
    }
}

fn cancel_pending(inner: &mut Inner) {
    match inner.pending.take() {
        Some(Pending::Windows(op)) => {
            let _ = op.Cancel();
        }
        Some(Pending::Whisper(control)) => control.cancel(),
        None => {}
    }
}

fn start_wake(app: &AppHandle, state: &SpeechState) -> Result<(), String> {
    state.wake_wanted.store(true, Ordering::SeqCst);
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    log::info!("speech: starting wake-word session");
    cancel_pending(&mut inner);

    if inner.wake.is_none() {
        inner.wake = Some(wake_recognizer(app).map_err(|e| describe(&e).message)?);
    }
    let started = inner
        .wake
        .as_ref()
        .unwrap()
        .ContinuousRecognitionSession()
        .and_then(|s| s.StartAsync())
        .and_then(|op| wait(op, "starting wake-word session"));
    match started {
        Ok(()) => log::info!("speech: wake-word session running"),
        Err(e) if is_wrong_state(&e) => log::info!("speech: wake-word session already running"),
        Err(e) => return Err(describe(&e).message),
    }
    Ok(())
}

/// Start listening for "hey Sonix" in the background.
#[tauri::command]
pub async fn speech_start_wake(app: AppHandle, state: State<'_, SpeechState>) -> Result<(), String> {
    start_wake(&app, &state).inspect_err(|e| log::warn!("speech: wake-word session failed: {}", e))
}

/// Stop listening for the wake word.
#[tauri::command]
pub async fn speech_stop_wake(state: State<'_, SpeechState>) -> Result<(), String> {
    log::info!("speech: stop-wake requested");
    state.wake_wanted.store(false, Ordering::SeqCst);
    let inner = state.inner.lock().map_err(|e| e.to_string())?;
    stop_wake(&inner);
    Ok(())
}

/// Listen for one command. The outcome arrives as a `speech-final` or `speech-error`
/// event; this returns as soon as listening starts.
#[tauri::command]
pub async fn speech_listen(app: AppHandle, state: State<'_, SpeechState>) -> Result<(), String> {
    log::info!("speech: listen requested");
    // Load the AI model while the user speaks, in case the command needs it.
    crate::ai::warm_up(&app);
    state.wake_wanted.store(false, Ordering::SeqCst);
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    // Only one recognizer may hold the microphone at a time.
    stop_wake(&inner);
    cancel_pending(&mut inner);
    log::info!("speech: wake stopped, starting command recognition");

    if app.state::<Whisper>().ready() {
        let control = Arc::new(mic::Control::default());
        inner.pending = Some(Pending::Whisper(control.clone()));
        std::thread::spawn(move || listen_whisper(app, control));
        return Ok(());
    }
    log::info!("speech: voice model not ready, using Windows recognition");

    let started = (|| -> windows::core::Result<IAsyncOperation<SpeechRecognitionResult>> {
        if inner.command.is_none() {
            inner.command = Some(command_recognizer(&app)?);
        }
        let recognizer = inner.command.as_ref().unwrap();
        let timeouts = recognizer.Timeouts()?;
        timeouts.SetInitialSilenceTimeout(ms(6000))?;
        // Windows' default of 150 ms cuts people off mid-sentence.
        timeouts.SetEndSilenceTimeout(ms(800))?;

        let op = recognizer.RecognizeAsync()?;
        let handle = app.clone();
        op.SetCompleted(&AsyncOperationCompletedHandler::new(
            move |op: Ref<IAsyncOperation<SpeechRecognitionResult>>, status: AsyncStatus| {
                log::info!("speech: recognition completed with async status {}", status.0);
                if status == AsyncStatus::Canceled {
                    return Ok(()); // we stopped it on purpose
                }
                match op.ok()?.GetResults() {
                    Ok(result) => match { let s = result.Status()?; log::info!("speech: result status {}", s.0); s } {
                        SpeechRecognitionResultStatus::Success => {
                            let _ = handle.emit_to(OVERLAY, "speech-final", result.Text()?.to_string_lossy());
                        }
                        SpeechRecognitionResultStatus::MicrophoneUnavailable => {
                            let _ = handle.emit_to(
                                OVERLAY,
                                "speech-error",
                                SpeechError { code: "audio-capture", message: "No microphone found.".into() },
                            );
                        }
                        SpeechRecognitionResultStatus::NetworkFailure => {
                            let _ = handle.emit_to(
                                OVERLAY,
                                "speech-error",
                                SpeechError { code: "network", message: "Network error...".into() },
                            );
                        }
                        // Silence, babble, user cancel: nothing was said.
                        _ => {
                            let _ = handle.emit_to(OVERLAY, "speech-final", String::new());
                        }
                    },
                    Err(e) => {
                        log::warn!("speech: recognition error {:?}", e);
                        let _ = handle.emit_to(OVERLAY, "speech-error", describe(&e));
                    }
                }
                Ok(())
            },
        ))?;
        Ok(op)
    })();

    match started {
        Ok(op) => {
            log::info!("speech: listening");
            inner.pending = Some(Pending::Windows(op));
            Ok(())
        }
        Err(e) => {
            log::warn!("speech: could not start listening {:?}", e);
            let _ = app.emit_to(OVERLAY, "speech-error", describe(&e));
            Ok(())
        }
    }
}

/// Record and transcribe one command with Whisper, reporting through the same events as
/// the Windows path.
fn listen_whisper(app: AppHandle, control: Arc<mic::Control>) {
    let limits = mic::Limits {
        initial_silence_ms: 6000,
        end_silence_ms: 800,
        max_ms: 20_000,
    };
    let level_app = app.clone();
    let recorded = mic::record(&limits, &control, |level| {
        let _ = level_app.emit_to(OVERLAY, "speech-level", level);
    });
    // A cancelled listen reports nothing: the overlay has moved on.
    let emit = |event: &str, payload: serde_json::Value| {
        if !control.is_cancelled() {
            let _ = app.emit_to(OVERLAY, event, payload);
        }
    };
    match recorded {
        Ok(mic::Outcome::Speech(audio)) => {
            emit("speech-transcribing", serde_json::Value::Null);
            match app.state::<Whisper>().transcribe(&audio) {
                Ok(text) => {
                    log::info!("speech: whisper heard {:?}", text);
                    emit("speech-final", text.into());
                }
                Err(message) => {
                    log::warn!("speech: {}", message);
                    emit("speech-error", serde_json::json!(SpeechError { code: "failed", message }));
                }
            }
        }
        Ok(mic::Outcome::Silence) => emit("speech-final", "".into()),
        Ok(mic::Outcome::Cancelled) => {}
        Err(message) => {
            log::warn!("speech: {}", message);
            emit("speech-error", serde_json::json!(SpeechError { code: "audio-capture", message }));
        }
    }
}

/// Stop the in-flight command recognition, if any.
#[tauri::command]
pub async fn speech_cancel(state: State<'_, SpeechState>) -> Result<(), String> {
    log::info!("speech: cancel requested");
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    cancel_pending(&mut inner);
    Ok(())
}
