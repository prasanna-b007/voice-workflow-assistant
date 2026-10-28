import { open } from "@tauri-apps/plugin-shell";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { speakText, rememberSpoken } from "../voice/voiceUtils";
import { askAI } from "../ai/aiClient";
import { parseCommand } from "../ai/aiParser";
import { LANGUAGES } from "../ai/localCommands";
import { executeWorkflow } from "./workflowExecutor";
import { APP_PROCESS_MAP, matchAppName } from "./apps";
import { startTimer, cancelTimers, describeDuration } from "./timers";
import { findContact, saveContact, toWhatsAppNumber } from "../storage/contacts";
import { getRoutines, saveRoutine, deleteRoutine, findRoutine } from "../storage/routines";
import { recentSearch } from "./lastSearch";

/*
 * Handlers for the commands in ai/localCommands.js. executeWorkflow calls
 * runAssistantAction first; it returns false for actions it doesn't own.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openLink(url) {
  try { await openUrl(url); } catch { await open(url); }
}

/** Hides the overlay so the action lands on the window the user was using. */
async function hideOverlay() {
  try { await getCurrentWindow().hide(); } catch { /* already hidden */ }
  await sleep(200);
}

/** Opens a custom-scheme link (spotify:, whatsapp:) with the app Windows has for it. */
function startUri(uri) {
  return invoke("open_uri", { uri });
}

async function hasUrlHandler(scheme) {
  try { return await invoke("has_url_handler", { scheme }); } catch { return false; }
}

/** Resolves once Sonix has finished speaking, so routine steps don't talk over each other. */
async function waitForSpeech(maxMs = 30000) {
  const start = Date.now();
  await sleep(300);
  while (window.speechSynthesis?.speaking && Date.now() - start < maxMs) await sleep(250);
}

/** Country code for Google News: India by time zone (browsers often report en-US there), else the browser locale. */
function newsRegion() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (/^Asia\/(?:Kolkata|Calcutta)$/.test(zone)) return "IN";
  return (navigator.language || "").split("-")[1] || "US";
}

// media_control states → the press_keys names in src-tauri/src/system.rs.
const MEDIA_KEYS = { play_pause: "play_pause", next: "next_track", previous: "previous_track" };

// window_control states the backend's window_action accepts.
const WINDOW_ACTIONS = ["minimize_all", "lock", "empty_recycle_bin"];

/** Speaks in another language with a matching Windows voice; false when none is installed. */
function speakInLanguage(text, lang) {
  const voice = window.speechSynthesis?.getVoices().find((v) => v.lang.toLowerCase().startsWith(lang.toLowerCase().slice(0, 2)));
  if (!voice) return false;
  rememberSpoken(text);
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  window.speechSynthesis.speak(utterance);
  return true;
}

