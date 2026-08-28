/**
 * contentCleaner.js
 * ─────────────────
 * Stage 4 — Aggressive Content Cleaning Pipeline.
 *
 * Takes raw extracted text (from DOM or OCR) and removes:
 *   • Browser UI noise  (tabs, toolbar, address bar, bookmarks, extensions)
 *   • Duplicate / near-duplicate lines
 *   • Random punctuation spam
 *   • Meaningless short fragments
 *   • Excessive whitespace
 *   • Repeated navigation boilerplate
 *   • URLs (unless they look meaningful / contextual)
 *
 * Retains:
 *   • Dashboard metrics and statistics
 *   • Headings and section labels
 *   • Table data and structured content
 *   • Named entities (people, parties, places, products)
 *   • Numeric data with context
 */

// ─── Browser UI noise patterns ─────────────────────────────────────────────────

/**
 * Lines matching these patterns are browser/OS chrome — not content.
 * Evaluated case-insensitively against the TRIMMED line.
 */
const BROWSER_UI_PATTERNS = [
  // Address bar / navigation
  /^https?:\/\//i,
  /^www\./i,
  /^(file|chrome|edge|brave|firefox|about|data):\/\//i,
  /^javascript:/i,

  // Browser controls / toolbar labels
  /^(new tab|close tab|reload|refresh|back|forward|home|stop|zoom|print|find|help)$/i,
  /^(extensions?|settings?|history|downloads?|bookmarks?|passwords?|profiles?)$/i,
  /^(chrome|edge|brave|firefox|opera|safari)\b/i,
  /^(sign in|log in|login|sign up|register)\s*$/i,
  /^google$/i,

  // Common browser extension names (noise)
  /^(adblock|ublock|grammarly|lastpass|honey|pocket|pinterest|reddit|ext-.*)\b/i,

  // Search bar content
  /^search\s+.{0,40}$/i,
  /^(search the web|web search|google search|bing search)$/i,

  // Tab labels / Chrome labels
  /^\(\d+\)\s+/,               // (3) unread message count prefix
  /^·\s+/,                     // bullet separator used in tab titles
  /^— .+— .+$/,               // title pattern with dashes
  /^new tab$/i,
  /^google chrome$/i,
  /^incognito$/i,

  // Extraction metadata noise (prevent recursion)
  /^\d+\s+words?\s+extracted/i,
  /^detected\s+sections/i,
  /^key\s+statistics\s+found/i,
  /^named\s+entities\s+mentioned/i,
  /^extracted\s+content\s+preview/i,

  // Pure symbol spam (no alphanumeric content)
  /^[^a-zA-Z0-9\u0900-\u097F\u0B80-\u0BFF]+$/,

  // Copyright / legal boilerplate
  /^(all rights reserved|copyright|©\s*\d{4}|privacy policy|terms of (use|service)|cookie policy)$/i,

  // Navigation noise
  /^(home|menu|nav|navbar|sidebar|footer|header|breadcrumb|pagination|next|prev|previous|skip to main content)$/i,

  // Empty or whitespace only (handled separately but guard here too)
  /^\s*$/,
];

/**
 * Repeated boilerplate that appears across many sites — skip after first seen.
 */
const GLOBAL_BOILERPLATE = new Set([
  "cookie", "cookies", "accept", "decline", "allow", "deny",
  "subscribe", "newsletter", "notifications", "allow notifications",
  "loading...", "loading", "please wait", "refresh", "refreshed",
  "back to top", "scroll to top", "skip to content",
  "share", "tweet", "like", "follow", "comment", "comments",
  "advertisement", "sponsored", "promoted", "sign in", "sign up",
  "terms of service", "privacy policy", "help", "about",
]);

// ─── Noise signal detectors ────────────────────────────────────────────────────

