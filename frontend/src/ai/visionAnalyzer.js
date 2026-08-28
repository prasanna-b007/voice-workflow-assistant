/**
 * visionAnalyzer.js
 * ─────────────────
 * Stage 2c — Gemini Vision (LAST RESORT).
 *
 * Called ONLY when DOM extraction AND OCR both failed to yield enough text
 * (e.g. chart-heavy dashboards, image-only screens, non-Latin text).
 *
 * Improvements in this version:
 *   • Stricter prompt — explicitly tells Gemini to avoid browser UI noise
 *   • Explicit encoding instruction — Gemini must output clean UTF-8 prose
 *   • Better structured output format
 *   • maxOutputTokens capped at 900
 *   • temperature = 0.2 (lower = more deterministic, less hallucination)
 */

import { fixEncoding } from "./encodingFixer";

/** Vision prompt — concise and explicit about what to ignore. */
const VISION_PROMPT = `You are an expert screen analyst. Analyze this screenshot and write a professional report.

STRICT RULES:
- Output ONLY clean UTF-8 text. No special characters. No markdown formatting.
- IGNORE browser toolbars, tabs, address bars, bookmarks, and extension icons.
- IGNORE navigation menus, scrollbars, OS taskbars, and window controls.
- FOCUS ONLY on the main content area of the screen.
- Do NOT invent data. Only report what is visible.
- Do NOT use bullet symbols like •, ▸, ►. Use a plain hyphen - instead.
- Keep the report concise and professional.

Output format (exactly):

Screen Analysis Report
======================
Generated: [write today's date and time]

Summary:
[1-3 sentences describing the main content of the screen]

Key Insights:
- [insight about the main visible content]
- [second insight]
- [third insight if relevant]

Recommendations:
- [actionable recommendation based on what is visible]
- [second recommendation]

Warnings:
- [warning if something looks critical or unusual, otherwise write "None"]`;

/**
 * Analyze a screenshot with Gemini Vision and return a structured report.
 *
 * @param {string} base64Jpeg  Raw base64 JPEG (no data: prefix)
 * @returns {Promise<string>}  Plain-text report (clean UTF-8)
 */
export async function analyzeScreenWithGemini(base64Jpeg) {
  const API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
  if (!API_KEY) throw new Error("Missing VITE_GEMINI_API_KEY.");

  const body = {
    contents: [
      {
        parts: [
          { text: VISION_PROMPT },
          {
            inlineData: {
              mimeType: "image/jpeg",
              // Strip any stray line-break escape sequences from the base64 string
              data: base64Jpeg.replace(/[\r\n]/g, ""),
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 900,
    },
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );

  let json;
  try { json = await res.json(); }
  catch { throw new Error(`Vision API HTTP ${res.status}: ${res.statusText}`); }

  if (json?.error) {
    const msg = json.error.message || "";
    // Throw so the orchestrator can trigger the professional fallback
    throw new Error(msg || "Gemini Vision error");
  }

  const raw = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!raw) throw new Error("Empty Vision response");

  // Apply encoding fix to the vision output as a safety net
  return fixEncoding(raw);
}
