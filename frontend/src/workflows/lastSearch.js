// The most recent Google search, so "open the first result" knows what to open.

// After this long, "open the Wikipedia one" no longer refers to the old search.
const FRESH_MS = 10 * 60 * 1000;

let last = null;

export function rememberSearch(query) {
  last = { query, at: Date.now() };
}

/** The last search query if it was recent, else null. */
export function recentSearch() {
  return last && Date.now() - last.at < FRESH_MS ? last.query : null;
}
