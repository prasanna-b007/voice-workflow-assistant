import { playWakeChime } from "../voice/audioEffects";
import { speakText } from "../voice/voiceUtils";

// Timers, alarms and "remind me in 20 minutes". They live in the assistant
// window, which stays loaded while hidden, so they last until Sonix is closed.

const timers = new Map();
let nextId = 1;

/** 600 → "10 minutes", 5400 → "1 hour 30 minutes". */
export function describeDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  const part = (n, unit) => (n ? `${n} ${unit}${n === 1 ? "" : "s"}` : "");
  return [part(h, "hour"), part(m, "minute"), part(s, "second")].filter(Boolean).join(" ") || "0 seconds";
}

/**
 * Starts a timer that chimes and speaks when it ends.
 * @param {number} seconds
 * @param {string} [label] Spoken when it ends: "Time's up: call mom."
 */
export function startTimer(seconds, label = "") {
  const id = nextId++;
  const handle = setTimeout(() => {
    timers.delete(id);
    playWakeChime();
    setTimeout(playWakeChime, 700);
    setTimeout(() => speakText(label ? `Reminder: ${label}.` : "Time's up! Your timer is done."), 1400);
  }, seconds * 1000);
  timers.set(id, handle);
}

/** @returns {number} How many timers were cancelled. */
export function cancelTimers() {
  const count = timers.size;
  for (const handle of timers.values()) clearTimeout(handle);
  timers.clear();
  return count;
}
