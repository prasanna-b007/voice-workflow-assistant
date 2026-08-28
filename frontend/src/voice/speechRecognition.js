const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

let recognition = null;
let isListening = false;
let stoppedIntentionally = false;

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  // We use non-continuous so it completes when they stop talking natively,
  // but we absolutely need interimResults for real-time live transcript glow!
  recognition.continuous = false;
  recognition.lang = "en-US";
  recognition.interimResults = true;
}

const ERROR_MESSAGES = {
  "no-speech": "No speech detected...",
  "audio-capture": "No microphone found.",
  "not-allowed": "Microphone blocked.",
  "network": "Network error...",
  "aborted": "Cancelled by system...",
  "service-not-allowed": "Speech recognition blocked.",
};

export function startRecognition(onResult, onError, isDictation = false) {
  if (!recognition) {
    onError("Speech recognition not supported in this environment.", "unsupported", true);
    return;
  }

  recognition.continuous = !!isDictation;

  if (isListening) {
    try { recognition.abort(); } catch { /* ignore */ }
    isListening = false;
    setTimeout(() => startRecognition(onResult, onError, isDictation), 200);
    return;
  }

  recognition.onresult = (event) => {
    let transcript = "";
    let isFinal = false;

    // Loop through all results correctly securely
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        isFinal = true;
      }
    }
    
    // Pass both the live accumulating string and its state
    onResult(transcript, isFinal);

    // If it's final, tracking stops internally
    if (isFinal) {
      isListening = false;
    }
  };

  recognition.onerror = (event) => {
    isListening = false;
    const code = event.error || "unknown";
    if (code === "aborted" || code === "no-speech") { 
        // silently abort out to hide window automatically if no speech
        onResult("", true, true);
        return; 
    }
    const message = ERROR_MESSAGES[code] || `Mic error: ${code}`;
    console.error("SpeechRecognition error:", code, event);
    onError(message, code, true);
  };

  recognition.onend = () => {
    // Only signal a silent end if the mic ended ON ITS OWN (not from our stopRecognition call)
    if (isListening && !stoppedIntentionally) {
      isListening = false;
      onResult("", true, true);
    }
    isListening = false;
  };

  try {
    stoppedIntentionally = false; // Clear flag before each fresh start
    recognition.start();
    isListening = true;
  } catch (err) {
    isListening = false;
    console.error("Failed to start recognition:", err);
    onError("Mic start failed.", "start-failed", true);
  }
}

export function stopRecognition() {
  if (recognition && isListening) {
    stoppedIntentionally = true; // Signal that WE stopped it, not the user
    try { recognition.abort(); } catch { /* ignore */ }
    isListening = false;
  }
}

export { isListening };
export default recognition;