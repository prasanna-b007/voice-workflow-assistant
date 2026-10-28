import { open } from "@tauri-apps/plugin-shell";
import { openUrl } from "@tauri-apps/plugin-opener";
import { saveTask } from "../storage/taskStorage";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { generateVoiceReply } from "../ai/aiVoice";
import { speakText } from "../voice/voiceUtils";
import { analyzeCurrentScreen } from "../ai/screenAnalyzer";
import { openReportInNotepad } from "../ai/notepadAutomation";
import { answerWithWebSearch } from "../ai/webAnswer";
import { evaluateExpression } from "../utils/safeMath";
import { APP_PROCESS_MAP, WEB_APPS, matchAppName } from "./apps";
import { runAssistantAction } from "./assistantActions";
import { askAI } from "../ai/aiClient";
import { findContact } from "../storage/contacts";
import { rememberSearch } from "./lastSearch";

export async function executeWorkflow(command) {
  if (!command) return;

  // 1. Multi-step tasks support
  if (command.action === "agent_plan" && command.steps && Array.isArray(command.steps)) {
    for (const step of command.steps) {
      await executeWorkflow(step);
    }
    return;
  }

  // Media, timers, maps, window control, playback, WhatsApp, routines, selection, news, translate.
  if (await runAssistantAction(command)) return;

  const action = command.action?.toLowerCase();
  const data = command.data || {};
  
  // Normalize fields from both 'command' (new flatter style) and 'command.data' (old style)
  const app = (data.app || command.app || data.name || command.name || "").toLowerCase();
  const task = data.task || command.task || "";
  const dateStr = data.date || command.date || "";
  const timeStr = data.time || command.time || command.meeting?.time || data.meeting?.time || "";
  const to = data.to || command.to || "";
  const subject = data.subject || command.subject || "";
  const message = data.message || command.message || "";
  const meetingTitle = data.meeting?.title || command.meeting?.title || data.title || command.title || "Meeting";
  const aiReply = command.reply || null;
  const level = data.level || command.level || "";
  const state = data.state || command.state || "";

  if (!action || action === "unknown") {
    if (task) {
      // Fallback for simple task structure
      saveTask({ task, date: dateStr, time: timeStr, priority: "normal" });
      alert(`Task saved: ${task}`);
      return;
    }
    console.log("No valid action or task detected");
    return;
  }

  // Natural language confirmation helper
  const confirmAction = async (act, d = {}, aiReply = null) => {
    try {
      const reply = aiReply || generateVoiceReply(act, d);
      if (reply) await executeWorkflow({ action: "speak_text", data: { text: reply } });
    } catch (e) { console.error("Natural reply failed", e); }
  };

  // ── Screen Report ──────────────────────────────────────────────────────────
  // Windows OCR and a built-in report; AI insights are added automatically when AI is available.
  if (action === "analyze_screen_report") {
    const autoSave = command.autoSave || data.autoSave || command.save || data.save || false;

    await executeWorkflow({ action: "speak_text", data: { text: "Reading your screen." } });

    try {
      const { report, foundText, hasInsights } = await analyzeCurrentScreen();

      if (!foundText && !hasInsights) {
        await executeWorkflow({ action: "speak_text", data: { text: "I couldn't find any text on the screen." } });
        return;
      }

      await openReportInNotepad(report, autoSave);
      const finalMsg = hasInsights ? "Screen report ready, with AI insights." : "Screen report ready.";
      await executeWorkflow({ action: "speak_text", data: { text: finalMsg } });
    } catch (e) {
      console.error("Screen report generation failed:", e);
      await executeWorkflow({
        action: "speak_text",
        data: { text: "I'm sorry, I couldn't read the screen right now. Please try again in a moment." },
      });
    }
    return;
  }

  // 2. Navigation & Basic Control
  if (action === "go_back" || action === "close_tab" || action === "close_overlay") {
    try {
      const win = getCurrentWindow();
      await win.hide();
    } catch (e) { console.error(`Failed to hide overlay:`, e); }
    return;
  }

  if (action === "save") {
    try {
      const win = getCurrentWindow();
      await win.hide();
      setTimeout(async () => {
        if (app === "current" || !app) {
           await invoke("press_keys", { keys: "save" });
        } else {
           await invoke("save_in_app", { appName: app });
        }
      }, 150);
    } catch (e) { console.error("Save failed:", e); }
    return;
  }

  // 3. App Management (Large List Merged)
  if (action === "open_app" || action === "switch_app") {
    let targetApp = app;
    
    // Compatibility for local rule engine
    if (!targetApp && task) {
       targetApp = task.replace("open_", "").replace("open ", "").trim().toLowerCase();
    }

    if (!targetApp) return;

    console.log(`Opening app: ${targetApp}...`);

    targetApp = matchAppName(targetApp) || targetApp;

    // ---------- WEB APPS (open in browser) ----------
    if (WEB_APPS[targetApp]) {
      try {
        confirmAction(action, { app: targetApp });
        await openUrl(WEB_APPS[targetApp]);
      } catch (e) {
        console.warn("openUrl failed, falling back to shell open:", e);
        await open(WEB_APPS[targetApp]);
      }
      return;
    }

    // ---------- DESKTOP APPS (open as executable) ----------
    const executableName = APP_PROCESS_MAP[targetApp] || targetApp;

    try {
      confirmAction(action, { app: targetApp });
      await invoke("open_app", { appName: executableName });
    } catch (e) {
      console.warn(`Failed to open dynamic app ${executableName} (original ${targetApp}):`, e);
      alert(`Could not find or open "${targetApp}". Ensure it is installed and added to your system PATH.`);
    }
    return;
  }

  if (action === "close_app") {
    // Use the same shared map as open_app for consistency
    const known = matchAppName(app);
    const resolvedApp = (known && APP_PROCESS_MAP[known]) || app;

    try {
      if (resolvedApp === "current" || !resolvedApp) {
         confirmAction("close_app", { app: "window" });
         const win = getCurrentWindow();
         await win.hide();
         setTimeout(async () => {
           await invoke("system_control", { action: "close_active", state: "" });
         }, 150);
      } else {
         confirmAction(action, { app: resolvedApp });
         await invoke("close_app", { appName: resolvedApp });
      }
    } catch (e) {
      // "Spotify isn't running.", "I won't close explorer: Windows or Sonix needs it."
      console.error(`Failed to close app:`, e);
      speakText(String(e));
    }
    return;
  }

  // 4. Calendar & Tasks
  const buildCalendarUrl = (title, d, t) => {
    let url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title || "Meeting")}`;
    if (d && !t && d.includes("-")) {
      // A date with no time: an all-day event, which Google Calendar ends on the next day.
      const start = new Date(`${d}T00:00:00`);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      const ymd = (x) => `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, "0")}${String(x.getDate()).padStart(2, "0")}`;
      url += `&dates=${ymd(start)}/${ymd(end)}`;
    } else if (d && t && d.includes("-") && t.includes(":")) {
      const cleanDate = d.replace(/-/g, ""); 
      const cleanTime = t.replace(/:/g, "") + "00"; 
      
      let parts = t.split(":");
      let endH = parseInt(parts[0], 10) + 1;
      if (endH > 23) endH = 23; 
      let endHourStr = endH < 10 ? "0" + endH : endH;
      const cleanEndTime = `${endHourStr}${parts[1]}00`;
      
      url += `&dates=${cleanDate}T${cleanTime}/${cleanDate}T${cleanEndTime}`;
    }
    return url;
  };

  if (action === "schedule_meeting") {
    confirmAction(action, { title: meetingTitle }, aiReply);
    const calUrl = buildCalendarUrl(meetingTitle, dateStr, timeStr);
    try { await openUrl(calUrl); } catch { await open(calUrl); }
    return;
  }

  if (action === "create_task" || action === "create_reminder") {
    saveTask({ task, date: dateStr, time: timeStr, priority: "normal" });
    confirmAction(action, { task }, aiReply);
    const calUrl = buildCalendarUrl(task || "New Task", dateStr, timeStr);
    try { await openUrl(calUrl); } catch { await open(calUrl); }
    return;
  }

  // 5. System Controls (Volume, Brightness, Toggles)
  if (action === "set_volume") {
    const levelStr = String(level || "").toLowerCase();
    confirmAction(action, { level }, aiReply);
    if (levelStr === "mute" || levelStr === "unmute") {
      // The mute key toggles, so this also unmutes.
      await invoke("press_keys", { keys: "volume_mute" });
    } else if (levelStr === "increase" || levelStr === "up") {
      await invoke("press_keys", { keys: "volume_up" });
    } else if (levelStr === "decrease" || levelStr === "down") {
      await invoke("press_keys", { keys: "volume_down" });
    } else {
      const parsed = parseInt(level, 10);
      await invoke("set_volume", { level: Number.isNaN(parsed) ? 50 : Math.max(0, Math.min(100, parsed)) });
    }
    return;
  }

  if (action === "set_brightness") {
    const levelStr = String(level || "").toLowerCase();
    confirmAction(action, { level }, aiReply);
    const parsed = parseInt(level, 10);
    const br = (levelStr === "increase" || levelStr === "up") ? 80 : (levelStr === "decrease" || levelStr === "down") ? 20 : (Number.isNaN(parsed) ? 50 : Math.max(0, Math.min(100, parsed)));
    try {
      await invoke("set_brightness", { level: br });
    } catch (e) {
      speakText(String(e));
    }
    return;
  }

  const systemActions = ["toggle_wifi", "toggle_bluetooth", "toggle_airplane_mode", "toggle_hotspot", "toggle_night_light", "toggle_energy_saver", "toggle_battery_saver", "toggle_screenshot", "take_screenshot", "toggle_screen_recording", "start_screen_recording", "stop_screen_recording", "scroll_up", "scroll_down"];
  if (systemActions.includes(action)) {
    try {
      let finalAction = action;
      let finalState = state || "";
      if (action === "take_screenshot") finalAction = "toggle_screenshot";
      if (action === "start_screen_recording") { finalAction = "toggle_screen_recording"; finalState = "on"; }
      if (action === "stop_screen_recording") { finalAction = "toggle_screen_recording"; finalState = "off"; }
      if (action === "toggle_battery_saver") finalAction = "toggle_energy_saver";
      
      confirmAction(action, { ...data, state: finalState });

      const win = getCurrentWindow();
      await win.hide();

      setTimeout(async () => { await invoke("system_control", { action: finalAction, state: finalState }); }, 150);
    } catch (e) { console.error("System action failed", e); }
    return;
  }

  // 6. Communication (Fixed & Improved)
  if (action === "send_email" || action === "email_and_schedule") {
    // Hide overlay so the user can see their mail client
    try {
      const win = getCurrentWindow();
      await win.hide();
    } catch {
      console.warn("Could not hide assistant window before opening email.");
    }

    // "email my manager" → the address saved for that contact.
    const spokenTo = to || data.to || "";
    const targetRecipient = spokenTo.includes("@") ? spokenTo : findContact(spokenTo)?.email || "";
    let subjectLine = subject || "";
    let bodyText = message || data.message || "";

    // "saying I'm on leave tomorrow" becomes a short, polite email; the plain words are kept if AI is off.
    if (bodyText) {
      const raw = await askAI({
        prompt: `Write a short, polite email${spokenTo ? ` to ${spokenTo}` : ""} that says: "${bodyText}".${subjectLine ? ` Subject: "${subjectLine}".` : ""}
