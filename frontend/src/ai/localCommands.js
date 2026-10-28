import * as chrono from "chrono-node";
import { matchAppName } from "../workflows/apps";
import { findRoutine } from "../storage/routines";
import { recentSearch } from "../workflows/lastSearch";

/*
 * Extra built-in commands: media keys, timers and alarms, maps, window control,
 * YouTube/Spotify playback, WhatsApp, contacts and routines. aiParser checks
 * these before its own table, so a rule here wins over a similar one there.
 */

/** Google Translate codes for languages people are likely to ask for. */
export const LANGUAGES = {
  tamil: "ta", hindi: "hi", telugu: "te", kannada: "kn", malayalam: "ml", marathi: "mr", bengali: "bn",
  gujarati: "gu", punjabi: "pa", urdu: "ur", english: "en", french: "fr", spanish: "es", german: "de",
  italian: "it", portuguese: "pt", russian: "ru", arabic: "ar", japanese: "ja", korean: "ko",
  chinese: "zh-CN", mandarin: "zh-CN", thai: "th", indonesian: "id", turkish: "tr", dutch: "nl",
};

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, "twenty five": 25, thirty: 30, forty: 40,
  "forty five": 45, fifty: 50, sixty: 60, ninety: 90,
};

const UNIT_SECONDS = { h: 3600, m: 60, s: 1 };

/** "10 minutes", "an hour and a half", "1 hour 20 mins" → seconds, or 0 when no duration is said. */
function parseDuration(text) {
  const s = text.toLowerCase();
  if (/\bhalf an hour\b/.test(s)) return 1800;

  let total = 0;
  const pattern = /(\d+(?:\.\d+)?|twenty five|forty five|[a-z]+)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/g;
  for (const [, amount, unit] of s.matchAll(pattern)) {
    const n = /^\d/.test(amount) ? parseFloat(amount) : NUMBER_WORDS[amount];
    if (n) total += n * UNIT_SECONDS[unit[0]];
  }
  if (/\band a half\b/.test(s) && /\bhours?\b/.test(s)) total += 1800;
  return Math.round(total);
}

/** Seconds from now until a spoken clock time ("6:30 am", "7 tomorrow"), or 0. */
function secondsUntil(text) {
  const when = chrono.parseDate(text.replace(/\b([ap])\.?m\.?\b/gi, "$1m"), new Date(), { forwardDate: true });
  if (!when) return 0;
  return Math.max(0, Math.round((when.getTime() - Date.now()) / 1000));
}

/** "opens notion and plays lofi" → ["open notion", "play lofi"]; a step with no verb reuses the last one. */
function splitSteps(text) {
  const verbs = /^(?:open|launch|start|play|pause|search|google|set|turn|close|send|switch|what|tell|read|lock|minimi[sz]e|show|mute)\b/i;
  let lastVerb = "open";
  return text
    // aiParser strips commas, so "turns on X, sets Y" is split at each "-s" verb instead.
    .replace(/\s+(?=(?:opens|launches|starts|plays|searches|sets|turns|closes|sends|switches|shows|mutes|pauses|locks)\b)/gi, " then ")
    .split(/\s*(?:,|\band then\b|\bthen\b|\band\b)\s*/i)
    .map((step) => step.trim().replace(/^(opens|launches|starts|plays|searches|sets|turns|closes|sends|switches|shows)\b/i, (v) => v.replace(/e?s$/i, "")))
    .filter(Boolean)
    .map((step) => {
      const verb = step.match(verbs);
      if (verb) {
        lastVerb = verb[0].toLowerCase();
        return step;
      }
      return `${lastVerb} ${step}`;
    });
}

const ORDINALS = { first: 1, "1st": 1, top: 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5, last: "last" };

