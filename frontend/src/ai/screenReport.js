import { askAI } from "./aiClient";
import { formatContextForPrompt } from "./smartContentDetector";

/**
 * The built-in screen report: what the screen shows, organised from the text
 * Windows OCR read. No AI, so it reports what is there rather than interpreting it.
 *
 * @param {import('./smartContentDetector').ContentContext} ctx
 * @returns {string}
 */
export function buildScreenReport(ctx) {
  const captured = new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const lines = ["Screen Report", "=============", `Captured: ${captured}`];

  if (!ctx.cleanText) {
    lines.push("", "No readable text was found on the screen.");
    return lines.join("\n");
  }

  lines.push(`Content type: ${ctx.category.label}`, `Words read: ${ctx.wordCount}`);

  const section = (title, items) => {
    if (!items.length) return;
    lines.push("", `${title}:`, ...items.map((item) => `- ${item}`));
  };
  section("Headings", ctx.headings);
  section("Key numbers", ctx.stats);
  section("Names and terms", ctx.entities.slice(0, 12));

  lines.push("", "Full text", "---------", ctx.cleanText);
  return lines.join("\n");
}

/**
 * Insights from the built-in AI: what the numbers mean and what to do next, from
 * the text OCR read.
 *
 * @param {import('./smartContentDetector').ContentContext} ctx
 * @returns {Promise<string|null>} null when there was no text or the model couldn't answer.
 */
export async function getScreenInsights(ctx) {
  if (!ctx.cleanText) return null;

  const rules = `Write 3 to 6 short insights for someone looking at this screen:
what it shows, the numbers that matter, any trend or problem, and a sensible next step.
Plain text only. One insight per line, each starting with "- ". No markdown, no headings.`;

  // A 1.5B model on a laptop CPU writes roughly 10 words a second, so allow a minute.
  const prompt = `${rules}\n\nText read from the screen:\n${formatContextForPrompt(ctx, 3000)}`;
  const text = await askAI({ prompt, maxTokens: 400 }, 60000);

  return text ? text.replace(/[*#`]/g, "").trim() : null;
}