/** Returns true if the line is browser UI or OS chrome noise. */
function isBrowserNoise(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;

  // Check against pattern list
  for (const pattern of BROWSER_UI_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  // Check boilerplate dictionary
  if (GLOBAL_BOILERPLATE.has(trimmed.toLowerCase())) return true;

  // Single token under 3 chars is almost always noise unless it's a number
  if (trimmed.length < 3 && !/^\d+[\.,]?\d*$/.test(trimmed)) return true;

  // Pure punctuation spam (>70% non-alphanumeric)
  const alphanum = (trimmed.match(/[a-zA-Z0-9\u0900-\u097F\u0B80-\u0BFF]/g) || []).length;
  if (trimmed.length > 3 && alphanum / trimmed.length < 0.3) return true;

  return false;
}

// ─── De-duplication ────────────────────────────────────────────────────────────

/**
 * Normalise a line for duplicate-detection purposes.
 * Strips punctuation and lowercases so minor variations are caught.
 *
 * @param {string} line
 * @returns {string}
 */
function normaliseForDedup(line) {
  return line
    .toLowerCase()
    .replace(/[^\w\s\u0900-\u097F\u0B80-\u0BFF]/g, "")  // strip punctuation (keeps Devanagari/Tamil)
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Browser tab bar stripping ───────────────────────────────────────────────

/**
 * Detect if a line looks like the OCR-captured browser tab bar.
 * The tab bar is one long line containing multiple tab close buttons (" X "
 * or "×") and/or Chrome tab icon characters ({@, \uE000-\uF8FF).
 *
 * Example: "Sonix- Project Overview X Student Dashboard X Election X + = a X"
 *
 * @param {string} line
 * @returns {boolean}
 */
function isBrowserTabBarLine(line) {
  const t = line.trim();
  // Multiple standalone X tokens (tab close buttons) or close symbols
  const closeButtons = (t.match(/(?:^|\s)[Xx×✕](?:\s|$)/g) || []).length;
  if (closeButtons >= 2) return true;
  
  // OCR junk pattern: many single-char tokens or close buttons mixed with text
  const tokens = t.split(/\s+/);
  if (tokens.length > 5) {
    const junkTokens = tokens.filter((tok) => tok.length === 1 || /^[Xx×✕]$/.test(tok)).length;
    if (junkTokens >= 3 || junkTokens / tokens.length > 0.4) return true;
  }

  // Chrome private-use characters or tab favicon patterns
  if (/[\uE000-\uF8FF]{2,}/.test(t) || /{@|@y/.test(t)) return true;

  return false;
}

/**
 * Strip the browser chrome header (tab bar + address bar + toolbar) from the
 * top of an OCR result. These are the first few lines of any browser screenshot.
 *
 * Heuristic: scan from the top, skip lines that look like browser chrome
 * until we find 2 consecutive content lines — that's where the page starts.
 *
 * @param {string} text   Raw OCR or cleaned text
 * @returns {string}      Text with browser chrome header removed
 */
export function stripBrowserChromeHeader(text) {
  if (!text) return text;
  const lines = text.split(/\r?\n/);
  let startIdx = 0;
  let contentLinesSeen = 0;

  for (let i = 0; i < Math.min(lines.length, 12); i++) {
    const t = lines[i].trim();

    const isChromeLine =
      !t ||                                           // blank
      isBrowserTabBarLine(t) ||                       // tab bar
      /\b\w+\.(gov|com|org|edu|in|io|net)\b.*\//.test(t) || // address bar (URL)
      /^[^a-zA-Z0-9]{0,3}\s*[a-zA-Z]{1,3}\s*[^a-zA-Z0-9]{0,3}$/.test(t) || // short noise
      (t.length < 20 && /[\[\]{}<>@#|\\]/.test(t));  // icon/toolbar noise

    if (isChromeLine) {
      if (contentLinesSeen === 0) startIdx = i + 1; // keep moving start past chrome
    } else {
      contentLinesSeen++;
      if (contentLinesSeen >= 2) break; // found real content — stop
    }
  }

  return lines.slice(startIdx).join("\n");
}

// ─── URL cleaning ──────────────────────────────────────────────────────────────

/**
 * A URL is "meaningful" if it contains a recognisable domain name that is
 * likely the subject of the content (e.g., a news article URL, API endpoint)
 * rather than browser chrome.
 *
 * We still strip it unless it's embedded mid-sentence.
 *
 * @param {string} line
 * @returns {string}  Line with standalone URLs removed but embedded ones kept
 */
function stripStandaloneUrls(line) {
  // If the entire line is a URL, remove it
  if (/^https?:\/\/\S+$/.test(line.trim())) return "";

  // If the line is a URL with only surrounding whitespace noise, remove it
  if (/^\s*https?:\/\/\S+\s*$/.test(line)) return "";

  return line;
}

// ─── Main cleaning function ────────────────────────────────────────────────────

/**
 * Clean raw extracted text through a multi-pass pipeline.
 *
 * @param {string} rawText  Raw text from DOM, OCR, or clipboard
 * @returns {string}        Cleaned, deduped, readable text
 */
export function cleanExtractedText(rawText) {
  if (!rawText || typeof rawText !== "string") return "";

  // Split into lines
  let lines = rawText.split(/\r?\n/);

  // Pass 0: Strip browser chrome header (tab bar, address bar, toolbar)
  const deheadered = stripBrowserChromeHeader(rawText);
  lines = deheadered.split(/\r?\n/);

  // Pass 1: Strip standalone URLs
  lines = lines.map(stripStandaloneUrls);

  // Pass 2: Remove browser UI noise
  lines = lines.filter((line) => !isBrowserNoise(line));

  // Pass 3: Deduplicate (exact + normalised)
  const seenExact = new Set();
  const seenNorm  = new Set();
  lines = lines.filter((line) => {
    const exact = line.trim();
    const norm  = normaliseForDedup(exact);

    if (!norm) return false;               // empty after normalisation
    if (seenExact.has(exact)) return false; // exact duplicate
    if (seenNorm.has(norm)) return false;   // near-duplicate

    seenExact.add(exact);
    seenNorm.add(norm);
    return true;
  });

  // Pass 4: Collapse whitespace within each line
  lines = lines.map((line) =>
    line
      .replace(/[ \t]{2,}/g, " ")   // multiple spaces → single
      .replace(/^\s+|\s+$/g, "")    // trim
  );

  // Pass 5: Collapse 3+ consecutive blank lines into at most 2
  const result = [];
  let blankCount = 0;
  for (const line of lines) {
    if (line === "") {
      blankCount++;
      if (blankCount <= 1) result.push("");
    } else {
      blankCount = 0;
      result.push(line);
    }
  }

  return result.join("\n").trim();
}

/**
 * Score a block of text by how "content-rich" it is.
 * Higher = more meaningful.  Used to pick best extraction source.
 *
 * Scoring factors (each 0–1):
 *   + Line count > 5        → +0.2
 *   + Contains numbers      → +0.2
 *   + Average word length 4–10 (prose-like) → +0.2
 *   + Proper capitalisation ratio > 30%     → +0.2
 *   + Contains known content keywords       → +0.2
 *
 * @param {string} text
 * @returns {number}  0.0 – 1.0
 */
export function scoreContentQuality(text) {
  if (!text) return 0;

  const lines = text.split("\n").filter(Boolean);
  const words = text.match(/\b\w+\b/g) || [];

  let score = 0;

  // Factor 1: enough lines
  if (lines.length >= 5) score += 0.2;

  // Factor 2: contains numbers (metrics, stats)
  if (/\d/.test(text)) score += 0.2;

  // Factor 3: average word length suggests real prose
  if (words.length > 0) {
    const avgLen = words.reduce((s, w) => s + w.length, 0) / words.length;
    if (avgLen >= 3.5 && avgLen <= 10) score += 0.2;
  }

  // Factor 4: capitalisation ratio (proper nouns, headings)
  const capWords = words.filter((w) => /^[A-Z]/.test(w)).length;
  if (words.length > 0 && capWords / words.length > 0.15) score += 0.2;

  // Factor 5: content keywords
  const CONTENT_KW = /\b(total|seats?|votes?|count|result|winner|party|candidate|percentage|rank|score|attendance|report|dashboard|revenue|profit|loss|sales|users?|sessions?|metrics?|analytics?|trend|summary|overview|data|chart|table|election|constituency|district|state|region|leading|trailing|ahead|behind)\b/i;
  if (CONTENT_KW.test(text)) score += 0.2;

  return Math.min(score, 1);
}
