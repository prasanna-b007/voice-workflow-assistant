/**
 * fallbackReportGenerator.js
 * ──────────────────────────
 * Generates a professional, human-readable report when AI is unavailable.
 * 
 * STRICT RULES:
 * - NO raw extraction dumps
 * - NO OCR garbage or corrupted encoding
 * - NO browser UI text or URLs
 * - NO technical statistics (word counts, confidence scores)
 * - NO debugging details
 * 
 * Goal: Produce a report that feels intelligent and polished even without AI.
 */

/**
 * Build a professional fallback report based on detected context.
 * 
 * @param {import('./smartContentDetector').ContentContext} ctx
 * @returns {string}
 */
export function generateProfessionalFallback(ctx) {
  const { category, entities, headings } = ctx;
  const now = new Date().toLocaleString();

  // Curate "Detected Information" items from headings and entities
  // Filter out any noisy/short tokens
  const infoItems = [
    ...headings,
    ...entities.filter(e => e.length > 4)
  ]
  .filter(item => {
    // Basic noise filter for info items
    const lower = item.toLowerCase();
    return !lower.includes("sonix") && 
           !lower.includes("overview") && 
           !lower.includes("dashboard") && 
           !lower.includes("refresh") &&
           !lower.includes("hindi");
  })
  .slice(0, 6);

  // Add the category label if we have enough items
  if (category.label && !infoItems.includes(category.label)) {
    infoItems.unshift(`${category.label} data`);
  }

  const lines = [
    "Screen Analysis Report",
    "======================",
    "",
    "Summary:",
    `The current screen appears to display ${category.label.toLowerCase()} content.`,
    "",
    "Detected Information:"
  ];

  if (infoItems.length > 0) {
    infoItems.forEach(item => lines.push(`- ${item}`));
  } else {
    lines.push("- Visual content and structured data");
  }

  lines.push(
    "",
    "Recommendations:",
    "- Retry detailed AI analysis later.",
    `- Monitor updated ${category.label.toLowerCase()} trends for changes.`,
    "",
    "Warnings:",
    "- Advanced AI analysis is temporarily unavailable.",
    "- Current report is based on cleaned extracted content."
  );

  return lines.join("\n");
}
