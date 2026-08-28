/**
 * retryManager.js
 * ───────────────
 * Handles AI request retries with exponential backoff / simple delays.
 * Ensures we don't spam the API but give it a second chance on transient failures.
 */

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Execute an async function with retry logic.
 * 
 * @param {Function} fn        The async function to execute
 * @param {number} maxRetries  Maximum number of retries (default 1)
 * @param {number} delayMs     Initial delay between retries
 * @returns {Promise<any>}
 */
export async function withRetry(fn, maxRetries = 1, delayMs = 1500) {
  let lastError;
  
  for (let i = 0; i <= maxRetries; i++) {
    try {
      if (i > 0) {
        console.info(`[retryManager] Retry attempt ${i}/${maxRetries} after ${delayMs}ms...`);
        await wait(delayMs);
      }
      return await fn();
    } catch (err) {
      lastError = err;
      
      // Don't retry on certain errors (e.g. invalid API key)
      const msg = err.message?.toLowerCase() || "";
      if (msg.includes("api key not valid") || msg.includes("missing vite_gemini_api_key")) {
        console.warn("[retryManager] Terminal error detected, skipping retries.");
        throw err;
      }
      
      console.warn(`[retryManager] Attempt ${i} failed: ${err.message}`);
      
      // If we've exhausted retries, throw the last error
      if (i === maxRetries) throw lastError;
    }
  }
}
