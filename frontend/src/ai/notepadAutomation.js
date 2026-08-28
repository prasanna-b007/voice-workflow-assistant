import { invoke } from "@tauri-apps/api/core";
import { executeWorkflow } from "../workflows/workflowExecutor";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Opens Notepad, waits for it to be ready, then pastes the given report text
 * using the existing type_text infrastructure.  Optionally auto-saves the
 * report to Desktop/reports/screen_report.txt via the Tauri backend.
 *
 * @param {string} reportText   The plain-text report to paste into Notepad.
 * @param {boolean} autoSave    If true, also persist to Desktop/reports/.
 */
export async function openReportInNotepad(reportText, autoSave = false) {
  // Open Notepad using the existing open_app workflow
  await executeWorkflow({ action: "open_app", data: { app: "notepad" } });

  // Give Notepad enough time to fully initialise before we paste
  await wait(1100);

  // Paste the report using the existing type_text infrastructure
  await executeWorkflow({
    action: "type_text",
    data: { text: reportText, app: "Notepad" },
  });

  // Optionally save a copy to disk via the Rust backend
  if (autoSave) {
    try {
      await invoke("save_screen_report", { report: reportText });
    } catch (e) {
      console.warn("Auto-save of screen report failed:", e);
    }
  }
}