Reply as JSON: {"subject": "...", "body": "..."}. Keep the body under 80 words, end with "Regards," and no name or placeholders.`,
        json: true,
        maxTokens: 400,
      });
      try {
        const draft = raw && JSON.parse(raw.replace(/```json|```/gi, "").trim());
        if (draft?.body) {
          bodyText = draft.body;
          subjectLine = subjectLine || draft.subject || "";
        }
      } catch {
        console.warn("Email draft wasn't JSON; using the spoken words.");
      }
    }

    const compose =
      `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(targetRecipient)}` +
      `&su=${encodeURIComponent(subjectLine)}&body=${encodeURIComponent(bodyText)}`;

    console.log("Opening Gmail compose:", compose);
    confirmAction(action, { to: targetRecipient }, aiReply);
    try { await openUrl(compose); } catch { await open(compose); }
    
    if (action === "email_and_schedule") {
      setTimeout(async () => {
        const calUrl = buildCalendarUrl(meetingTitle, dateStr, timeStr);
        try { await openUrl(calUrl); } catch { await open(calUrl); }
      }, 500);
    }
    return;
  }

  // 6b. Other parser actions (kept in sync with SUPPORTED_ACTIONS in aiParser.js)
  if (action === "generic_reply") {
    const r = command.reply || data.reply || "";
    if (r) await executeWorkflow({ action: "speak_text", data: { text: r } });
    return;
  }

  if (action === "youtube_search") {
    const q = data.query || command.query || task || "";
    confirmAction(action, { query: q }, aiReply);
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
    try { await openUrl(url); } catch { await open(url); }
    return;
  }

  if (action === "web_search") {
    const q = (data.query || command.query || task || "").trim();
    const url = q ? `https://www.google.com/search?q=${encodeURIComponent(q)}` : "https://www.google.com";
    if (q) await executeWorkflow({ action: "speak_text", data: { text: `Searching Google for ${q}.` } });
    try { await openUrl(url); } catch { await open(url); }
    if (!q) return;
    rememberSearch(q);

    // The results page is already open for the user to read; the spoken answer is a bonus.
    const answer = await answerWithWebSearch(q);
    await executeWorkflow({ action: "speak_text", data: { text: answer || "Here are the results." } });
    return;
  }

  if (action === "search_file") {
    const query = data.query || task || "";
    const uri = `search-ms:query=${encodeURIComponent(query)}`;
    try { await openUrl(uri); } catch { await open(uri); }
    return;
  }

  if (action === "open_file") {
    const name = (data.name || data.file || task || "").trim();
    if (!name) return;
    try {
      // Searches Desktop, Documents and Downloads, and opens the first match.
      await invoke("open_file", { name });
    } catch (e) {
      console.error("open_file failed:", e);
      speakText(String(e));
    }
    return;
  }

  if (action === "save_note") {
    const note = data.note || data.text || task || message || "";
    if (note) {
      saveTask({ task: note, date: "", time: "", priority: "note" });
      await executeWorkflow({ action: "speak_text", data: { text: `Note saved: ${note.slice(0, 120)}` } });
    }
    return;
  }

  if (action === "shutdown") {
    confirmAction(action, data, aiReply);
    await invoke("system_control", { action: "shutdown", state: "" });
    return;
  }

  if (action === "restart") {
    confirmAction(action, data, aiReply);
    await invoke("system_control", { action: "restart", state: "" });
    return;
  }

  if (action === "cancel_shutdown") {
    confirmAction(action, data, aiReply);
    await invoke("system_control", { action: "cancel_shutdown", state: "" });
    return;
  }

  if (action === "shutdown_timer") {
    const mins = Math.max(1, parseInt(data.time, 10) || 10);
    confirmAction(action, { ...data, time: mins }, aiReply);
    await invoke("system_control", { action: "shutdown_timer", state: "", minutes: mins });
    return;
  }

  if (action === "get_system_info") {
    const parts = [];
    try {
      if (typeof navigator.deviceMemory === "number") {
        parts.push(`About ${navigator.deviceMemory} gigabytes of RAM (browser estimate).`);
      }
      if (navigator.hardwareConcurrency) {
        parts.push(`${navigator.hardwareConcurrency} logical processors.`);
      }
      if (navigator.getBattery) {
        const b = await navigator.getBattery();
        parts.push(`Battery ${Math.round(b.level * 100)} percent, ${b.charging ? "charging" : "on battery"}.`);
      }
    } catch (e) {
      console.error("get_system_info:", e);
    }
    const text = parts.length ? parts.join(" ") : "Limited system information is available in this view.";
    await executeWorkflow({ action: "speak_text", data: { text } });
    return;
  }

  if (action === "open_recent") {
    try {
      await invoke("open_uri", { uri: "shell:Recent" });
    } catch (e) {
      console.error("open_recent failed:", e);
    }
    return;
  }

  // 7. Text & Voice
  if (action === "speak_text" && (data.text || message)) {
    const textToSpeak = data.text || message;
    speakText(textToSpeak);
    return;
  }

  if (action === "type_text") {
    try {
      const win = getCurrentWindow();
      await win.hide();
      setTimeout(async () => {
        await invoke("type_text", { text: data.text || message || "", appName: app });
      }, 150);
    } catch (e) { console.error("Type text failed:", e); }
    return;
  }

  // 8. Utilities
  if (action === "get_time") {
    await executeWorkflow({ action: "speak_text", data: { text: `It is currently ${new Date().toLocaleTimeString()}` } });
    return;
  }
  if (action === "get_date") {
    const today = new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    await executeWorkflow({ action: "speak_text", data: { text: `Today is ${today}` } });
    return;
  }
  if (action === "get_weather") { await openUrl("https://www.google.com/search?q=weather"); return; }
  if (action === "calculate") {
    try {
      const res = evaluateExpression(data.expression || task);
      await executeWorkflow({ action: "speak_text", data: { text: `The answer is ${res}` } });
    } catch (e) {
      console.error("Calc failed", e);
      await executeWorkflow({ action: "speak_text", data: { text: "I couldn't work that one out." } });
    }
    return;
  }
  if (action === "open_url") {
    confirmAction(action, { url: data.url || task }, aiReply);
    try { await openUrl(data.url || task); } catch { await open(data.url || task); }
    return;
  }

  console.log("No workflow matched for action:", action);
}
