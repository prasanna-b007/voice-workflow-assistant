import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { stripOwnSpeech } from "./voiceUtils";

// Recognition runs natively (src-tauri/src/speech.rs): Whisper on this PC once its model
// has downloaded, Windows' speech recognizer until then. The browser Web Speech API
// can't be used: inside WebView2 it fails at once with a "network" error. Rust streams
// results back as window events.

// { onResult, onError, onLevel?, onTranscribing?, onListening? } for the listen in progress
let handlers = null;
let generation = 0;
let subscribed = null;

function subscribe() {
  if (subscribed) return subscribed;
  const win = getCurrentWindow();
  subscribed = Promise.all([
    // Windows only: live text while the user speaks.
    win.listen("speech-partial", (e) => handlers?.onResult(e.payload, false)),
    // Whisper only: mic level (0..1) while listening, then a signal once it starts transcribing.
    win.listen("speech-level", (e) => handlers?.onLevel?.(e.payload)),
    win.listen("speech-transcribing", () => handlers?.onTranscribing?.()),
    win.listen("speech-final", (e) => {
      const h = handlers;
      if (!h) return;
      const heard = e.payload || "";
      const text = stripOwnSpeech(heard);
      if (heard.trim() && !text.trim()) {
        // Only Sonix's own reply, picked up from the speakers: keep listening for the user.
        console.log("Ignored Sonix's own voice:", heard);
        h.onListening?.();
        invoke("speech_listen").catch(() => {
          if (handlers !== h) return;
          handlers = null;
          h.onError("Mic start failed.", "start-failed", true);
        });
        return;
      }
      handlers = null;
      // Same contract as before: (transcript, isFinal, isSilentEnd)
      if (text.trim()) h.onResult(text, true);
      else h.onResult("", true, true);
    }),
    win.listen("speech-error", (e) => {
      const h = handlers;
      handlers = null;
      if (!h) return;
      const { code = "unknown", message = "Speech recognition failed." } = e.payload || {};
      console.error("SpeechRecognition error:", code, message);
      h.onError(message, code, true);
    }),
  ]);
  return subscribed;
}

// Resolves once Sonix has stopped talking (text-to-speech), or after `maxMs`. Long on
// purpose: news briefings and "read this" can speak for minutes, and listening before
// they end would record them as the next command.
async function untilSonixIsQuiet(maxMs = 3 * 60 * 1000) {
  const synth = window.speechSynthesis;
  if (!synth) return;
  const deadline = Date.now() + maxMs;
  if (!synth.speaking && !synth.pending) return;
  while ((synth.speaking || synth.pending) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  // Let the last of it leave the speakers.
  await new Promise((r) => setTimeout(r, 200));
}

export async function startRecognition(onResult, onError, { onLevel, onTranscribing, onListening } = {}) {
  const mine = ++generation;
  handlers = { onResult, onError, onLevel, onTranscribing, onListening };
  try {
    await subscribe();
    // Don't record Sonix's own reply ("I'm here.", "Searching YouTube for…"): the
    // mic hears the speakers, and the reply would come back as the next command.
    await untilSonixIsQuiet();
    // stopRecognition() or a newer start ran while we were waiting.
    if (mine !== generation) return;
    await invoke("speech_listen");
  } catch (err) {
    if (mine !== generation) return;
    handlers = null;
    console.error("Failed to start recognition:", err);
    onError("Mic start failed.", "start-failed", true);
  }
}

export function stopRecognition() {
  generation++;
  handlers = null;
  invoke("speech_cancel").catch(() => {});
}
