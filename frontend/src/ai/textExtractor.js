/**
 * textExtractor.js
 * ────────────────
 * Stage 2a — Lightweight DOM / Clipboard extraction.
 *
 * Attempts to pull meaningful text from the CURRENT PAGE'S DOM (works when
 * the screen is a web-based dashboard, SPA, or any Sonix web-view) and from
 * the system clipboard (catches whatever the user last copied — useful for
 * spreadsheets, PDFs opened in browsers, etc.).
 *
 * Now includes Stage 3 (encoding fix) and Stage 4 (content clean) inline
 * so the text returned is already clean before hitting the report generator.
 *
 * Returns a compact, de-duplicated, token-light summary string.
 * Returns null if nothing meaningful was found (caller falls through to OCR).
 *
 * NO network calls.  NO Gemini usage.  Zero tokens.
 */

import { fixEncoding } from "./encodingFixer";
import { cleanExtractedText, scoreContentQuality } from "./contentCleaner";

/** Minimum characters we consider "enough" text to skip Vision. */
const MIN_USEFUL_CHARS = 80;

/** Maximum characters we'll ever forward to Gemini text API. */
const MAX_FORWARD_CHARS = 3000;

// ─── DOM extraction helpers ───────────────────────────────────────────────────

/**
 * Clean a single DOM-extracted string:
 *  1. Fix encoding (Stage 3)
 *  2. Collapse internal whitespace
 *  3. Trim
 *
 * @param {string} raw
 * @returns {string}
 */
function cleanDOMString(raw) {
  if (!raw) return "";
  return fixEncoding(raw.replace(/\s+/g, " ").trim());
}

/**
 * Extract a compact summary of useful text from the DOM.
 *
 * Priority:
 *   1. <title>, <h1>–<h3> headings
 *   2. Metric-card / stat elements (elements with data-metric, .metric,
 *      .stat, .kpi, .card, .badge, .value, .count classes)
 *   3. <table> cells (first 8 rows × 8 cols to stay lean)
 *   4. <p>, <li> text (top 20, truncated)
 *   5. Clipboard text as fallback
 *
 * @param {string|null} clipboardText   Pre-fetched clipboard string (may be null)
 * @returns {string|null}               Compact text summary or null
 */
export async function extractTextFromDOM(clipboardText = null) {
  const parts = [];

  try {
    // 1. Page title
    if (document.title) {
      const title = cleanDOMString(document.title);
      if (title) parts.push(`Page: ${title}`);
    }

    // 2. Headings (h1–h3)
    const headings = [...document.querySelectorAll("h1, h2, h3")]
      .map((el) => cleanDOMString(el.innerText))
      .filter(Boolean)
      .slice(0, 6);
    if (headings.length) parts.push("Headings:\n" + headings.map((h) => `- ${h}`).join("\n"));

    // 3. Metric / stat / KPI cards  (common class patterns across frameworks)
    const metricSelectors = [
      "[data-metric]", "[data-stat]", "[data-value]",
      ".metric", ".stat", ".kpi", ".card-value", ".card-stat",
      ".badge", ".value", ".count", ".number",
      ".dashboard-card", ".summary-card", ".info-card",
    ].join(", ");

    const metricEls = [...document.querySelectorAll(metricSelectors)]
      .map((el) => cleanDOMString(el.innerText))
      .filter((t) => t && t.length > 0 && t.length < 120)
      .slice(0, 20);
    if (metricEls.length) parts.push("Metrics:\n" + metricEls.map((m) => `- ${m}`).join("\n"));

    // 4. Tables — first 8 rows, first 8 columns
    const tables = [...document.querySelectorAll("table")].slice(0, 3);
    for (const table of tables) {
      const caption = cleanDOMString(table.caption?.innerText || "");
      const rows = [...table.querySelectorAll("tr")].slice(0, 8);
      const lines = rows.map((row) =>
        [...row.querySelectorAll("th, td")]
          .slice(0, 8)
          .map((cell) => cleanDOMString(cell.innerText))
          .filter(Boolean)
          .join(" | ")
      ).filter(Boolean);
      if (lines.length) {
        parts.push(`Table${caption ? ` (${caption})` : ""}:\n` + lines.join("\n"));
      }
    }

    // 5. Paragraph / list text (top 20 lines, short)
    const bodyLines = [...document.querySelectorAll("p, li")]
      .map((el) => cleanDOMString(el.innerText))
      .filter((t) => t && t.length > 10 && t.length < 200)
      .slice(0, 20);
    if (bodyLines.length) parts.push("Content:\n" + bodyLines.map((l) => `- ${l}`).join("\n"));

  } catch (e) {
    console.warn("[textExtractor] DOM extraction error:", e);
  }

  // 6. Clipboard fallback
  if (clipboardText && clipboardText.trim().length > MIN_USEFUL_CHARS) {
    const cleaned = fixEncoding(clipboardText.trim()).slice(0, 1500);
    parts.push(`Clipboard:\n${cleaned}`);
  }

  if (!parts.length) return null;

  // Combine all parts
  let combined = parts.join("\n\n").trim();
  if (combined.length < MIN_USEFUL_CHARS) return null;

  // Stage 4: Content cleaning — remove browser noise, deduplicate
  combined = cleanExtractedText(combined);
  if (!combined || combined.length < MIN_USEFUL_CHARS) return null;

  // Quality gate
  const quality = scoreContentQuality(combined);
  if (quality < 0.05) {
    console.info("[textExtractor] DOM extraction quality too low — rejecting");
    return null;
  }

  // Truncate to token budget
  return combined.slice(0, MAX_FORWARD_CHARS);
}

/**
 * Quick check: does the DOM contain enough meaningful text to be useful?
 * Used by screenAnalyzer to decide which extraction path to take.
 *
 * @returns {boolean}
 */
export function domHasMeaningfulText() {
  try {
    const body = document.body?.innerText?.trim() || "";
    // Strip whitespace runs and check raw length
    return body.replace(/\s+/g, " ").length > MIN_USEFUL_CHARS;
  } catch {
    return false;
  }
}
