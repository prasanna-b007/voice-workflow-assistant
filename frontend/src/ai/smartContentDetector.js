/**
 * smartContentDetector.js
 * ────────────────────────
 * Stage 5 — Smart Content Detection & Entity Extraction.
 *
 * Analyses cleaned text to automatically detect the type of content on screen
 * and extract the most relevant entities, metrics, and facts.
 *
 * Detected content categories:
 *   - election_results      → party names, seat counts, constituency data
 *   - student_dashboard     → attendance %, grades, course names
 *   - analytics_dashboard   → KPIs, sessions, revenue, conversion rates
 *   - business_report       → revenue, profit, sales figures
 *   - data_table            → generic tabular data
 *   - news_article          → headline, summary
 *   - code_screen           → programming language, function names
 *   - document              → headings, body text
 *   - unknown               → generic fallback
 *
 * Returns a structured ContentContext object that the screen report is built from.
 */

// ─── Category detection rules ─────────────────────────────────────────────────

const CATEGORY_RULES = [
  {
    id: "election_results",
    label: "Election Results",
    keywords: [
      /\b(election|constituency|seats?|votes?|candidate|party|polling|ballot|result|won|lost|leading|trailing|majority|alliance|coalition|bjp|congress|dmk|admk|tvk|aiadmk|sp|bsp|tmc|aam aadmi|nda|uda|india alliance|ecinet|eci|assembly|lok sabha|rajya sabha|general election|trends)\b/i,
    ],
    minMatches: 2,
  },
  {
    id: "student_dashboard",
    label: "Student Dashboard",
    keywords: [
      /\b(attendance|student|course|grade|marks?|gpa|cgpa|credit|semester|exam|assignment|submission|faculty|department|college|university|enroll|enrolled|present|absent|internal|external)\b/i,
    ],
    minMatches: 2,
  },
  {
    id: "analytics_dashboard",
    label: "Analytics Dashboard",
    keywords: [
      /\b(sessions?|users?|pageviews?|bounce rate|conversion|revenue|dau|mau|retention|funnel|acquisition|click|impressions?|ctr|cpc|roas|roi|kpi|metric|dashboard|analytics|traffic|source|medium|campaign)\b/i,
    ],
    minMatches: 2,
  },
  {
    id: "business_report",
    label: "Business Report",
    keywords: [
      /\b(revenue|profit|loss|sales|quarterly|annual|ytd|q[1-4]|fy\d{2,4}|ebitda|margin|forecast|target|budget|cost|expense|income|balance sheet|invoice)\b/i,
    ],
    minMatches: 2,
  },
  {
    id: "data_table",
    label: "Data Table",
    keywords: [
      /\|/,
      /\b(total|subtotal|grand total|sum|average|mean|count|min|max|range)\b/i,
    ],
    minMatches: 2,
  },
  {
    id: "news_article",
    label: "News Article",
    keywords: [
      /\b(says?|said|according to|reported|announced|confirmed|breaking|latest|update|minister|government|parliament|court|verdict|accused)\b/i,
    ],
    minMatches: 3,
  },
  {
    id: "code_screen",
    label: "Code / IDE",
    keywords: [
      /\b(function|const|let|var|import|export|return|class|def|if\s*\(|for\s*\(|while\s*\(|async|await|=>|null|undefined|true|false)\b/,
      /[{}()[\];]/,
    ],
    minMatches: 2,
  },
];

/**
 * Detect the content category of the cleaned text.
 *
 * @param {string} text  Cleaned text
 * @returns {{ id: string, label: string, confidence: number }}
 */
export function detectContentCategory(text) {
  if (!text) return { id: "unknown", label: "Unknown", confidence: 0 };

  const scores = CATEGORY_RULES.map((rule) => {
    const matches = rule.keywords.reduce((count, kw) => {
      const m = text.match(kw);
      return count + (m ? m.length : 0);
    }, 0);
    const confidence = Math.min(matches / (rule.minMatches * 2), 1);
    return { ...rule, matches, confidence };
  });

  scores.sort((a, b) => b.confidence - a.confidence);

  const best = scores[0];
  if (best.confidence < 0.15) {
    return { id: "document", label: "General Document / Screen", confidence: 0.1 };
  }

  return { id: best.id, label: best.label, confidence: best.confidence };
}

// ─── Entity extraction ────────────────────────────────────────────────────────

/**
 * Extract numeric statistics from the text.
 * Finds patterns like "108 seats", "67.3%", "₹2,340 crore".
 *
 * @param {string} text
 * @returns {string[]}  Array of stat strings
 */
function extractStats(text) {
  const patterns = [
    /\d[\d,]*\.?\d*\s*%/g,
    /₹\s*[\d,]+(?:\.\d+)?(?:\s*(?:crore|lakh|thousand|k|m|b))?/gi,
    /\$\s*[\d,]+(?:\.\d+)?(?:\s*(?:billion|million|thousand|k|m|b))?/gi,
    /\b\d{1,4}\s+(?:seats?|votes?|marks?|score|rank|position|total|count|won|leading)\b/gi,
    /\b(?:total|count|score|rank|won|leading)\s*[:-]?\s*\d[\d,]*/gi,
    /\b\d+\s+(?:students?|users?|sessions?|visits?|orders?|tickets?|constituencies|acs?)\b/gi,
  ];

  const stats = new Set();
  for (const pat of patterns) {
    const matches = text.match(pat) || [];
    matches.forEach((m) => stats.add(m.trim()));
  }
  return [...stats].slice(0, 20);
}

/**
 * Extract named entities: proper nouns, party/team names, place names.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractNamedEntities(text) {
  const pattern = /(?:[A-Z][a-zA-Z']+(?:\s+[A-Z][a-zA-Z']+){0,3})/g;
  const rawMatches = text.match(pattern) || [];

  const STOPWORDS = new Set([
    "The", "A", "An", "In", "On", "At", "Of", "For", "To", "By",
    "With", "From", "And", "Or", "But", "Not", "Is", "Are", "Was",
    "Were", "Has", "Have", "Had", "Be", "Been", "Will", "Would",
    "Should", "Could", "May", "Might", "Can", "Do", "Does", "Did",
    "This", "That", "These", "Those", "It", "He", "She", "We", "You",
    "They", "Their", "Its", "His", "Her", "Our", "Your", "I",
    "Screen", "Report", "Summary", "Key", "Section", "Page",
    "Stage", "Step", "Note", "Warning", "Analysis", "Generated",
    "Total", "Won", "Leading", "Party", "Results",
  ]);

  const seen = new Set();
  return rawMatches
    .map((m) => m.trim())
    .filter((m) => {
      if (seen.has(m)) return false;
      if (STOPWORDS.has(m)) return false;
      if (m.length < 3) return false;
      seen.add(m);
      return true;
    })
    .slice(0, 25);
}

/**
 * Extract headings from the text.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractHeadings(text) {
  const lines = text.split("\n");
  const headings = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^[A-Z0-9 \-:]{4,60}$/.test(t) && t === t.toUpperCase()) {
      headings.push(t);
    } else if (/^[A-Z].{3,50}:$/.test(t)) {
      headings.push(t);
    } else if (/^#{1,3}\s+/.test(t)) {
      headings.push(t.replace(/^#+\s+/, ""));
    }
  }
  return [...new Set(headings)].slice(0, 10);
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ContentContext
 * @property {{ id: string, label: string, confidence: number }} category
 * @property {string[]} stats
 * @property {string[]} entities
 * @property {string[]} headings
 * @property {string}   cleanText
 * @property {number}   wordCount
 */

/**
 * Analyse cleaned text to produce a rich ContentContext.
 *
 * @param {string} cleanText  Already-cleaned text from contentCleaner
 * @returns {ContentContext}
 */
export function detectContentContext(cleanText) {
  const category  = detectContentCategory(cleanText);
  const stats     = extractStats(cleanText);
  const entities  = extractNamedEntities(cleanText);
  const headings  = extractHeadings(cleanText);
  const wordCount = (cleanText.match(/\b\w+\b/g) || []).length;

  return {
    category,
    stats,
    entities,
    headings,
    cleanText,
    wordCount,
  };
}

/**
 * Format a ContentContext into a compact string for an AI prompt.
 *
 * @param {ContentContext} ctx
 * @param {number} [maxChars=3000]
 * @returns {string}
 */
export function formatContextForPrompt(ctx, maxChars = 3000) {
  const parts = [];

  parts.push(`Content Type: ${ctx.category.label}`);

  if (ctx.headings.length) {
    parts.push(`Headings:\n${ctx.headings.map((h) => `  - ${h}`).join("\n")}`);
  }

  if (ctx.stats.length) {
    parts.push(`Key Statistics Detected:\n${ctx.stats.map((s) => `  - ${s}`).join("\n")}`);
  }

  if (ctx.entities.length) {
    parts.push(`Named Entities: ${ctx.entities.slice(0, 15).join(", ")}`);
  }

  parts.push(`\n--- Full Extracted Screen Text ---\n${ctx.cleanText}`);

  return parts.join("\n\n").slice(0, maxChars);
}
