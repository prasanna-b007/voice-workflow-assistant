/**
 * ocrExtractor.js
 * ───────────────
 * Stage 2b — Client-side OCR using Tesseract.js.
 *
 * Used when:
 *   - DOM extraction returns insufficient text (non-HTML screen content)
 *   - The screen shows a desktop app, PDF viewer, or image-heavy page
 *
 * Now includes Stage 3 (encoding fix) and Stage 4 (content clean) inline
 * so the text returned is already clean before hitting the report generator.
 *
 * Returns compact, cleaned extracted text, or null if OCR yields nothing useful.
 * Avoids Gemini Vision entirely when OCR succeeds.
 *
 * Tesseract.js is loaded lazily (dynamic import) so it doesn't inflate
 * the initial bundle for users who never trigger screen analysis.
 */

import { fixEncoding } from "./encodingFixer";
import { cleanExtractedText, scoreContentQuality } from "./contentCleaner";

/** Minimum character count for OCR output to be considered "useful". */
const MIN_OCR_CHARS = 60;

/** Maximum characters forwarded to the report generator. */
const MAX_OCR_CHARS = 3000;

/** Shared Tesseract worker — created once, reused across calls. */
let _worker = null;
let _workerReady = false;

/**
 * Initialise (or reuse) the Tesseract worker.
 * @returns {Promise<import('tesseract.js').Worker>}
 */
async function getWorker() {
  if (_worker && _workerReady) return _worker;

  // Dynamic import keeps Tesseract out of the main bundle
  const { createWorker } = await import("tesseract.js");

  _worker = await createWorker("eng", 1, {
    // Suppress verbose Tesseract console output
    logger: () => {},
  });
  _workerReady = true;
  return _worker;
}

/**
 * Run OCR on a base64 JPEG and return compact, cleaned extracted text.
 *
 * Pipeline:
 *   1. Tesseract OCR recognition
 *   2. Raw artefact cleanup (form feeds, whitespace runs)
 *   3. Encoding fix (Stage 3) — repairs mojibake / double-encoded UTF-8
 *   4. Content clean (Stage 4) — removes browser UI noise, deduplicates
 *   5. Quality score check — rejects low-quality output
 *
 * @param {string} base64Jpeg   Raw base64 JPEG (no data: prefix)
 * @returns {Promise<string|null>}  Cleaned OCR text, or null if insufficient
 */
export async function extractTextViaOCR(base64Jpeg) {
  try {
    const worker = await getWorker();

    // Tesseract accepts data-URI images
    const dataUri = `data:image/jpeg;base64,${base64Jpeg}`;
    const { data } = await worker.recognize(dataUri);

    const raw = data?.text?.trim() || "";
    if (!raw || raw.length < MIN_OCR_CHARS) return null;

    // Step 1: Basic artefact cleanup
    let cleaned = raw
      .replace(/\f/g, "\n")           // form feeds → newlines
      .replace(/[ \t]{3,}/g, "  ")   // runs of spaces → double space
      .replace(/\n{3,}/g, "\n\n")    // 3+ blank lines → one
      .trim();

    // Step 2: Fix encoding issues (Stage 3)
    cleaned = fixEncoding(cleaned);

    // Step 3: Content cleaning — remove browser noise, deduplicate (Stage 4)
    cleaned = cleanExtractedText(cleaned);

    if (!cleaned || cleaned.length < MIN_OCR_CHARS) return null;

    // Step 4: Quality gate — reject if mostly noise even after cleaning
    const quality = scoreContentQuality(cleaned);
    if (quality < 0.1) {
      console.info("[ocrExtractor] OCR quality score too low — rejecting");
      return null;
    }

    console.info(`[ocrExtractor] OCR quality score: ${quality.toFixed(2)}`);

    return cleaned.slice(0, MAX_OCR_CHARS);
  } catch (err) {
    console.warn("[ocrExtractor] OCR failed:", err);
    return null;
  }
}

/** Terminate the worker to free memory (call on app unmount). */
export async function terminateOCRWorker() {
  if (_worker) {
    try { await _worker.terminate(); } catch { /* ignore */ }
    _worker = null;
    _workerReady = false;
  }
}
