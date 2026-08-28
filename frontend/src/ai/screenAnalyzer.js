/**
 * screenAnalyzer.js — Smart Multi-Stage AI Pipeline (v2 Professional)
 * ──────────────────────────────────────────────────────────────────
 * Orchestrates: Capture -> Extraction -> Cleaning -> AI (with Retry) -> Fallback.
 */

import { captureScreen } from "./screenCapture";
import { extractTextFromDOM, domHasMeaningfulText } from "./textExtractor";
import { extractTextViaOCR } from "./ocrExtractor";
import { analyzeScreenWithGemini } from "./visionAnalyzer";
import { generateScreenReport } from "./aiReportGenerator";
import { generateProfessionalFallback } from "./fallbackReportGenerator";
import { scoreContentQuality } from "./contentCleaner";
import { detectContentContext } from "./smartContentDetector";
import { withRetry } from "./retryManager";
import {
  hashImage,
  isScreenUnchanged,
  setLastImageHash,
  getCachedReport,
  setCachedReport,
  isOnCooldown,
  cooldownRemainingSeconds,
  recordGeminiCall,
} from "./cacheManager";

const MIN_EXTRACTED_CHARS = 60;
const MIN_QUALITY_SCORE = 0.1;

export async function analyzeCurrentScreen(opts = {}) {
  // 1. Capture
  const base64Jpeg = await captureScreen();
  const imageHash = await hashImage(base64Jpeg);

  // 2. Cache Check
  if (imageHash && isScreenUnchanged(imageHash)) {
    const cached = getCachedReport(imageHash);
    if (cached) return { report: cached, source: "cache" };
  }

  // 3. Cooldown Guard
  if (isOnCooldown()) {
    const secs = cooldownRemainingSeconds();
    console.info(`[screenAnalyzer] ⏳ On cooldown — ${secs}s remaining`);

    // Use cached if available
    if (imageHash) {
      const anyCached = getCachedReport(imageHash);
      if (anyCached) return { report: anyCached, source: "cache" };
    }

    // Otherwise generate professional fallback
    const ctx = detectContentContext(extractedText || "System state check");
    return { 
      report: generateProfessionalFallback(ctx), 
      source: "cache" 
    };
  }

  // 4 & 5. Extraction (DOM or OCR)
  let extractedText = null;
  let source = "none";

  // Try DOM
  if (domHasMeaningfulText()) {
    try {
      const domText = await extractTextFromDOM(opts.clipboardText);
      if (domText && scoreContentQuality(domText) >= MIN_QUALITY_SCORE) {
        extractedText = domText;
        source = "dom";
      }
    } catch (e) { console.warn("[screenAnalyzer] DOM extraction failed", e); }
  }

  // Try OCR if DOM failed
  if (!extractedText) {
    try {
      const ocrText = await extractTextViaOCR(base64Jpeg);
      if (ocrText && scoreContentQuality(ocrText) >= MIN_QUALITY_SCORE) {
        extractedText = ocrText;
        source = "ocr";
      }
    } catch (e) { console.warn("[screenAnalyzer] OCR extraction failed", e); }
  }

  let finalReport = null;

  // 6. AI Attempt (with Retry)
  if (extractedText) {
    try {
      console.info("[screenAnalyzer] Attempting AI Text Analysis...");
      recordGeminiCall();
      finalReport = await withRetry(() => generateScreenReport(extractedText), 1, 1200);
    } catch (e) {
      console.warn("[screenAnalyzer] AI Text Analysis failed after retries", e);
    }
  }

  // 7. Vision Fallback (only if text AI failed or no text found)
  if (!finalReport) {
    try {
      console.info("[screenAnalyzer] Attempting Gemini Vision Fallback...");
      recordGeminiCall();
      finalReport = await withRetry(() => analyzeScreenWithGemini(base64Jpeg), 1, 1500);
      source = "vision";
    } catch (e) {
      console.error("[screenAnalyzer] Vision analysis failed after retries", e);
    }
  }

  // 8. Professional Fallback (Local Intelligence)
  if (!finalReport) {
    console.info("[screenAnalyzer] All AI attempts failed. Generating professional fallback...");
    const ctx = detectContentContext(extractedText || "No readable content found.");
    finalReport = generateProfessionalFallback(ctx);
    // source remains the extraction source
  }

  // Cache and Return
  if (imageHash && finalReport) {
    setLastImageHash(imageHash);
    setCachedReport(imageHash, finalReport);
  }

  return { report: finalReport, source };
}
