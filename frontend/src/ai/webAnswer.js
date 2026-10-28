import { invoke } from "@tauri-apps/api/core";
import { askAI } from "./aiClient";

// A short spoken answer to a Google search. The results page is already open,
// so this is a bonus: "" (say nothing extra) is always an acceptable result.
//
//   1. Wikipedia, for "who is / what is / tell me about" questions.
//   2. The snippets of the top web results (src-tauri/src/assist.rs), with the
//      built-in AI picking out the answer. The AI never answers from its own
//      memory, which is out of date for facts that change, like who holds an office.
// Both are free and need no key.

const WIKI = "https://en.wikipedia.org";

/** "who is the CM of Tamil Nadu" → "the CM of Tamil Nadu"; null if not that kind of question. */
function subjectOf(query) {
  // "who is the chief minister of Tamil Nadu" asks who holds a role now; the
  // article on the role describes the office and may not name them, so leave it
  // to the results page.
  if (/^who\s+(?:is|are)\s+(?:the\s+)?(?:current\s+)?[\w\s'-]+?\s+of\s+/i.test(query)) return null;

  const m = query.match(/^(?:who|what)\s+(?:is|are|was|were)\s+(?:an?\s+)?(.+)$|^(?:tell me about|define|meaning of|what does)\s+(.+?)(?:\s+mean)?$/i);
  return m ? (m[1] || m[2]).trim() : null;
}

/** The first two sentences, without bracketed pronunciations and dates. */
function firstSentences(text, count = 2) {
  const clean = text.replace(/\s*\([^)]*\)/g, "").replace(/\s{2,}/g, " ").trim();
  return (clean.match(/[^.!?]+[.!?]+/g) || [clean]).slice(0, count).map((s) => s.trim()).join(" ");
}

/**
 * Whether the article is about what was asked: every word of its title must be
 * in the question. Search often ranks a loosely related article first ("CM of
 * Tamil Nadu" → an article on by-elections), and a wrong answer read aloud is
 * worse than none.
 */
function isAbout(title, subject) {
  const words = (s) => s.toLowerCase().replace(/\([^)]*\)/g, "").match(/[\p{L}\p{N}]+/gu) || [];
  const asked = new Set(words(subject));
  return words(title).every((w) => asked.has(w) || ["the", "of", "a", "an", "and"].includes(w));
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function answerFromWikipedia(query) {
  const subject = subjectOf(query);
  if (!subject) return "";

  try {
    const params = new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: subject,
      srlimit: "1",
      format: "json",
      origin: "*",
    });
    const title = (await fetchJson(`${WIKI}/w/api.php?${params}`))?.query?.search?.[0]?.title;
    if (!title || !isAbout(title, subject)) return "";

    const summary = await fetchJson(`${WIKI}/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
    if (summary?.type !== "standard" || !summary.extract) return "";
    return firstSentences(summary.extract);
  } catch (e) {
    console.warn("[webAnswer] Wikipedia lookup failed:", e);
    return "";
  }
}

async function answerFromResults(query) {
  let results = [];
  try {
    results = await invoke("search_results", { query });
  } catch (e) {
    console.warn("[webAnswer] Search results lookup failed:", e);
    return "";
  }
  const snippets = results
    .map((r) => r.snippet.replace(/\[\d+\]/g, "").trim())
    .filter(Boolean)
    .slice(0, 5);
  if (!snippets.length) return "";

  const today = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const prompt = `Today is ${today}. Answer the question using ONLY the search results below, in one short sentence that will be read aloud. Prefer the most recent information. Plain text, no citations.
If the results do not answer it, reply exactly: NO_ANSWER

Question: ${query}

Search results:
${snippets.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;

  // No reading a raw snippet as a fallback: the top one often describes the topic
  // without answering, and a wrong answer read aloud is worse than none.
  const answer = await askAI({ prompt, maxTokens: 80 }, 20000);
  return !answer || answer.includes("NO_ANSWER") ? "" : answer.trim();
}

/**
 * @param {string} query What the user asked to search for.
 * @returns {Promise<string>} The answer, or "" when none could be found.
 */
export async function answerWithWebSearch(query) {
  if (!query) return "";
  return (await answerFromWikipedia(query)) || (await answerFromResults(query));
}