const RULES = [
  // Results of the last Google search. The site form ("open the wikipedia one") only
  // applies right after a search, so "open the settings page" still opens settings.
  {
    match: /^(?:open|click|show me)(?: the)? (first|1st|top|second|2nd|third|3rd|fourth|4th|fifth|5th|last)(?: (?:result|link|one|website|site|page|search result))?$|^open (?:it|that)$/i,
    intent: (m) => ({ action: "open_result", state: m[1] ? ORDINALS[m[1].toLowerCase()] : 1 }),
  },
  {
    match: (s) => recentSearch() && s.match(/^(?:open|click|show me|go to)(?: the)? (.+?) (?:result|link|one|page|article|website|site)$/i),
    intent: (m) => ({ action: "open_result", query: m[1].trim() }),
  },

  // Media keys. Bare "stop" is left to aiParser, where it means "stop listening".
  {
    match: /^(?:play|pause|resume|continue)(?: the)?(?: music| song| video| playback| media)?$|^stop (?:the )?(?:music|song|video|playback)$/i,
    intent: () => ({ action: "media_control", state: "play_pause" }),
  },
  {
    match: /^(?:next|skip)(?: (?:the|this))?(?: song| track| video)?$|^play (?:the )?next(?: song| track| video)?$/i,
    intent: () => ({ action: "media_control", state: "next" }),
  },
  {
    match: /^(?:previous|last)(?: song| track| video)?$|^(?:play (?:the )?previous|go back (?:a|one))(?: song| track| video)?$/i,
    intent: () => ({ action: "media_control", state: "previous" }),
  },

  // Timers, alarms and "remind me in …"
  {
    match: /^(?:cancel|stop|delete|clear|turn off)(?: (?:the|my|all))?(?: (?:my|the))? (?:timers?|alarms?|reminders? timers?)$/i,
    intent: () => ({ action: "cancel_timers" }),
  },
  {
    match: (s) => /\btimer\b/i.test(s) && parseDuration(s) > 0 && [s, parseDuration(s)],
    intent: (m) => ({ action: "set_timer", seconds: m[1], task: "" }),
  },
  {
    match: (s) => {
      const m = s.match(/^remind me in (.+?) (?:to|that|about) (.+)$/i);
      return m && parseDuration(m[1]) > 0 && [s, parseDuration(m[1]), m[2]];
    },
    intent: (m) => ({ action: "set_timer", seconds: m[1], task: m[2] }),
  },
  {
    match: (s) => {
      const m = s.match(/^(?:set (?:an |the )?alarm|wake me up)(?: for| at)? (.+)$/i);
      // chrono reads a bare "7 tomorrow" as a date only; "at 7 tomorrow" is a time.
      const when = m && (/^\d/.test(m[1]) ? `at ${m[1]}` : m[1]);
      return m && secondsUntil(when) > 0 && [s, secondsUntil(when), m[1]];
    },
    intent: (m) => ({ action: "set_timer", seconds: m[1], task: "", alarm: m[2] }),
  },

  // Google Maps
  {
    match: /^(?:give me |get |show me |show |find )?(?:the )?(?:directions|route|way) (?:to|for) (.+)$|^(?:navigate|take me|how do i get|how can i get|how to go|how to reach|how do i go) to (.+)$/i,
    intent: (m) => ({ action: "directions", query: (m[1] || m[2]).trim() }),
  },
  {
    match: /^(?:find |show me |where is |where's )?(?:the |a )?(?:nearest|closest|nearby) (.+)$|^(?:find |show me )?(.+?) near me$/i,
    intent: (m) => ({ action: "maps_search", query: `${(m[1] || m[2]).trim()} near me` }),
  },

  // Window control
  {
    match: /^(?:minimi[sz]e (?:all|everything)(?: (?:the )?windows)?|show (?:the |my )?desktop|go to (?:the )?desktop)$/i,
    intent: () => ({ action: "window_control", state: "minimize_all" }),
  },
  {
    match: /^lock (?:my |the |this )?(?:pc|computer|laptop|screen|system|device)$|^lock$/i,
    intent: () => ({ action: "window_control", state: "lock" }),
  },
  {
    match: /^(?:empty|clear|clean)(?: out)? (?:the |my )?recycle ?bin$/i,
    intent: () => ({ action: "window_control", state: "empty_recycle_bin" }),
  },
  {
    // Brings the running window to the front; aiParser's rule would start a new copy.
    match: (s) => {
      const m = s.match(/^(?:switch|go back|change) to (?:the |my )?(.+?)(?: app| window)?$/i);
      return m && matchAppName(m[1]) && [s, matchAppName(m[1])];
    },
    intent: (m) => ({ action: "switch_app", app: m[1] }),
  },

  // Spotify, then YouTube. "play <anything>" with no platform plays it on YouTube.
  {
    match: /^play (.+?) (?:on|in) spotify$|^spotify play (.+)$/i,
    intent: (m) => ({ action: "spotify_play", query: (m[1] || m[2]).trim() }),
  },
  {
    match: /^play (.+?) (?:on|in) (?:youtube|yt)$|^(?:youtube|yt) play (.+)$|^play (?:a |the )?(?:youtube|yt) video (?:of |about |for )?(.+)$|^play (?!(?:the )?(?:music|song|video|next|previous)$)(.+)$/i,
    intent: (m) => ({ action: "youtube_play", query: (m[1] || m[2] || m[3] || m[4]).trim() }),
  },

  // Contacts and WhatsApp
  {
    match: /^(?:save|add|store)(?: a)?(?: new)?(?: contact)? (.+?)(?:'s|s')? (?:phone number|mobile number|whatsapp number|number|phone|mobile)(?: as| is)?\s+(\+?[\d][\d\s-]{6,})$|^(?:save|add) (?:a )?(?:new )?contact (.+?) (?:with number |number )?(\+?[\d][\d\s-]{6,})$/i,
    intent: (m) => ({ action: "save_contact", to: (m[1] || m[3]).trim(), phone: (m[2] || m[4]).replace(/[\s-]/g, "") }),
  },
  {
    match: /^(?:save|add|store)(?: a)?(?: contact)? (.+?)(?:'s|s')? (?:email address|email id|email|mail id|mail)(?: as| is)?\s+(.+)$/i,
    intent: (m) => ({
      action: "save_contact",
      to: m[1].trim(),
      email: m[2].trim().replace(/\s+at\s+/gi, "@").replace(/\s+dot\s+/gi, ".").replace(/\s+/g, "").toLowerCase(),
    }),
  },
  {
    match: /^(?:send |write )?(?:a )?(?:whatsapp(?: message)?|message|text|msg)(?: on whatsapp)?(?: to)? (.+?) (?:saying|that says|telling (?:him|her|them)|that) (.+)$|^whatsapp (.+?) (?:saying|that) (.+)$/i,
    intent: (m) => ({ action: "whatsapp_message", to: (m[1] || m[3]).trim(), message: (m[2] || m[4]).trim() }),
  },

  // Selected text, news and translation
  {
    match: /^(read|summari[sz]e|explain|simplify)(?: (?:this|that|it|the selected text|the selection|what i selected|out (?:this|that)))?(?: (?:out loud|aloud|for me|to me))?$/i,
    intent: (m) => ({ action: "selection_action", state: m[1].toLowerCase().replace("summarise", "summarize").replace("simplify", "explain") }),
  },
  {
    match: /^(?:what'?s|what is|what are|tell me|read me|give me|get me)(?: the)?(?: latest| today'?s| top)? (?:(.+?) )?(?:news|headlines)(?: today| now| for today)?$|^(?:the )?(?:latest )?(?:news|headlines)$/i,
    intent: (m) => ({ action: "news_briefing", query: (m[1] || "").replace(/^(?:the|today'?s|latest|top)\s+/i, "").trim() }),
  },
  {
    // Only known languages, so "what's the time in London" stays a question.
    match: (s) => {
      const m = s.match(/^(?:translate|how do (?:you|i) say|say) (.+?) (?:to|into|in) ([a-z]+)$|^what(?:'s| is) (.+?) in ([a-z]+)$/i);
      return m && LANGUAGES[(m[2] || m[4]).toLowerCase()] && m;
    },
    intent: (m) => ({ action: "translate", query: (m[1] || m[3]).trim(), state: (m[2] || m[4]).toLowerCase() }),
  },

  // Routines
  {
    // Names are at most three words, so "to" inside a step ("set volume to 20") isn't taken as the separator.
    match: /^(?:create|make|add|save|set up|new)(?: a| the)? routine (?:called |named )?(\S+(?: \S+){0,2}?) (?:that|which|to|with)\s+(.+)$/i,
    intent: (m) => ({ action: "create_routine", task: m[1].trim().toLowerCase(), steps: splitSteps(m[2]) }),
  },
  {
    // Unparseable "create a routine …": answer with an example instead of running its steps now.
    match: /^(?:create|make|add|save|set up|new)(?: a| the)? routine\b/i,
    intent: () => ({ action: "create_routine", task: "", steps: [] }),
  },
  {
    match: /^(?:delete|remove|forget)(?: the| my)? routine (?:called |named )?(.+)$|^(?:delete|remove|forget) (?:the |my )?(.+?) routine$/i,
    intent: (m) => ({ action: "delete_routine", task: (m[1] || m[2]).trim().toLowerCase() }),
  },
  {
    match: /^(?:what|which|list|show|tell me)(?: are)?(?: my| the)? routines(?: do i have)?$|^what routines do i have$/i,
    intent: () => ({ action: "list_routines" }),
  },
  {
    match: (s) => {
      const name = s.replace(/^(?:run|start|do|activate|begin|switch to|turn on)\s+(?:the |my )?/i, "").replace(/\s+routine$/i, "");
      return findRoutine(name) && [s, findRoutine(name).name];
    },
    intent: (m) => ({ action: "run_routine", task: m[1] }),
  },
];

/**
 * @param {string} sentence The normalised sentence from aiParser.
 * @returns {object|null} An intent, or null when no rule here matches.
 */
export function matchLocalCommand(sentence) {
  for (const rule of RULES) {
    const m = typeof rule.match === "function" ? rule.match(sentence) : sentence.match(rule.match);
    if (m) {
      const intent = rule.intent(m, sentence);
      console.log("[parser] Assistant rule:", intent);
      return intent;
    }
  }
  return null;
}
