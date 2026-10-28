import { invoke } from "@tauri-apps/api/core";

/**
 * Shows a report in Notepad by opening it as a file, so the text can't land in some
 * other window, and the clipboard is left alone. With autoSave the file is kept as
 * Desktop/reports/screen_report_<date-time>.txt; otherwise it is a temporary file.
 *
 * @param {string} reportText   The plain-text report.
 * @param {boolean} autoSave    Keep a copy in Desktop/reports.
 */
export async function openReportInNotepad(reportText, autoSave = false) {
  try {
    await invoke("show_in_notepad", { text: reportText, save: autoSave });
  } catch (e) {
    console.warn("Could not show the report in Notepad:", e);
  }
}
