/**
 * aiReportGenerator.js
 * ─────────────────────
 * Generates AI reports from extracted text context using Gemini 1.5 Flash.
 *
 * This module is strictly responsible for AI interaction. 
 * Fallback generation is handled by fallbackReportGenerator.js.
 */

import { detectContentContext, formatContextForPrompt } from "./smartContentDetector";

// ─── Shared Gemini text helper ────────────────────────────────────────────────

async function callGeminiText(prompt, maxTokens = 1800) {
  const API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
  if (!API_KEY) return null;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens },
      }),
    }
  );

  const data = await res.json();
  if (data?.error) throw new Error(data.error.message || "Gemini text error");

  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
}

// ─── Context-aware prompt builder ─────────────────────────────────────────────

const CATEGORY_INSTRUCTIONS = {
  election_results: `
You are analyzing LIVE ELECTION RESULTS. Be thorough and detailed.
Extract and report ALL parties, seat counts (Won/Leading/Total), and majority calculations.`,

  student_dashboard: `
You are analyzing a STUDENT PERFORMANCE DASHBOARD.
Extract and report overall attendance, subject-wise breakdown, and GPA/grades.`,

  analytics_dashboard: `
You are analyzing an ANALYTICS DASHBOARD.
Extract and report KPIs like Users, Sessions, Revenue, and Trends.`,

  business_report: `
You are analyzing a BUSINESS REPORT.
Extract and report Revenue, Profit/Loss, and quarterly comparisons.`,

  data_table: `
You are analyzing a DATA TABLE.
Extract and report all column headers and representative data rows.`,
};

const DEFAULT_INSTRUCTIONS = `
You are analyzing a SCREEN CAPTURE.
Extract and report all headings, metrics, and visible statistics.`;

function buildDetailedPrompt(ctx) {
  const { category } = ctx;
  const instructions = CATEGORY_INSTRUCTIONS[category.id] || DEFAULT_INSTRUCTIONS;
  const formattedContext = formatContextForPrompt(ctx, 3500);

  return `You are Sonix, an expert AI screen analyst. Produce a DETAILED, PROFESSIONAL report.

STRICT RULES:
- Output ONLY clean plain text. No markdown symbols like ** or ##.
- Use plain hyphens - for bullet points.
- List every significant data point found in the content.
- Be detailed. A brief summary is not acceptable.
${instructions}

Output format:

Screen Analysis Report
======================

Summary:
[2-4 sentences describing the source and current state]

Key Insights:
- [data point with numbers]
- [data point with numbers]

Analysis:
- [interpretation of trends and gaps]

Recommendations:
- [actionable next steps]

Warnings:
- [any provisional data flags or "None"]

---
Extracted Screen Content:
${formattedContext}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function generateDashboardReport(dashboardData) {
  const API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
  if (!API_KEY) return null;

  const prompt = `Generate a detailed dashboard report. 
Include: Summary, Key Metrics, Insights, Recommendations, Warnings.
Data: ${JSON.stringify(dashboardData)}`;

  try {
    return await callGeminiText(prompt, 1200);
  } catch (err) {
    console.error("[aiReportGenerator] Dashboard report failed:", err);
    return null;
  }
}

/**
 * Generate a detailed report from text.
 * Returns null on any failure to signal the orchestrator to try fallback.
 */
export async function generateScreenReport(textContext) {
  const API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
  if (!API_KEY) return null;

  const ctx = detectContentContext(textContext);
  const prompt = buildDetailedPrompt(ctx);

  try {
    const report = await callGeminiText(prompt, 1800);
    return report || null;
  } catch (err) {
    console.error("[aiReportGenerator] Screen report failed:", err);
    return null;
  }
}
