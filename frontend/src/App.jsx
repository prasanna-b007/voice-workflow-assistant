import { useState, useEffect, useRef } from "react";
import { startRecognition, stopRecognition } from "./voice/speechRecognition";
import { initWakeWordListener, startWakeWordListener, stopWakeWordListener } from "./voice/wakeWordListener";
import { speakText } from "./voice/voiceUtils";
import { playWakeChime } from "./voice/audioEffects";
import { detectIntentWithGemini } from "./ai/aiParser";
import { detectContinue } from "./ai/aiContinue";
import { executeWorkflow } from "./workflows/workflowExecutor";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";

function App() {
  const [text, setText] = useState("");
  const [status, setStatus] = useState("idle"); // idle | listening | processing | executed
  const executionLocked = useRef(false);
  const [mode, setMode] = useState("workflow"); // workflow | dictation
  const modeRef = useRef("workflow");
  const textRef = useRef("");
  const statusRef = useRef("idle");

  useEffect(() => {
    statusRef.current = status;
  }, [status]);


  const startListeningAuto = (isDictation = false) => {
    // Pause wake word listener while the assistant is active to avoid resource conflicts
    stopWakeWordListener();
    
    setText("");
    setStatus("listening");
    executionLocked.current = false;
    
    startRecognition(handleResult, handleError, isDictation);
  };

  const handleResult = async (transcript, isFinal, isSilentEnd = false) => {
    if (transcript) {
      setText(transcript);
      textRef.current = transcript;
    }

    if (isFinal && !isSilentEnd && !executionLocked.current) {
      if (!transcript.trim()) return;

      executionLocked.current = true;
      setStatus("processing");

      try {
        if (modeRef.current === "dictation") {
          console.log("Dictation mode: Typing transcript directly...");
          await executeWorkflow({ action: "type_text", data: { text: transcript, app: "" } });
        } else {
          const intent = await detectIntentWithGemini(transcript);
          const hasAction = (intent?.action && intent.action !== "unknown") || intent?.reply;

          if (!hasAction) {
            console.warn("No intent detected or unknown action.");
            escapeOverlay();
            return;
          }

          console.log("Intent:", intent);

          let shouldContinue = false;
          if (intent.continue === true) {
            shouldContinue = true;
          } else if (intent.continue === false) {
            shouldContinue = false;
          } else {
            const c = await detectContinue(transcript);
            shouldContinue = c.continue !== false;
          }

          await executeWorkflow(intent);

          // Respect continuous mode from AI + aiContinue fallback (Conversation Mode)
          if (shouldContinue) {
            setStatus("listening");
            setTimeout(() => {
              executionLocked.current = false;
              startListeningAuto(false);
            }, 1500); 
            return;
          }

          setStatus("executed");
          setTimeout(() => {
            escapeOverlay();
          }, 3000); 
        }
      } catch (error) {
        console.error("Workflow execution failed:", error);
        escapeOverlay();
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
      setTimeout(() => escapeOverlay(), 1500);
    }
  };

  const escapeOverlay = async () => {
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
    let unlistenShortcut = null;
    getCurrentWindow().listen("trigger-assistant", (event) => {
      const newMode = event.payload || "workflow";
      setMode(newMode);
      modeRef.current = newMode;
      
      // startListeningAuto will handle initial setup
      startListeningAuto(newMode === "dictation");
    }).then(u => { unlistenShortcut = u; });

    // Initialize Wake Word Listener
    initWakeWordListener((detectedMode = "workflow") => {
      // On wake word heard
      if (statusRef.current === "idle") {
         playWakeChime(); // Play the premium ping sound
         
         setMode(detectedMode);
         modeRef.current = detectedMode;
         
         const isDictation = detectedMode === "dictation";
         startListeningAuto(isDictation);
         
         // Response varies by mode for a premium feel
         if (isDictation) {
           speakText("Ready to type.");
         } else {
           speakText("I'm here.");
         }
         
         getCurrentWindow().show().catch(() => {});
         getCurrentWindow().setFocus().catch(() => {});
      }
    });
    startWakeWordListener();

    const handleKeyDown = async (e) => {
      if (e.key === "Escape") {
        await escapeOverlay();
      } else if (e.key === "Enter" && modeRef.current === "dictation") {
        if (textRef.current) {
          handleResult(textRef.current, true);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    // Warm up the speech engine
    if (window.speechSynthesis) {
      const warmup = new SpeechSynthesisUtterance("");
      window.speechSynthesis.speak(warmup);
    }

    return () => {
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

      <div className={`interaction-zone ${mode}`}>
        <div className="mode-label">{mode.toUpperCase()} MODE</div>
        <div className="live-transcript">
          {text}
        </div>

        <div className={`mic-orb ${status}`}>
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