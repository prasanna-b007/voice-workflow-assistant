/* ────────────────────────────────────────────
   App catalogue shared by the command parser (to recognise app names, even
   misheard ones) and the workflow executor (to open and close them).
   ──────────────────────────────────────────── */

/** Spoken name → process / launch name for desktop apps. */
export const APP_PROCESS_MAP = {
  // Code Editors
  "visual studio code": "code",
  "vs code": "code",
  "vscode": "code",
  "visual studio": "devenv",
  // Microsoft Office
  "word": "winword",
  "microsoft word": "winword",
  "excel": "excel",
  "powerpoint": "powerpnt",
  // System Tools
  "notepad": "notepad",
  "note pad": "notepad",
  "note pade": "notepad",
  "paint": "mspaint",
  "command prompt": "cmd",
  "terminal": "wt",
  "calculator": "calc",
  "calc": "calc",
  "file explorer": "explorer",
  "explorer": "explorer",
  "task manager": "taskmgr",
  "snipping tool": "snippingtool",
  "control panel": "control",
  "recycle bin": "shell:RecycleBinFolder",
  "settings": "ms-settings:",
  "camera": "microsoft.windows.camera:",
  "clock": "ms-clock:",
  "maps": "bingmaps:",
  "store": "ms-windows-store:",
  "microsoft store": "ms-windows-store:",
  // Browsers
  "chrome": "chrome",
  "google chrome": "chrome",
  "firefox": "firefox",
  "edge": "msedge",
  "microsoft edge": "msedge",
  "brave": "brave",
  // Communication & Media
  "spotify": "spotify",
  "discord": "discord",
  "slack": "slack",
  "teams": "teams",
  "microsoft teams": "teams",
  "zoom": "zoom",
  "vlc": "vlc",
  "media player": "wmplayer",
  "obs": "obs64",
  "steam": "steam",
};

/** Spoken name → URL for web apps, which open in the default browser. */
export const WEB_APPS = {
  "youtube": "https://www.youtube.com",
  "google": "https://www.google.com",
  "whatsapp": "https://web.whatsapp.com",
  "facebook": "https://www.facebook.com",
  "instagram": "https://www.instagram.com",
  "twitter": "https://www.twitter.com",
  "x": "https://www.x.com",
  "linkedin": "https://www.linkedin.com",
  "github": "https://www.github.com",
  "gmail": "https://mail.google.com",
  "email": "https://mail.google.com",
  "outlook": "https://outlook.live.com",
  "google drive": "https://drive.google.com",
  "google maps": "https://maps.google.com",
  "google calendar": "https://calendar.google.com",
  "netflix": "https://www.netflix.com",
  "amazon": "https://www.amazon.com",
  "reddit": "https://www.reddit.com",
  "spotify": "https://open.spotify.com",
  "chatgpt": "https://chat.openai.com",
  "canva": "https://www.canva.com",
  "figma": "https://www.figma.com",
  "notion": "https://www.notion.so",
  "slack": "https://slack.com",
  "discord": "https://discord.com/app",
  "telegram": "https://web.telegram.org",
  "pinterest": "https://www.pinterest.com",
  "stackoverflow": "https://stackoverflow.com",
  "stack overflow": "https://stackoverflow.com",
};

const KNOWN_APPS = [...new Set([...Object.keys(APP_PROCESS_MAP), ...Object.keys(WEB_APPS)])];

/** Number of single-letter edits that turn `a` into `b`. */
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * The known app name closest to what was heard ("crome" → "chrome",
 * "spotfy" → "spotify"), or null when nothing is close enough.
 * @param {string} spoken
 * @returns {string|null}
 */
export function matchAppName(spoken) {
  const name = (spoken || "")
    .toLowerCase()
    .trim()
    .replace(/^(?:the|my)\s+/, "")
    .replace(/\s+(?:app|application|website|site|browser)$/, "")
    .replace(/[.]+$/, "");
  if (!name) return null;
  if (KNOWN_APPS.includes(name)) return name;

  // About one wrong letter per four, at most two, so short names don't match everything.
  let best = null;
  let bestDistance = Infinity;
  for (const known of KNOWN_APPS) {
    const allowed = Math.min(2, Math.floor(known.length / 4));
    const distance = editDistance(name, known);
    if (distance <= allowed && distance < bestDistance) {
      best = known;
      bestDistance = distance;
    }
  }
  return best;
}
