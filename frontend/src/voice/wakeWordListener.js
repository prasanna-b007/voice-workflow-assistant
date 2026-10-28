import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

// "Hey Sonix" detection runs natively (src-tauri/src/speech.rs) against a fixed phrase
// list, which Windows recognises offline, so no transcript leaves the machine until
// the user actually wakes the assistant.

let onWakeCallback = null;
let subscribed = false;

export function initWakeWordListener(onWake) {
  onWakeCallback = onWake;
  // Subscribe once across remounts (StrictMode mounts twice in dev).
  if (subscribed) return;
  subscribed = true;
  getCurrentWindow().listen("wake-word", () => {
    console.log("Wake word triggered!");
    onWakeCallback?.();
  });
}

export function startWakeWordListener() {
  invoke("speech_start_wake").catch((err) => console.warn("Wake word listener unavailable:", err));
}

export function stopWakeWordListener() {
  invoke("speech_stop_wake").catch(() => {});
}
