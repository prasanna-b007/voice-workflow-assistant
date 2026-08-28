/**
 * encodingFixer.js
 * ─────────────────
 * Stage 3 — Encoding Fix System.
 *
 * Repairs corrupted characters that result from double-encoding UTF-8 text
 * as Latin-1 (the classic "mojibake" problem seen in OCR / clipboard output).
 *
 * Examples of BAD input this module corrects:
 *   Â©     → ©
 *   â€"    → —
 *   â‚¬    → €
 *   Ã©     → é
 *   â€˜    → '
 *   â€™    → '
 *   â€œ    → "
 *   â€     → "
 *
 * This happens when:
 *   - UTF-8 bytes are interpreted as Windows-1252 / ISO-8859-1
 *   - OCR engines misread multi-byte sequences
 *   - Copy-paste from browser mangles encoding
 */

// ─── Mojibake repair map (most common culprits first) ─────────────────────────
const MOJIBAKE_MAP = [
  // Smart quotes
  [/â€œ/g, "\u201C"],  // "
  [/â€/g,  "\u201D"],  // " (must come after â€œ)
  [/â€˜/g, "\u2018"],  // '
  [/â€™/g, "\u2019"],  // '

  // Dashes
  [/â€"/g, "\u2013"],  // – (en dash)
  [/â€"/g, "\u2014"],  // — (em dash)
  [/â€"/g, "\u2014"],  // — fallback

  // Currency / symbols
  [/â‚¬/g, "\u20AC"],  // €
  [/Â£/g,  "\u00A3"],  // £
  [/Â¥/g,  "\u00A5"],  // ¥
  [/Â©/g,  "\u00A9"],  // ©
  [/Â®/g,  "\u00AE"],  // ®
  [/â„¢/g, "\u2122"],  // ™

  // Accented Latin characters (common)
  [/Ã©/g,  "\u00E9"],  // é
  [/Ã¨/g,  "\u00E8"],  // è
  [/Ã /g,  "\u00E0"],  // à
  [/Ã¢/g,  "\u00E2"],  // â
  [/Ã®/g,  "\u00EE"],  // î
  [/Ã´/g,  "\u00F4"],  // ô
  [/Ã»/g,  "\u00FB"],  // û
  [/Ã«/g,  "\u00EB"],  // ë
  [/Ã¯/g,  "\u00EF"],  // ï
  [/Ã¼/g,  "\u00FC"],  // ü
  [/Ã¶/g,  "\u00F6"],  // ö
  [/Ã¤/g,  "\u00E4"],  // ä
  [/Ã±/g,  "\u00F1"],  // ñ
  [/Ã§/g,  "\u00E7"],  // ç

  // Uppercase accented
  [/Ã‰/g,  "\u00C9"],  // É
  [/Ãˆ/g,  "\u00C8"],  // È
  [/Ã€/g,  "\u00C0"],  // À
  [/Ã/g,   "\u00C2"],  // Â (careful — must be after specific Ã patterns)

  // Ellipsis / misc
  [/â€¦/g, "\u2026"],  // …
  [/Â·/g,  "\u00B7"],  // ·
  [/Â°/g,  "\u00B0"],  // °
  [/Â½/g,  "\u00BD"],  // ½
  [/Â¼/g,  "\u00BC"],  // ¼
  [/Â¾/g,  "\u00BE"],  // ¾

  // Stray lone Â (after all specific Â patterns resolved)
  [/Â\s*/g, ""],
];

// Characters that are visually meaningless after repair
// Matching control characters is the entire point of this pattern.
// eslint-disable-next-line no-control-regex
const NOISE_PATTERN = /[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F]/g;

/**
 * Attempt TextDecoder-based mojibake repair.
 * This catches double-encoded UTF-8 by re-encoding to Latin-1 bytes then
 * decoding as UTF-8.
 *
 * @param {string} str
 * @returns {string}
 */
function tryDecoderRepair(str) {
  try {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      bytes[i] = str.charCodeAt(i) & 0xFF;
    }
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    // Only use decoded version if it has fewer replacement characters
    const origBad = (str.match(/[\uFFFD\u00C2-\u00C3]/g) || []).length;
    const newBad  = (decoded.match(/[\uFFFD]/g) || []).length;
    return origBad > newBad ? decoded : str;
  } catch {
    return str;
  }
}

/**
 * Apply the mojibake substitution map.
 * @param {string} str
 * @returns {string}
 */
function applyMojibakeMap(str) {
  let result = str;
  for (const [pattern, replacement] of MOJIBAKE_MAP) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Normalize unicode: NFC form, strip control characters.
 * @param {string} str
 * @returns {string}
 */
function normalizeUnicode(str) {
  try {
    return str.normalize("NFC").replace(NOISE_PATTERN, "");
  } catch {
    return str.replace(NOISE_PATTERN, "");
  }
}

/**
 * Fix encoding issues in extracted text.
 *
 * Pipeline:
 *   1. TextDecoder-based mojibake repair (catches systematic double-encoding)
 *   2. Substitution map repair (catches residual mojibake)
 *   3. Unicode normalization + control-character strip
 *
 * @param {string} text  Raw extracted text (possibly mojibake-corrupted)
 * @returns {string}     Cleaned, human-readable text
 */
export function fixEncoding(text) {
  if (!text || typeof text !== "string") return "";

  let result = text;

  // Step 1: try systematic decoder repair
  result = tryDecoderRepair(result);

  // Step 2: apply mojibake substitution map
  result = applyMojibakeMap(result);

  // Step 3: normalize unicode and strip noise characters
  result = normalizeUnicode(result);

  return result;
}

/**
 * Quick heuristic: does the string look mojibake-corrupted?
 * Checks for the most common double-encoded byte patterns.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasMojibake(text) {
  if (!text) return false;
  return /Â[£©®°¼½¾·]|â€[""''–—¦]|â‚¬|Ã[©¨àâîôûëïüöäñç]|â„¢|â€¦/i.test(text);
}
