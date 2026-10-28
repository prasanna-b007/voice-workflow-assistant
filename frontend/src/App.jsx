import { useState, useEffect, useRef } from "react";
import { startRecognition, stopRecognition } from "./voice/speechRecognition";
import { initWakeWordListener, startWakeWordListener, stopWakeWordListener } from "./voice/wakeWordListener";
import { speakText } from "./voice/voiceUtils";
import { playWakeChime } from "./voice/audioEffects";
import { parseCommand } from "./ai/aiParser";
import { executeWorkflow } from "./workflows/workflowExecutor";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";

// Actions that start music or video. Conversation mode stops after them: the mic would
// hear the playback and Whisper would turn lyrics into commands.
const PLAYS_AUDIO = new Set(["youtube_play", "spotify_play", "media_control"]);

function App() {
  const [text, setText] = useState("");
  const [status, setStatus] = useState("idle"); // idle | listening | processing | executed
  const executionLocked = useRef(false);
  const statusRef = useRef("idle");
  const orbRef = useRef(null);
  // Bumped whenever a conversation starts or ends. Work that awaited something checks
  // it hasn't changed before carrying on, so Esc or a new hotkey press really stops the
  // old conversation instead of letting it reopen the mic later.
  const sessionRef = useRef(0);
  const timersRef = useRef([]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // setTimeout that escapeOverlay cancels.
  const later = (fn, ms) => {
    timersRef.current.push(setTimeout(fn, ms));
  };
  const clearTimers = () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  };

  // A new conversation (hotkey or wake word), replacing any still running.
  const startSession = () => {
    sessionRef.current++;
    clearTimers();
    stopRecognition();
    startListeningAuto();
  };

  const startListeningAuto = () => {
    // Pause wake word listener while the assistant is active to avoid resource conflicts
    stopWakeWordListener();

    setText("");
    setStatus("listening");
    setMicLevel(0);
    executionLocked.current = false;

    const session = sessionRef.current;
    startRecognition(
      (transcript, isFinal, isSilentEnd) => handleResult(transcript, isFinal, isSilentEnd, session),
      handleError,
      {
        onLevel: setMicLevel,
        onTranscribing: handleTranscribing,
        // Back to listening after hearing only Sonix's own reply.
        onListening: () => setStatus("listening"),
      },
    );
  };

  // Whisper reports the mic level ~15 times a second; set it on the orb directly
  // rather than re-rendering.
  const setMicLevel = (level) => {
    orbRef.current?.style.setProperty("--level", level);
  };

  // Whisper shows no words while the user speaks; once they stop, show that it's working.
  const handleTranscribing = () => {
    setMicLevel(0);
    if (!executionLocked.current) setStatus("processing");
  };

  const handleResult = async (transcript, isFinal, isSilentEnd, session) => {
    // Still the conversation this result belongs to (no Esc, no new one since)?
    const current = () => session === sessionRef.current;
    if (!current()) return;
    if (transcript) {
      setText(transcript);
    }

    if (isFinal && !isSilentEnd && !executionLocked.current) {
      if (!transcript.trim()) return;

      executionLocked.current = true;
      setStatus("processing");

      try {
        const intent = await parseCommand(transcript);
        if (!current()) return;
        const hasAction = (intent?.action && intent.action !== "unknown") || intent?.reply;

        if (!hasAction) {
          console.warn("No intent detected or unknown action.");
          speakText("Sorry, I didn't catch that.");
          escapeOverlay();
          return;
        }

        console.log("Intent:", intent);

        // Keep listening for the next command unless the parser says this one ends
        // the conversation ("stop listening", "bye", "thanks") or it starts playback.
        let shouldContinue = intent.continue !== false && !PLAYS_AUDIO.has(intent.action);

        await executeWorkflow(intent);
        if (!current()) return;

        // Actions that type, save or change a setting hide the overlay to reach the
        // user's app. Don't keep listening behind a hidden window, where Esc can't reach.
        if (shouldContinue) {
          shouldContinue = await getCurrentWindow().isVisible().catch(() => false);
          if (!current()) return;
          if (!shouldContinue) {
            escapeOverlay();
            return;
          }
        }

        // Conversation mode: listen for the next command.
        if (shouldContinue) {
          setStatus("listening");
          later(() => {
            if (!current()) return;
            executionLocked.current = false;
            startListeningAuto();
          }, 1500);
          return;
        }

        setStatus("executed");
        later(() => {
          escapeOverlay();
        }, 3000);
      } catch (error) {
        console.error("Workflow execution failed:", error);
        if (current()) escapeOverlay();
      }
    } else if (isFinal && isSilentEnd && !executionLocked.current) {
      escapeOverlay();
    }
  };

  const handleError = (errorMsg, errorCode, isFatal) => {
    if (isFatal && !executionLocked.current) {
      executionLocked.current = true;
      setText(errorMsg);
      setStatus("executed");
      // The privacy message tells the user which setting to change; give them time to read it.
      later(() => escapeOverlay(), errorCode === "privacy" ? 7000 : 1500);
    }
  };

  const escapeOverlay = async () => {
    // Ends the conversation: anything still awaiting sees the new session and stops.
    sessionRef.current++;
    clearTimers();
    stopRecognition();
    setStatus("idle");
    setText("");
    executionLocked.current = false;
    
    // Resume listening for the wake word
    startWakeWordListener();
    
    try {
      await getCurrentWindow().hide();
    } catch { /* window may already be hidden */ }
  };

  // Mounted last so the handlers it closes over are already initialised.
  useEffect(() => {
    // Listen for custom trigger event from Rust
    // listen() resolves asynchronously, so cleanup can run before we hold the
    // unlisten handle (StrictMode does exactly that in dev). Without the flag a
    // second listener survives, every key press starts recognition twice, and
    // the second start aborts the first, which closes the overlay.
    let unlistenShortcut = null;
    let disposed = false;
    getCurrentWindow().listen("trigger-assistant", () => {
      // Pressed again mid-command: start over rather than run two conversations.
      startSession();
    }).then(u => {
      if (disposed) u();
      else unlistenShortcut = u;
    });

    // Initialize Wake Word Listener
    initWakeWordListener(() => {
      // On wake word heard
      if (statusRef.current === "idle") {
         playWakeChime(); // Play the premium ping sound
         startSession();
         speakText("I'm here.");

         getCurrentWindow().show().catch(() => {});
         getCurrentWindow().setFocus().catch(() => {});
      }
    });
    startWakeWordListener();

    const handleKeyDown = async (e) => {
      if (e.key === "Escape") {
        await escapeOverlay();
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    // Warm up the speech engine
    if (window.speechSynthesis) {
      const warmup = new SpeechSynthesisUtterance("");
      window.speechSynthesis.speak(warmup);
    }

    return () => {
      disposed = true;
      window.removeEventListener("keydown", handleKeyDown);
      stopWakeWordListener();
      if (unlistenShortcut) unlistenShortcut();
    };
    // Mount-once on purpose: re-running this would re-register the global
    // shortcut listener and restart the wake-word recogniser on every render,
    // which fights the microphone. The handlers read live state through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`overlay-container ${status}`}>
      <div className="edge-glow">
        <span className="eg-top"></span>
        <span className="eg-right"></span>
        <span className="eg-bottom"></span>
        <span className="eg-left"></span>
      </div>
      <div className="radial-blur"></div>

      <div className="interaction-zone">
        <div className="live-transcript">
          {text}
        </div>

        <div ref={orbRef} className={`mic-orb ${status}`}>
          <div className="waveform-ripple"></div>
          <div className="orb-core"></div>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="28" height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mic-icon"
          >
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" x2="12" y1="19" y2="22" />
          </svg>
        </div>
      </div>
    </div>
  );
}

export default App;