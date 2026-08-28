import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Captures the primary (or all) screen(s) and returns a base64 JPEG string.
 * The Sonix overlay is briefly hidden before the capture so it doesn't
 * appear in the screenshot, then restored immediately after.
 *
 * @returns {Promise<string>} Raw base64 JPEG (no data: prefix) suitable for
 *                            Gemini Vision inlineData.
 */
export async function captureScreen() {
  // Hide Sonix overlay so the underlying screen content is visible
  let win;
  try {
    win = getCurrentWindow();
    await win.hide();
  } catch (_) {
    // Non-fatal – continue even if hide fails
  }

  // Small pause to ensure the OS composited the new frame without the overlay
  await new Promise((r) => setTimeout(r, 350));

  try {
    // Call the Rust backend command that does the actual capture
    const base64Jpeg = await invoke("capture_screenshot");

    if (!base64Jpeg || typeof base64Jpeg !== "string") {
      throw new Error("Screenshot capture returned an empty or invalid result.");
    }

    return base64Jpeg;
  } finally {
    // Always restore the overlay window after capture
    if (win) {
      try {
        await win.show();
        await win.setFocus();
      } catch (_) {}
    }
  }
}
