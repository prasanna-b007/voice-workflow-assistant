/**
 * cacheManager.js
 * ───────────────
 * Provides three complementary token-saving mechanisms:
 *
 *  1. Result Cache  – stores the last N (hash → report) pairs with a TTL.
 *                     Identical screen content reuses the cached report.
 *
 *  2. Cooldown Guard – prevents hammering Gemini within a minimum interval
 *                      regardless of content change.
 *
 *  3. Image Hashing  – lightweight 64-bit perceptual hash so we can detect
 *                      whether the screen actually changed without sending
 *                      the whole image anywhere.
 */

// ─── Configuration ────────────────────────────────────────────────────────────

/** Maximum age of a cached report (ms). Default: 2 minutes. */
const CACHE_TTL_MS = 2 * 60 * 1000;

/** Minimum time between ANY Gemini Vision/Text calls (ms). Default: 20 s. */
const COOLDOWN_MS = 20_000;

/** Maximum number of entries kept in the in-memory LRU cache. */
const MAX_CACHE_SIZE = 10;

// ─── Internal State ───────────────────────────────────────────────────────────

/** @type {Map<string, { report: string, ts: number }>} */
const _cache = new Map();

let _lastCallTs = 0;      // timestamp of the last Gemini call
let _lastImageHash = "";  // perceptual hash of the last captured image

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compute a fast, cheap perceptual hash of a base64-encoded JPEG.
 *
 * Strategy: decode a tiny 8×8 greyscale thumbnail from the raw base64 stream
 * using the browser's Canvas API, then compare each pixel to the row average
 * to produce a 64-bit binary hash string.
 *
 * This runs entirely in the JS engine — no network, no Gemini.
 *
 * @param {string} base64Jpeg  Raw base64 JPEG string (no data: prefix)
 * @returns {Promise<string>}  64-character binary hash string
 */
export async function hashImage(base64Jpeg) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        const THUMB = 8;
        const canvas = document.createElement("canvas");
        canvas.width = THUMB;
        canvas.height = THUMB;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, THUMB, THUMB);
        const { data } = ctx.getImageData(0, 0, THUMB, THUMB);

        // Convert RGBA to greyscale luminance values
        const pixels = [];
        for (let i = 0; i < data.length; i += 4) {
          pixels.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
        }

        // Average luminance per row, then build bit string
        let hash = "";
        for (let row = 0; row < THUMB; row++) {
          const rowPixels = pixels.slice(row * THUMB, (row + 1) * THUMB);
          const avg = rowPixels.reduce((s, v) => s + v, 0) / THUMB;
          rowPixels.forEach((p) => (hash += p >= avg ? "1" : "0"));
        }

        resolve(hash);
      };
      img.onerror = () => resolve(""); // hash failure → treat as changed
      img.src = `data:image/jpeg;base64,${base64Jpeg}`;
    } catch {
      resolve("");
    }
  });
}

/**
 * Check whether the screen image is considered "the same" as the last one.
 * Updates the stored hash if different.
 *
 * @param {string} newHash  Hash produced by hashImage()
 * @returns {boolean}  true if screen is effectively unchanged
 */
export function isScreenUnchanged(newHash) {
  if (!newHash || !_lastImageHash) return false;

  // Hamming distance between two 64-bit binary strings.
  // ≤ 10 differing bits (out of 64) → "same" screen.
  let diff = 0;
  for (let i = 0; i < _lastImageHash.length; i++) {
    if (_lastImageHash[i] !== newHash[i]) diff++;
  }
  return diff <= 10;
}

/** Store the hash of the most recently processed image. */
export function setLastImageHash(hash) {
  _lastImageHash = hash;
}

/**
 * Retrieve a cached report for the given content hash.
 * Returns null if not found or expired.
 *
 * @param {string} key
 * @returns {string|null}
 */
export function getCachedReport(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  // Refresh position (LRU touch)
  _cache.delete(key);
  _cache.set(key, entry);
  return entry.report;
}

/**
 * Store a generated report keyed by content hash.
 *
 * @param {string} key
 * @param {string} report
 */
export function setCachedReport(key, report) {
  // Evict oldest entry if at capacity
  if (_cache.size >= MAX_CACHE_SIZE) {
    const oldestKey = _cache.keys().next().value;
    _cache.delete(oldestKey);
  }
  _cache.set(key, { report, ts: Date.now() });
}

/**
 * Returns true if Gemini was called too recently (within COOLDOWN_MS).
 */
export function isOnCooldown() {
  return Date.now() - _lastCallTs < COOLDOWN_MS;
}

/** Record that a Gemini call was just made. */
export function recordGeminiCall() {
  _lastCallTs = Date.now();
}

/** Remaining cooldown in seconds (0 if not on cooldown). */
export function cooldownRemainingSeconds() {
  const remaining = COOLDOWN_MS - (Date.now() - _lastCallTs);
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

/** Clear everything — useful in tests or on explicit user reset. */
export function clearCache() {
  _cache.clear();
  _lastCallTs = 0;
  _lastImageHash = "";
}
