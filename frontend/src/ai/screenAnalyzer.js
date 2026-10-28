/**
 * screenAnalyzer.js
 * ─────────────────
 * Capture → Windows OCR → built-in report → insights from the built-in AI model.
 * Everything runs offline. The report always works; the insights section is added
 * when the model is downloaded and the PC can run it.
 */

import { invoke } from "@tauri-apps/api/core";
import { captureScreen } from "./screenCapture";
import { cleanExtractedText } from "./contentCleaner";
import { detectContentContext } from "./smartContentDetector";
import { buildScreenReport, getScreenInsights } from "./screenReport";
import { hashImage, isScreenUnchanged, setLastImageHash, getCachedReport, setCachedReport } from "./cacheManager";

/** Text on the screenshot, cleaned of browser chrome and duplicates; "" if none. */
async function readScreenText(imageBase64) {
  try {
    const raw = await invoke("ocr_image", { image: imageBase64 });
    if (!raw?.trim()) return "";
    // The cleaner can drop everything on a sparse screen; the raw text beats nothing.
    return cleanExtractedText(raw) || raw.trim();
  } catch (e) {
    console.warn("[screenAnalyzer] OCR failed:", e);
    return "";
  }
}

/**
 * @returns {Promise<{ report: string, foundText: boolean, hasInsights: boolean }>}
 */
export async function analyzeCurrentScreen() {
  const image = await captureScreen();

  // Same screen as a moment ago: reuse that report.
  const imageHash = await hashImage(image);
  if (imageHash && isScreenUnchanged(imageHash)) {
    const cached = getCachedReport(imageHash);
    if (cached) return cached;
  }

  const text = await readScreenText(image);
  const ctx = detectContentContext(text);
  let report = buildScreenReport(ctx);

  const insights = await getScreenInsights(ctx);
  if (insights) report += `\n\nAI Insights\n-----------\n${insights}`;

  const result = { report, foundText: Boolean(text), hasInsights: Boolean(insights) };
  if (imageHash) {
    setLastImageHash(imageHash);
    setCachedReport(imageHash, result);
  }
  return result;
}
