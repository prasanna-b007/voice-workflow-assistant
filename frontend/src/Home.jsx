import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./Home.css";

const mb = (bytes) => Math.round(bytes / 1e6);

const percent = (model) => Math.floor((model.downloaded / model.total) * 100);

// One line on the state of the local Whisper model (see src-tauri/src/whisper.rs).
function voiceModelText(model) {
  switch (model?.state) {
    case "downloading":
      return `Downloading the voice model: ${percent(model)}% (${mb(model.downloaded)} of ${mb(model.total)} MB). Until it finishes, Sonix uses Windows speech recognition.`;
    case "loading":
      return "Loading the voice model…";
    case "ready":
      return "Voice model ready: your speech is recognised on this PC.";
    case "error":
      return `Voice model unavailable: ${model.message} Sonix uses Windows speech recognition meanwhile.`;
    default:
      return "Preparing the voice model…";
  }
}

// One line on the state of the built-in AI model (see src-tauri/src/ai.rs).
function aiModelText(model) {
  switch (model?.state) {
    case "downloading":
      return `Downloading the AI model: ${percent(model)}% (${mb(model.downloaded)} of ${mb(model.total)} MB). Sonix already works; this adds help with unusual commands and screen insights.`;
    case "ready":
      return "AI model ready: it runs on this PC and helps when the built-in commands can't.";
    case "unsupported":
      return model.message;
    case "error":
      return `AI model unavailable: ${model.message} Sonix keeps working with its built-in commands.`;
    default:
      return "Preparing the AI model…";
  }
}

/**
 * Follows a model's status: asks once, then listens for `event` updates.
 * @param {string} event   The event the backend emits on changes.
 * @param {string} command The command returning the current status.
 */
function useModelStatus(event, command) {
  const [model, setModel] = useState(null);

  useEffect(() => {
    // listen() resolves asynchronously, so cleanup can run before we hold the unlisten
    // handle (StrictMode does exactly that in dev); the flag drops the late one.
    let unlisten = null;
    let disposed = false;
    let heardEvent = false;
    getCurrentWindow()
      .listen(event, (e) => {
        heardEvent = true;
        setModel(e.payload);
      })
      .then((u) => {
        if (disposed) return u();
        unlisten = u;
        // Ask only once subscribed, so no update is missed; an event that beat the
        // reply is newer, so it wins.
        invoke(command)
          .then((status) => !heardEvent && setModel(status))
          .catch(() => {});
      });
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [event, command]);

  return model;
}

function ModelStatus({ model, text, retryCommand }) {
  return (
    <div className={`home-status ${model?.state ?? "pending"}`}>
      <i />
      <div>
        <p>
          {text}
          {model?.state === "error" && (
            <button className="home-retry" onClick={() => invoke(retryCommand)}>
              Try again
            </button>
          )}
        </p>
        {model?.state === "downloading" && (
          <progress className="home-progress" value={model.downloaded} max={model.total} />
        )}
      </div>
    </div>
  );
}

// The "main" window. It deliberately runs none of the voice pipeline — that lives
// only in the assistant overlay (App.jsx), so the two windows never compete for
// the microphone.
function Home() {
  const voiceModel = useModelStatus("voice-model", "voice_model_status");
  const aiModel = useModelStatus("ai-model", "ai_model_status");

  return (
    <div className="home">
      <div className="home-inner">
        <header className="home-hero">
          <div className="home-logo">
            <img src="/sonix-logo.png" alt="Sonix" />
          </div>
          <div>
            <span className="home-badge"><i />Listening in the background</span>
            <h1>Sonix is <span className="home-gradient">running</span></h1>
            <p className="home-sub">You can minimise this window. Sonix keeps listening in the background.</p>
          </div>
        </header>

        <ul className="home-list">
          <li><span>Say</span><kbd>Hey Sonix</kbd></li>
          <li><span>Or press</span><kbd>Ctrl + Shift + Space</kbd></li>
          <li><span>Cancel</span><kbd>Esc</kbd></li>
        </ul>

        <ModelStatus model={voiceModel} text={voiceModelText(voiceModel)} retryCommand="voice_model_download" />
        <ModelStatus model={aiModel} text={aiModelText(aiModel)} retryCommand="ai_model_download" />
      </div>
    </div>
  );
}

export default Home;
