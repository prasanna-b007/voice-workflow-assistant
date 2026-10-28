import { invoke } from "@tauri-apps/api/core";

// Sonix's built-in AI (src-tauri/src/ai.rs): a small model that runs on this PC,
// with no key, account or server. Every caller runs its built-in behaviour first
// and asks the model only when that can't help. Any failure — the model still
// downloading, a PC too small to run it, too slow, an error — returns null, so
// the caller carries on with its built-in result.

/**
 * Runs one prompt through the built-in model.
 * @param {object} request
 * @param {string} request.prompt
 * @param {boolean} [request.json]     Ask for a JSON reply.
 * @param {number} [request.maxTokens]
 * @param {number} [timeoutMs]
 * @returns {Promise<string|null>} The reply text, or null when the model couldn't answer.
 */
export async function askAI(request, timeoutMs = 30000) {
  let timer;
  try {
    return await Promise.race([
      invoke("ai_generate", { request }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no reply within ${timeoutMs / 1000}s`)), timeoutMs);
      }),
    ]);
  } catch (e) {
    console.warn("[ai] No AI answer; using the built-in result instead:", e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
