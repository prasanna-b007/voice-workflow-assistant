import { invoke } from "@tauri-apps/api/core";

// Single source of truth for talking to Gemini.
//
// Requests go through the Rust `call_gemini` command rather than fetch(). Vite
// inlines any VITE_-prefixed variable into the client bundle, so calling the API
// from here directly shipped the API key inside the packaged app, where anyone
// who installed Sonix could extract it. Rust reads the key at runtime instead,
// so it never reaches the JavaScript bundle.

export const GEMINI_MODEL = "gemini-2.5-flash";

/**
 * Sends a generateContent request to Gemini.
 * @param {object} body The request body ({ contents, generationConfig, ... }).
 * @param {string} [model] Overrides the default model.
 * @returns {Promise<object>} The parsed API response, same shape as the REST API.
 */
export async function callGemini(body, model = GEMINI_MODEL) {
  return await invoke("call_gemini", { model, body: withThinkingDisabled(body) });
}

// On 2.5 models, thinking tokens count against maxOutputTokens. Every capped
// call here had its budget tuned against a non-thinking model, so leaving
// thinking on can consume the whole allowance and return an empty or truncated
// answer. Calls that set no cap (the intent parser) keep thinking enabled.
function withThinkingDisabled(body) {
  const config = body?.generationConfig;
  if (!config?.maxOutputTokens || config.thinkingConfig) return body;

  return {
    ...body,
    generationConfig: { ...config, thinkingConfig: { thinkingBudget: 0 } },
  };
}

// Whether a key is configured at all. Callers use this to pick their offline
// fallback before building a prompt. Cached because the answer cannot change
// while the app is running.
let availability = null;

export function geminiAvailable() {
  if (availability === null) {
    availability = invoke("gemini_key_available").catch(() => false);
  }
  return availability;
}
