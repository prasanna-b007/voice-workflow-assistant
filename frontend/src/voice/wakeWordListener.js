import { detectWakeWord } from "../ai/aiWakeWord";

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

let recognition = null;
let isStarted = false;
let shouldBeRunning = false;
let onWakeCallback = null;
let lastAiWakeCheck = 0;

export function initWakeWordListener(onWake) {
  if (!SpeechRecognition) {
    console.warn("Speech recognition not supported for wake word.");
    return;
  }
  
  onWakeCallback = onWake;

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        const transcript = result[0].transcript.toLowerCase();
        
        console.log("Wake word candidate:", transcript);

        // Look for "hey sonix" variations
        const isDictation = transcript.includes("dictation") || transcript.includes("write") || transcript.includes("type");
        let isWake = transcript.includes("hey sonix") ||
                       transcript.includes("hi sonix") ||
                       transcript.includes("okay sonix") ||
                       transcript.includes("ok sonix");

        if (!isWake && transcript.includes("sonix")) {
          const now = Date.now();
          if (now - lastAiWakeCheck < 2000) return;
          lastAiWakeCheck = now;
          detectWakeWord(result[0].transcript.trim())
            .then(({ wake }) => {
              if (wake && onWakeCallback) {
                console.log("Wake word (AI) triggered! Mode:", isDictation ? "dictation" : "workflow");
                onWakeCallback(isDictation ? "dictation" : "workflow");
              }
            })
            .catch(() => {});
        }

        if (isWake) {
            console.log("Wake word triggered! Mode:", isDictation ? "dictation" : "workflow");
            if (onWakeCallback) onWakeCallback(isDictation ? "dictation" : "workflow");
        }
    }
  };

  recognition.onerror = (event) => {
    console.warn("Wake word recognition error:", event.error);
    if (event.error === "aborted" || event.error === "network") {
       // transient errors
    } else {
       isStarted = false;
    }
  };

  recognition.onend = () => {
    isStarted = false;
    console.log("Wake word listener onend called. shouldBeRunning:", shouldBeRunning);
    // Auto-restart if we should still be listening
    if (shouldBeRunning) {
      setTimeout(() => {
          if (shouldBeRunning) startWakeWordListener();
      }, 500);
    }
  };
}

export function startWakeWordListener() {
  if (!recognition) return;
  shouldBeRunning = true;
  if (!isStarted) {
    try {
      recognition.start();
      isStarted = true;
      console.log("Wake word listener starting...");
    } catch (e) {
      console.error("Failed to start wake word listener:", e);
      isStarted = false;
    }
  }
}

export function stopWakeWordListener() {
  shouldBeRunning = false;
  if (recognition && isStarted) {
    try {
      recognition.stop();
      isStarted = false;
      console.log("Wake word listener requested stop.");
    } catch {
      // ignore
    }
  }
}
