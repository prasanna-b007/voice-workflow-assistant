import * as chrono from "chrono-node";
import { askAI } from "./aiClient";
import { matchAppName } from "../workflows/apps";
import { evaluateExpression } from "../utils/safeMath";
import { matchLocalCommand } from "./localCommands";

/*
 * Turns what the user said into an intent for workflowExecutor.
 *
 * The COMMANDS table below handles everything offline and instantly. Only a
 * sentence no entry matches goes to the optional AI backup; if AI is off or
 * fails too, a question becomes a Google search and anything else comes back
 * as "unknown", which App.jsx answers with "Sorry, I didn't catch that."
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, "0");

/**
 * Pulls a date and time out of a phrase ("tomorrow at 5", "next friday 3 pm").
 * @returns {{ rest: string, date: string, time: string, when: Date|null }}
 *   `rest` is the phrase without the date words; date is YYYY-MM-DD and time
 *   HH:mm (24-hour), each "" when not said.
 */
function extractWhen(phrase) {
  const [result] = chrono.parse(phrase, new Date(), { forwardDate: true });
  if (!result) return { rest: phrase.trim(), date: "", time: "", when: null };

  const when = result.start.date();
  const hasTime = result.start.isCertain("hour");
  // "at 5" with no am/pm: nobody means 5 in the morning for a reminder.
  if (hasTime && !result.start.isCertain("meridiem") && when.getHours() >= 1 && when.getHours() <= 7) {
    when.setHours(when.getHours() + 12);
  }

  const rest = (phrase.slice(0, result.index) + phrase.slice(result.index + result.text.length))
    .replace(/\s+(?:at|on|by|for|in)\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return {
    rest,
    date: `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`,
    time: hasTime ? `${pad(when.getHours())}:${pad(when.getMinutes())}` : "",
    when,
  };
}

/** "tomorrow at 5 PM" style wording for spoken confirmations. */
function describeWhen({ when, time }) {
  if (!when) return "";
  const day = when.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  return time ? ` on ${day} at ${when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : ` on ${day}`;
}

/** "john at gmail dot com" → "john@gmail.com". Left alone if it isn't an address. */
function spokenEmail(text) {
  const joined = text
    .trim()
    .replace(/\s+at\s+/gi, "@")
    .replace(/\s+dot\s+/gi, ".")
    .replace(/\s+/g, "");
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(joined) ? joined.toLowerCase() : text.trim();
}

/** "5 plus 3 times 2" → "5 + 3 * 2", or null when it isn't arithmetic. */
function toExpression(text) {
  const expr = text
    .toLowerCase()
    .replace(/,/g, "")
    .replace(/\bmultiplied by\b|\btimes\b|\binto\b|[x×]/g, " * ")
    .replace(/\bdivided by\b|\bover\b|÷/g, " / ")
    .replace(/\bplus\b|\band\b/g, " + ")
    .replace(/\bminus\b|\bless\b/g, " - ")
    .replace(/[?=]/g, "")
    .trim();
  if (!/^[\d\s.+\-*/()]+$/.test(expr) || !/\d\s*[+\-*/]\s*[\d(]/.test(expr)) return null;
  try {
    evaluateExpression(expr);
    return expr;
  } catch {
    return null;
  }
}

/** "on" / "off" from "turn off wifi", "enable bluetooth", …; "" when not said. */
function onOffState(text) {
  if (/\b(?:off|disable|deactivate|disconnect|stop)\b/i.test(text)) return "off";
  if (/\b(?:on|enable|activate|connect|start)\b/i.test(text)) return "on";
  return "";
}

/** A spoken level ("40", "40 percent", "up", "max") → what set_volume/set_brightness take. */
function levelFrom(text) {
  const number = text.match(/\b(\d{1,3})\b/);
  if (number) return String(Math.min(100, parseInt(number[1], 10)));
  if (/\b(?:max|maximum|full)\b/i.test(text)) return "100";
  if (/\b(?:min|minimum|lowest)\b/i.test(text)) return "0";
  if (/\b(?:up|increase|raise|higher|louder|brighter|more)\b/i.test(text)) return "increase";
  if (/\b(?:down|decrease|lower|reduce|quieter|softer|darker|dim|less)\b/i.test(text)) return "decrease";
  return "";
}

/** Strips the wake word and polite filler: "Hey Sonix, could you please open Chrome for me?" → "open Chrome". */
function normalize(text) {
  let s = text
    .replace(/wi-fi/gi, "wifi")
    // Whisper punctuates ("Open Chrome."); the rules expect bare words. Punctuation
    // inside tokens ("10:30", "2.5", "a@b.com") stays.
    .replace(/[.,!?;:]+(?=\s|$)/g, "")
    .trim();

  const fillers = [
    /^(?:hey|hi|ok|okay)\s+(?:sonix|sonics|sonic)\b\s*/i,
    /^(?:sonix|sonics|sonic)\b\s*/i,
    /^(?:please|kindly)\s+/i,
    /^(?:can|could|would|will)\s+you\s+(?:please\s+)?/i,
    /^(?:i\s+want\s+(?:you\s+)?to|i'd\s+like\s+(?:you\s+)?to|i\s+would\s+like\s+(?:you\s+)?to|i\s+need\s+(?:you\s+)?to)\s+/i,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const filler of fillers) {
      const next = s.replace(filler, "");
      if (next !== s) {
        s = next;
        changed = true;
      }
    }
  }
  return s.replace(/\s+(?:please|for me|right now)$/i, "").trim();
}

// ── Command table ────────────────────────────────────────────────────────────
//
// Checked top to bottom; the first entry whose `match` matches wins. `match` is a
// case-insensitive regex tested against the normalised sentence (original case,
// so typed text and notes keep their capitals), or a function returning a truthy
// value. `intent` builds the intent from that match.

const SCREEN_REPORT =
  /\b(?:analyze|analyse|scan|capture|summarize|summarise|generate|create|prepare|make|write|build|read)\b.*\b(?:screen|display|desktop|monitor|window)\b|\b(?:screen|display)\b.*\b(?:report|analysis|summary|insights)\b|\bwhat(?:'s| is) on (?:the |my )?screen\b|\bprepare (?:a )?report on (?:what'?s? on (?:the |my )?screen|(?:the |my )?screen)\b/i;

const SYSTEM_TOGGLES = [
  { words: /\bwifi\b|\bwireless\b/i, action: "toggle_wifi" },
  { words: /\bbluetooth\b/i, action: "toggle_bluetooth" },
  { words: /\b(?:airplane|aeroplane|flight)\s+mode\b/i, action: "toggle_airplane_mode" },
  { words: /\bhot\s?spot\b/i, action: "toggle_hotspot" },
  { words: /\bnight\s+(?:light|mode)\b/i, action: "toggle_night_light" },
  { words: /\b(?:energy|battery|power)\s+saver\b/i, action: "toggle_energy_saver" },
];

const COMMANDS = [
  // Conversation
  {
    match: /^(?:stop listening|go to sleep|sleep|go offline|good ?bye|bye(?: bye)?|that'?s all|that is all|nothing|never ?mind|cancel|stop|exit sonix|close sonix|quit sonix)$/i,
    intent: () => ({ action: "generic_reply", reply: "Okay. Say Hey Sonix when you need me.", continue: false }),
  },
  {
    match: /^(?:thanks|thank you)\b/i,
    intent: () => ({ action: "generic_reply", reply: "You're welcome.", continue: false }),
  },
  {
    match: /^(?:hi|hello|hey|good (?:morning|afternoon|evening))(?: there)?$/i,
    intent: () => ({ action: "generic_reply", reply: "Hello! What can I do for you?" }),
  },
  {
    match: /^how are you\b/i,
    intent: () => ({ action: "generic_reply", reply: "I'm doing well, thanks for asking. What can I do for you?" }),
  },
  {
    match: /^(?:help|what can you do|what are your commands|what do you do)$/i,
    intent: () => ({
      action: "generic_reply",
      reply: "I can open and close apps, search Google and YouTube, set reminders and meetings, control volume, brightness and Wi-Fi, take notes, and read your screen.",
    }),
  },

  // Google search. Checked early because the query is free text: "google how to fix
  // wifi" must search, not toggle wifi.
  {
    match: (s) =>
      s.match(/\bgoogle\s+(?:and\s+)?(?:search|look up|find)\s+(?:for\s+)?(.+)/i) ||
      s.match(/\b(?:search|look up|find)\s+(?:on\s+|in\s+)?google\s+(?:for\s+)?(.+)/i) ||
      s.match(/\b(?:search|look up|find)\s+(?:for\s+)?(.+?)\s+(?:on|in|using)\s+google$/i) ||
      s.match(/^google\s+(?!maps|drive|calendar|docs|sheets|slides|meet|photos|translate)(.+)/i),
    intent: (m) => ({ action: "web_search", query: m[1].replace(/\s+(?:on|in|using)\s+google$/i, "").trim() }),
  },

  // Screenshots and recording come before screen analysis, which also mentions the screen.
  {
    match: /\b(?:take|capture|grab|get)\s+(?:a\s+)?screen\s?shot\b|^screen\s?shot$/i,
    intent: () => ({ action: "take_screenshot" }),
  },
  {
    match: /\bstop\s+(?:the\s+)?(?:screen\s+)?recording\b/i,
    intent: () => ({ action: "stop_screen_recording" }),
  },
  {
    match: /\b(?:start|begin)\s+(?:a\s+)?(?:screen\s+)?recording\b|\brecord\s+(?:my\s+|the\s+)?screen\b/i,
    intent: () => ({ action: "start_screen_recording" }),
  },
  {
    match: SCREEN_REPORT,
    intent: (m, s) => ({
      action: "analyze_screen_report",
      reply: "Analyzing current screen",
      autoSave: /\bsave\b|\bsaved\b|\bfile\b|\bdesktop\b/i.test(s),
    }),
  },

  // Time, date, weather, maths
  {
    match: /\bwhat(?:'s| is)? the time\b|\bwhat time is it\b|\bcurrent time\b|^time$|^tell me the time$/i,
    intent: () => ({ action: "get_time" }),
  },
  {
    match: /\bwhat(?:'s| is)? (?:the |today'?s )?date\b|\bwhat day is (?:it|today)\b|\btoday'?s date\b|^date$/i,
    intent: () => ({ action: "get_date" }),
  },
  {
    match: /\bweather\b|\btemperature outside\b|\bis it (?:going to )?rain/i,
    intent: () => ({ action: "get_weather" }),
  },
  {
    match: (s) => {
      const m = s.match(/^(?:calculate|compute|what(?:'s| is)|how much is|solve)\s+(.+)$/i);
      const expression = m && toExpression(m[1]);
      return expression ? [s, expression] : null;
    },
    intent: (m) => ({ action: "calculate", data: { expression: m[1] } }),
  },

  // Email, meetings, reminders, notes
  {
    match: /^(?:send|write|compose|draft)\s+(?:an?\s+)?(?:e-?mail|mail)\b(.*)$|^e-?mail\s+(.+)$/i,
    intent: (m) => {
      const rest = ` ${(m[1] || m[2] || "").trim()}`;
      const to = rest.match(/\bto\s+(.+?)(?=\s+(?:about|regarding|with subject|subject|saying|that says|message)\b|$)/i);
      const subject = rest.match(/\b(?:about|regarding|with subject|subject)\s+(.+?)(?=\s+(?:saying|that says|message)\b|$)/i);
      const message = rest.match(/\b(?:saying|that says|message)\s+(.+)$/i);
      return {
        action: "send_email",
        to: to ? spokenEmail(to[1]) : "",
        subject: subject ? subject[1].trim() : "",
        message: message ? message[1].trim() : "",
        reply: "Opening your email.",
      };
    },
  },
  {
    match: /^(?:schedule|set up|book|arrange|create|add|plan)\s+(?:an?\s+|the\s+)?(?:meeting|call|appointment|event)\b(.*)$/i,
    intent: (m) => {
      const when = extractWhen(m[1]);
      const title = when.rest.match(/\b(?:with|about|for|regarding|called|named)\s+(.+)$/i);
      const meetingTitle = title ? `Meeting ${title[0].trim()}` : "Meeting";
      return {
        action: "schedule_meeting",
        meeting: { title: meetingTitle, time: when.time },
        date: when.date,
        time: when.time,
        reply: `Opening your calendar for ${meetingTitle.toLowerCase()}${describeWhen(when)}.`,
      };
    },
  },
  {
    match: /^(?:remind me|set (?:an?\s+|a new\s+)?reminder|add (?:an?\s+)?(?:reminder|task|to-?do)|create (?:an?\s+)?(?:reminder|task|to-?do)|new (?:reminder|task))\b\s*(?:to|for|that|about|of)?\s*(.*)$/i,
    intent: (m) => {
      const when = extractWhen(m[1]);
      const task = when.rest.replace(/^(?:to|for|that|about)\s+/i, "") || "Reminder";
      return {
        action: "create_task",
        task,
        date: when.date,
        time: when.time,
        reply: `Reminder set: ${task}${describeWhen(when)}.`,
      };
    },
  },
  {
    match: /^(?:take|make|save|write|add|create)\s+(?:a\s+)?note\s+(?:that\s+|saying\s+|to\s+)?(.+)$|^note\s+(?:that\s+|down\s+)?(.+)$|^write\s+down\s+(.+)$/i,
    intent: (m) => ({ action: "save_note", task: (m[1] || m[2] || m[3]).trim() }),
  },

  // YouTube
  {
    match: (s) =>
      s.match(/(?:play|search(?: for)?)\s+(.+?)\s*(?:on )?youtube/i) ||
      s.match(/(?:play|search(?: for)?)\s+(?:a\s+)?(?:youtube|yt)(?:\s+video)?(?:\s+of|\s+about)?\s+(.+)/i) ||
      s.match(/youtube(?: play| search(?: for)?)\s+(.+)/i),
    intent: (m) => {
      let query = (m[1] || "").trim().replace(/^youtube\s+/i, "").replace(/\s+on\s+youtube$/i, "");
      if (query.endsWith(" on")) query = query.slice(0, -3).trim();
      if (["a", "the", "a video", "video"].includes(query.toLowerCase())) query = "";
      return query ? { action: "youtube_search", task: query } : { action: "open_app", app: "youtube" };
    },
  },

  // Typing
  {
    match: /^(?:type|write)\s+(?!down\b)(.+)$/i,
    intent: (m) => ({ action: "type_text", data: { text: m[1] } }),
  },

  // System information ("how much battery", "how much RAM") is answered, not searched.
  {
    match: /\bbattery\b(?!\s+saver)|\bsystem info(?:rmation)?\b|\bhow much (?:ram|memory)\b/i,
    intent: () => ({ action: "get_system_info" }),
  },

  // A question that mentions a setting or an app is a question, not an order: "why is my
  // wifi so slow" must search rather than switch Wi-Fi off, and "how do I quit Word"
  // must not close Word. Everything below this rule changes something on the PC.
  {
    match: /^(?:who|what|when|where|why|how|which|whose|is|are|was|were|does|do|did|should|define)\b.+/i,
    intent: (m, s) => ({ action: "web_search", query: s }),
  },

  // Volume and brightness
  {
    match: /^(?:mute|unmute)(?: (?:the )?(?:volume|sound|audio|pc|computer))?$|\b(?:mute|unmute) (?:the )?(?:volume|sound|audio)\b/i,
    intent: () => ({ action: "set_volume", level: "mute" }),
  },
  {
    match: /\bvolume\b|\bsound\b.*\b(?:up|down|louder|quieter)\b|^(?:louder|quieter|softer)$/i,
    intent: (m, s) => ({ action: "set_volume", level: levelFrom(s) || "increase" }),
  },
  {
    match: /\bbrightness\b|\bscreen\b.*\b(?:brighter|darker|dimmer)\b|^(?:brighter|darker|dim the screen)$/i,
    intent: (m, s) => ({ action: "set_brightness", level: levelFrom(s) || "increase" }),
  },

  // Wi-Fi, Bluetooth and the other quick settings. Only orders ("turn off wifi",
  // "bluetooth on", "toggle hotspot", or just "airplane mode"), not a remark that
  // mentions one ("my wifi keeps dropping").
  {
    match: (s) => {
      const toggle = SYSTEM_TOGGLES.find((t) => t.words.test(s));
      if (!toggle) return null;
      const order =
        /^(?:turn|switch|toggle|enable|disable|activate|deactivate|start|stop|connect|disconnect)\b/i.test(s) ||
        /\b(?:on|off)$/i.test(s) ||
        !s.replace(toggle.words, "").trim();
      return order ? toggle : null;
    },
    intent: (toggle, s) => ({ action: toggle.action, state: onOffState(s) }),
  },

  // Power
  {
    match: /\b(?:cancel|abort|stop)\s+(?:the\s+)?(?:shut\s?down|restart|reboot)\b/i,
    intent: () => ({ action: "cancel_shutdown" }),
  },
  {
    match: /\b(?:shut\s?down|turn off|power off|switch off)\b.*?\b(?:in|after)\s+(\d+)\s*(?:minutes?|mins?)\b/i,
    intent: (m) => ({ action: "shutdown_timer", data: { time: m[1] } }),
  },
  {
    match: /^(?:shut\s?down|power off)(?:\s+(?:the|my)?\s*(?:pc|computer|laptop|system))?$|\b(?:turn off|shut\s?down|switch off|power off)\s+(?:the|my)\s+(?:pc|computer|laptop|system)\b/i,
    intent: () => ({ action: "shutdown" }),
  },
  {
    match: /^(?:restart|reboot)(?:\s+(?:the|my)?\s*(?:pc|computer|laptop|system))?$/i,
    intent: () => ({ action: "restart" }),
  },

  // Scrolling and saving
  {
    match: /\bscroll\s+(up|down)\b/i,
    intent: (m) => ({ action: `scroll_${m[1].toLowerCase()}` }),
  },
  {
    match: /^save\s+(?:it\s+|this\s+|the file\s+|my work\s+)?in\s+(.+)$/i,
    intent: (m) => ({ action: "save", app: matchAppName(m[1]) || m[1].toLowerCase() }),
  },
  {
    match: /^save(?:\s+(?:this|it|the file|file|the document|document|my work|everything))?$/i,
    intent: () => ({ action: "save", app: "current" }),
  },

  // Files
  {
    match: /\b(?:open|show)\s+(?:my\s+)?recent(?:\s+files)?\b/i,
    intent: () => ({ action: "open_recent" }),
  },
  {
    match: /^(?:search|find|look)\s+(?:for\s+)?(?:a\s+|the\s+|my\s+)?files?\s+(?:named\s+|called\s+|for\s+)?(.+)$/i,
    intent: (m) => ({ action: "search_file", data: { query: m[1] } }),
  },
  {
    match: /^open\s+(?:the\s+|my\s+)?file\s+(?:named\s+|called\s+)?(.+)$/i,
    intent: (m) => ({ action: "open_file", data: { name: m[1] } }),
  },

  // Closing apps: only as an order at the start ("close Word"), never a sentence that
  // merely contains "quit".
  {
    match: /^(?:close|exit|quit|kill|terminate)$/i,
    intent: () => ({ action: "close_app", app: "current" }),
  },
  {
    match: /^(?:close|exit|quit|kill|terminate)\s+(?:the\s+)?(.+)$/i,
    intent: (m) => {
      const target = m[1].trim().toLowerCase();
      if (["app", "application", "program", "window", "this", "it", "this window", "this app", "current window"].includes(target)) {
        return { action: "close_app", app: "current" };
      }
      return { action: "close_app", app: matchAppName(target) || target };
    },
  },

  // Websites by address: "open amazon dot in", "go to wikipedia.org"
  {
    match: (s) => {
      const m = s.match(/^(?:open|go to|visit|launch)\s+(.+)$/i);
      const address = m && m[1].trim().toLowerCase().replace(/\s+dot\s+/g, ".");
      return address && /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/\S*)?$/.test(address) ? [s, address] : null;
    },
    intent: (m) => ({ action: "open_url", data: { url: `https://${m[1]}` } }),
  },

  // Opening and switching apps; fuzzy-matched so "open crome" still works.
  {
    match: /^(?:open|launch|start|run|show|bring up|go to|switch to)\s+(?:the\s+|my\s+)?(.+)$/i,
    intent: (m) => ({ action: "open_app", app: matchAppName(m[1]) || m[1].trim().toLowerCase() }),
  },

  // Just an app name: "chrome", "spotify"
  {
    match: (s) => matchAppName(s),
    intent: (app) => ({ action: "open_app", app }),
  },

  // Any other question gets a Google search.
  {
    match: /^(?:who|what|when|where|why|how|which|whose|define|tell me about|meaning of)\b.+/i,
    intent: (m, s) => ({ action: "web_search", query: s }),
  },
];