const HANDLERS = {
  /** "open the first result" (state: 1-based position or "last") or "open the Wikipedia one" (query: site). */
  async open_result({ state, query }) {
    const search = recentSearch();
    if (!search) {
      speakText("Search for something first, then I can open a result.");
      return;
    }
    let results = [];
    try { results = await invoke("search_results", { query: search }); } catch (e) { console.warn("[results] lookup failed:", e); }

    const site = (query || "").toLowerCase().replace(/\s+/g, "");
    const pick = site
      ? results.find((r) => r.url.toLowerCase().includes(site) || r.title.toLowerCase().replace(/\s+/g, "").includes(site))
      : results[state === "last" ? results.length - 1 : (Number(state) || 1) - 1];

    if (!pick) {
      // "open the settings page" right after a search meant the app, not a result.
      if (site && matchAppName(query)) {
        await executeWorkflow({ action: "open_app", app: matchAppName(query) });
        return;
      }
      speakText(site ? `I couldn't find a ${query} result.` : "I couldn't find that result.");
      return;
    }
    speakText(`Opening ${pick.title.split(/ [-|–—] /)[0]}.`);
    await openLink(pick.url);
  },

  async media_control({ state }) {
    const key = MEDIA_KEYS[state] || MEDIA_KEYS.play_pause;
    await invoke("press_keys", { keys: key });
  },

  async set_timer({ seconds, task, alarm }) {
    startTimer(seconds, task);
    if (alarm) {
      const at = new Date(Date.now() + seconds * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      speakText(`Alarm set for ${at}.`);
    } else {
      speakText(task ? `Okay, I'll remind you in ${describeDuration(seconds)} to ${task}.` : `Timer set for ${describeDuration(seconds)}.`);
    }
  },

  async cancel_timers() {
    const count = cancelTimers();
    speakText(count ? `Cancelled ${count === 1 ? "your timer" : `${count} timers`}.` : "You don't have any timers running.");
  },

  async directions({ query }) {
    speakText(`Getting directions to ${query}.`);
    await openLink(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(query)}`);
  },

  async maps_search({ query }) {
    speakText(`Finding ${query}.`);
    await openLink(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`);
  },

  async window_control({ state }) {
    if (!WINDOW_ACTIONS.includes(state)) return;
    if (state === "empty_recycle_bin") speakText("Emptying the recycle bin. Please confirm.");
    if (state === "minimize_all") speakText("Showing the desktop.");
    await hideOverlay();
    await invoke("window_action", { action: state });
  },

  async switch_app(command) {
    const app = (command.app || "").toLowerCase();
    const processName = APP_PROCESS_MAP[app];
    // Web apps and settings pages have no window of their own to switch to.
    if (!processName || !/^[a-z0-9._-]+$/i.test(processName)) {
      await executeWorkflow({ ...command, action: "open_app" });
      return;
    }
    speakText(`Switching to ${app}.`);
    await hideOverlay();
    await invoke("switch_to_app", { processName });
  },

  async youtube_play({ query }) {
    speakText(`Playing ${query} on YouTube.`);
    let videoId = null;
    try { videoId = await invoke("youtube_first_video", { query }); } catch (e) { console.warn("[youtube] lookup failed:", e); }
    await openLink(
      videoId
        ? `https://www.youtube.com/watch?v=${videoId}`
        : `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
    );
  },

  async spotify_play({ query }) {
    speakText(`Searching Spotify for ${query}.`);
    if (await hasUrlHandler("spotify")) {
      await startUri(`spotify:search:${encodeURIComponent(query)}`);
    } else {
      await openLink(`https://open.spotify.com/search/${encodeURIComponent(query)}`);
    }
  },

  async save_contact({ to, phone, email }) {
    saveContact({ name: to, phone, email });
    speakText(`Saved ${to}'s ${phone ? "number" : "email"}.`);
  },

  async whatsapp_message({ to, message }) {
    const contact = findContact(to);
    if (!contact?.phone) {
      speakText(`I don't have a number for ${to}. Say: save ${to}'s number as, followed by the number.`);
      return;
    }
    const phone = toWhatsAppNumber(contact.phone);
    const text = encodeURIComponent(message);
    speakText(`Opening WhatsApp with your message to ${contact.name}. Press send when it looks right.`);
    if (await hasUrlHandler("whatsapp")) {
      await startUri(`whatsapp://send?phone=${phone}&text=${text}`);
    } else {
      await openLink(`https://wa.me/${phone}?text=${text}`);
    }
  },

  async create_routine({ task: name, steps }) {
    if (!steps?.length) {
      speakText("Tell me what the routine should do, like: create a routine called study mode that opens Notion and Spotify.");
      return;
    }
    saveRoutine(name, steps);
    speakText(`Routine ${name} saved. It will ${steps.join(", then ")}.`);
  },

  async delete_routine({ task: name }) {
    speakText(deleteRoutine(name) ? `Deleted the ${name} routine.` : `I couldn't find a routine called ${name}.`);
  },

  async list_routines() {
    const names = getRoutines().map((r) => r.name);
    speakText(names.length ? `Your routines are: ${names.join(", ")}.` : "You don't have any routines yet.");
  },

  async run_routine({ task: name }) {
    const routine = findRoutine(name);
    if (!routine) return;
    speakText(`Starting ${routine.name}.`);
    await waitForSpeech();
    for (const step of routine.steps) {
      const intent = await parseCommand(step);
      // A routine that starts another routine could loop forever.
      if (!intent || intent.action === "unknown" || intent.action === "run_routine") continue;
      await executeWorkflow(intent);
      await waitForSpeech();
    }
  },

  async selection_action({ state }) {
    await hideOverlay();
    let text = "";
    try { text = (await invoke("read_selection")).trim(); } catch (e) { console.warn("[selection] copy failed:", e); }
    if (!text) {
      speakText("Select some text first, then ask me again.");
      return;
    }
    if (state === "read") {
      speakText(text.slice(0, 4000));
      return;
    }

    const task = state === "summarize"
      ? "Summarize this in two or three short sentences."
      : "Explain this simply in two or three short sentences, as if to a friend.";
    const answer = await askAI({
      prompt: `${task} Plain text only, it will be read aloud.\n\n"""${text.slice(0, 12000)}"""`,
      maxTokens: 300,
    });
    speakText(answer || "I can't do that right now. Sonix's offline AI may still be downloading; try again in a few minutes.");
  },

  async news_briefing({ query }) {
    const topic = query ? `${query} news` : "news";
    let headlines = [];
    try { headlines = await invoke("news_headlines", { query: query || "", region: newsRegion() }); } catch (e) { console.warn("[news] feed failed:", e); }
    if (headlines.length) {
      speakText(`Here are the top ${topic} headlines. ${headlines.slice(0, 3).map((h) => h.replace(/[.!?]?$/, ".")).join(" ")}`);
      return;
    }
    speakText(`Here's the latest ${topic}.`);
    await openLink(query ? `https://news.google.com/search?q=${encodeURIComponent(query)}` : "https://news.google.com");
  },

  async translate({ query, state: language }) {
    const code = LANGUAGES[language];
    if (!code) {
      speakText(`Sorry, I don't know the language ${language} yet.`);
      return;
    }
    await openLink(`https://translate.google.com/?sl=auto&tl=${code}&text=${encodeURIComponent(query)}&op=translate`);

    const raw = await askAI({
      prompt: `Translate "${query}" into ${language}. Reply as JSON: {"translation": "<in ${language} script>", "romanized": "<the same in English letters>"}`,
      json: true,
      maxTokens: 200,
    });
    let result = null;
    try { result = raw && JSON.parse(raw.replace(/```json|```/gi, "").trim()); } catch { /* fall back to the page */ }
    if (!result?.translation) {
      speakText(`Here's ${query} in ${language}.`);
      return;
    }
    // Without a voice for that language, read the English-letters version instead.
    if (!speakInLanguage(result.translation, code)) speakText(result.romanized || result.translation);
  },
};

/**
 * Runs the action if this module owns it.
 * @returns {Promise<boolean>} true when handled.
 */
export async function runAssistantAction(command) {
  const handler = HANDLERS[command.action];
  if (!handler) return false;
  try {
    await handler(command);
  } catch (e) {
    console.error(`[assistant] ${command.action} failed:`, e);
    speakText("Sorry, that didn't work.");
  }
  return true;
}