// Actions the AI backup may return. Kept in sync with workflowExecutor.
const SUPPORTED_ACTIONS = [
  "generic_reply", "web_search", "take_screenshot", "start_screen_recording", "stop_screen_recording",
  "analyze_screen_report", "get_time", "get_date", "get_weather", "calculate", "send_email",
  "schedule_meeting", "create_task", "save_note", "youtube_search", "type_text", "set_volume",
  "set_brightness", ...SYSTEM_TOGGLES.map((t) => t.action), "cancel_shutdown", "shutdown_timer",
  "shutdown", "restart", "scroll_up", "scroll_down", "save", "open_recent", "search_file",
  "open_file", "get_system_info", "close_app", "open_url", "open_app",
  // Handled in workflows/assistantActions.js
  "media_control", "directions", "maps_search", "window_control", "switch_app", "youtube_play",
  "spotify_play", "whatsapp_message", "news_briefing", "translate", "selection_action", "list_routines",
];

/**
 * Checks an intent from the AI before anything acts on it: a small model can invent an
 * action, an app ("e" would match every process) or a setting. Returns the intent with
 * only the fields that make sense, or null to reject it.
 */
function checkAIIntent(parsed) {
  if (!parsed || typeof parsed !== "object" || !SUPPORTED_ACTIONS.includes(parsed.action)) return null;
  const text = (v, max = 500) => (typeof v === "string" ? v.slice(0, max) : "");
  const intent = { ...parsed };
  for (const key of ["app", "query", "task", "to", "subject", "message", "date", "time", "level", "state", "reply"]) {
    intent[key] = text(parsed[key]);
  }

  const { action } = intent;
  if (action === "close_app" || action === "switch_app") {
    // Only apps Sonix knows by name; never a guess.
    const known = intent.app === "current" ? "current" : matchAppName(intent.app);
    if (!known) return null;
    intent.app = known;
  } else if (action === "open_app") {
    intent.app = intent.app.toLowerCase().trim();
    if (!/^[a-z0-9][a-z0-9 .+'-]{0,39}$/.test(intent.app)) return null;
  }
  if (action.startsWith("toggle_") && !["", "on", "off"].includes(intent.state)) intent.state = "";
  if ((action === "set_volume" || action === "set_brightness") && !/^(?:\d{1,3}|increase|decrease|mute)$/.test(intent.level)) {
    return null;
  }
  if (action === "media_control" && !["play_pause", "next", "previous"].includes(intent.state)) intent.state = "play_pause";
  if (action === "window_control" && !["minimize_all", "lock", "empty_recycle_bin"].includes(intent.state)) return null;
  // Powering off on a model's guess is too costly: only the built-in rules may do it.
  if (["shutdown", "restart", "shutdown_timer"].includes(action)) return null;
  if (action === "youtube_search" && !intent.task) intent.task = intent.query;
  return intent;
}

/** Asks the optional AI backup to interpret a sentence the table didn't match. */
async function parseWithAI(text) {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

  const prompt = `You convert voice commands for a Windows assistant called Sonix into JSON.

Allowed actions: ${SUPPORTED_ACTIONS.join(", ")}.
If none fits, use "unknown".

Return exactly this JSON shape, with "" for anything not said:
{
  "action": "",
  "app": "",
  "query": "",
  "task": "",
  "to": "",
  "subject": "",
  "message": "",
  "date": "",
  "time": "",
  "level": "",
  "state": "",
  "reply": ""
}

Rules:
- open_app / close_app: "app" is the app or website name, lowercase.
- web_search and youtube_search: the search words go in "query" (youtube_search: in "task").
- create_task / save_note: the reminder or note text goes in "task".
- set_volume / set_brightness: "level" is "increase", "decrease", "mute" or a number 0-100.
- toggle_*: "state" is "on", "off" or "".
- media_control: "state" is "play_pause", "next" or "previous".
- window_control: "state" is "minimize_all", "lock" or "empty_recycle_bin".
- switch_app: bring an already-open app to the front; "app" as for open_app.
- youtube_play / spotify_play: play a song or video; what to play goes in "query".
- directions: route to a place in "query". maps_search: places to find nearby in "query".
- whatsapp_message: contact name in "to", text in "message".
- news_briefing: optional topic in "query". translate: text in "query", target language name in "state".
- selection_action: act on the user's selected text; "state" is "read", "summarize" or "explain".
- date is YYYY-MM-DD (today is ${todayStr}); time is 24-hour HH:mm.
- "reply" is a short spoken confirmation, under 10 words. For generic_reply it is the whole answer.

Command: "${text}"`;

  const raw = await askAI({ prompt, json: true, maxTokens: 300 }, 12000);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw.replace(/```json/gi, "").replace(/```/g, "").trim());
    return checkAIIntent(parsed);
  } catch {
    console.warn("[parser] AI returned something that isn't JSON:", raw);
    return null;
  }
}

/**
 * Parses a spoken command.
 * @param {string} text What the user said.
 * @returns {Promise<object|null>} An intent for executeWorkflow; action "unknown"
 *   when nothing understood it, null for empty input.
 */
export async function parseCommand(text) {
  if (!text || !text.trim()) return null;

  const sentence = normalize(text);
  if (!sentence) return null;

  const local = matchLocalCommand(sentence);
  if (local) return local;

  for (const command of COMMANDS) {
    const m = typeof command.match === "function" ? command.match(sentence) : sentence.match(command.match);
    if (m) {
      const intent = command.intent(m, sentence);
      console.log("[parser] Built-in rule:", intent);
      return intent;
    }
  }

  const fromAI = await parseWithAI(sentence);
  if (fromAI) {
    console.log("[parser] AI backup:", fromAI);
    return fromAI;
  }

  return { action: "unknown" };
}
