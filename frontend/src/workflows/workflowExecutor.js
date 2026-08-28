import { open } from "@tauri-apps/plugin-shell";
import { openUrl } from "@tauri-apps/plugin-opener";
import { saveTask } from "../storage/taskStorage";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { generateVoiceReply } from "../ai/aiVoice";
import { speakText } from "../voice/voiceUtils";
import { generateDashboardReport } from "../ai/aiReportGenerator";
import { analyzeCurrentScreen } from "../ai/screenAnalyzer";
import { openReportInNotepad } from "../ai/notepadAutomation";

/* ────────────────────────────────────────────
   Shared App Name → Process Name Map
   Used by BOTH open_app and close_app for consistency.
   ──────────────────────────────────────────── */
const APP_PROCESS_MAP = {
  // Code Editors
  "visual studio code": "code",
  "vs code": "code",
  "vscode": "code",
  "visual studio": "devenv",
  // Microsoft Office
  "word": "winword",
  "microsoft word": "winword",
  "excel": "excel",
  "powerpoint": "powerpnt",
  // System Tools
  "notepad": "notepad",
  "note pad": "notepad",
  "note pade": "notepad",
  "paint": "mspaint",
  "command prompt": "cmd",
  "terminal": "wt",
  "calculator": "calc",
  "calc": "calc",
  "file explorer": "explorer",
  "explorer": "explorer",
  "task manager": "taskmgr",
  "snipping tool": "snippingtool",
  "control panel": "control",
  "recycle bin": "shell:RecycleBinFolder",
  "settings": "ms-settings:",
  "camera": "microsoft.windows.camera:",
  "clock": "ms-clock:",
  "maps": "bingmaps:",
  "store": "ms-windows-store:",
  "microsoft store": "ms-windows-store:",
  // Browsers
  "chrome": "chrome",
  "google chrome": "chrome",
  "firefox": "firefox",
  "edge": "msedge",
  "microsoft edge": "msedge",
  "brave": "brave",
  // Communication & Media
  "spotify": "spotify",
  "discord": "discord",
  "slack": "slack",
  "teams": "teams",
  "microsoft teams": "teams",
  "zoom": "zoom",
  "vlc": "vlc",
  "media player": "wmplayer",
  "obs": "obs64",
  "steam": "steam",
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function executeWorkflow(command) {
  if (!command) return;

  // 1. Multi-step tasks support
  if (command.action === "agent_plan" && command.steps && Array.isArray(command.steps)) {
    for (const step of command.steps) {
      await executeWorkflow(step);
    }
    return;
  }

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
      const reply = aiReply || await generateVoiceReply(act, d);
      await executeWorkflow({ action: "speak_text", data: { text: reply } });
    } catch (e) { console.error("Natural reply failed", e); }
  };

  // ── Screen Report (Professional AI Pipeline) ────────────────────────────────
  if (action === "analyze_screen_report") {
    const autoSave = command.autoSave || data.autoSave || command.save || data.save || false;

    // Acknowledge
    await executeWorkflow({ action: "speak_text", data: { text: "Analyzing current screen." } });

    try {
      const { report: reportText, source } = await analyzeCurrentScreen();

      if (!reportText) throw new Error("Report generation failed.");

      // Context-aware voice status
      const statusMsg = source === "cache"
        ? "Retrieving latest analysis."
        : source === "vision" || source === "dom" || source === "ocr"
        ? "Generating detailed report."
        : "Producing summary report.";
      
      await executeWorkflow({ action: "speak_text", data: { text: statusMsg } });

      console.info(`[workflowExecutor] Screen report source: ${source}`);

      // Paste to Notepad
      await openReportInNotepad(reportText, autoSave);

      // Final confirmation
      const finalMsg = source === "none" 
        ? "Screen analysis completed with summary." 
        : "Screen report generated successfully.";
      
      await executeWorkflow({ action: "speak_text", data: { text: finalMsg } });
    } catch (e) {
      console.error("Screen report generation failed:", e);
      await executeWorkflow({
        action: "speak_text",
        data: { text: "I'm sorry, I'm unable to analyze the screen right now. Please try again in a moment." },
      });
    }
    return;
  }


  // 1.5 Dashboard Reporting
  if (action === "generate_dashboard_report") {
    confirmAction(action, {}, aiReply || "Generating dashboard report.");
    
    try {
      // Hide Sonix overlay so we can interact with the dashboard underneath
      const win = getCurrentWindow();
      await win.hide();

      // Emulate Ctrl+A (Select All) and Ctrl+C (Copy) to grab the dashboard's text
      await invoke("system_control_raw", { 
        script: "$wshell = New-Object -ComObject WScript.Shell; Start-Sleep -m 350; $wshell.SendKeys('^a'); Start-Sleep -m 300; $wshell.SendKeys('^c'); Start-Sleep -m 100; $wshell.SendKeys('{ESC}');" 
      });

      // Give the system clipboard time to populate
      await wait(800);

      // Extract data securely from the clipboard
      const clipboardText = await invoke("get_clipboard_text");

      // Generate the report using Gemini with the raw clipboard text
      const reportText = await generateDashboardReport({ rawTextPreview: clipboardText });

      if (command.autoSave || data.autoSave || command.save || data.save) {
        await invoke("save_dashboard_report", { report: reportText });
      }

      await executeWorkflow({ action: "open_app", data: { app: "notepad" } });
      await wait(900);
      await executeWorkflow({ action: "type_text", data: { text: reportText, app: "notepad" } });
      await wait(300);
      await executeWorkflow({ action: "speak_text", data: { text: "Dashboard report generated successfully." } });
    } catch (e) {
      console.error("Dashboard report generation failed:", e);
      await executeWorkflow({ action: "speak_text", data: { text: "Failed to generate dashboard report." } });
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
           await invoke("system_control_raw", { script: "$wshell = New-Object -ComObject WScript.Shell; $wshell.SendKeys('^s');" });
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

    // ---------- WEB APPS (open in browser) ----------
    const webApps = {
      "youtube": "https://www.youtube.com",
      "google": "https://www.google.com",
      "whatsapp": "https://web.whatsapp.com",
      "facebook": "https://www.facebook.com",
      "instagram": "https://www.instagram.com",
      "twitter": "https://www.twitter.com",
      "x": "https://www.x.com",
      "linkedin": "https://www.linkedin.com",
      "github": "https://www.github.com",
      "gmail": "https://mail.google.com",
      "email": "https://mail.google.com",
      "outlook": "https://outlook.live.com",
      "google drive": "https://drive.google.com",
      "google maps": "https://maps.google.com",
      "google calendar": "https://calendar.google.com",
      "netflix": "https://www.netflix.com",
      "amazon": "https://www.amazon.com",
      "reddit": "https://www.reddit.com",
      "spotify": "https://open.spotify.com",
      "chatgpt": "https://chat.openai.com",
      "canva": "https://www.canva.com",
      "figma": "https://www.figma.com",
      "notion": "https://www.notion.so",
      "slack": "https://slack.com",
      "discord": "https://discord.com/app",
      "telegram": "https://web.telegram.org",
      "pinterest": "https://www.pinterest.com",
      "stackoverflow": "https://stackoverflow.com",
      "stack overflow": "https://stackoverflow.com"
    };

    if (webApps[targetApp]) {
      try {
        confirmAction(action, { app: targetApp });
        await openUrl(webApps[targetApp]);
      } catch (e) {
        console.warn("openUrl failed, falling back to shell open:", e);
        await open(webApps[targetApp]);
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
    const resolvedApp = APP_PROCESS_MAP[app] || app;

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
      console.error(`Failed to close app:`, e);
    }
    return;
  }

  // 4. Calendar & Tasks
  const buildCalendarUrl = (title, d, t) => {
    let url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title || "Meeting")}`;
    if (d && t && d.includes("-") && t.includes(":")) {
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
    const calUrl = buildCalendarUrl(meetingTitle, dateStr, timeStr);
    try { await openUrl(calUrl); } catch { await open(calUrl); }
    return;
  }

  if (action === "create_task" || action === "create_reminder") {
    saveTask({ task, date: dateStr, time: timeStr, priority: "normal" });
    const calUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(task || "New Task")}`;
    try { await openUrl(calUrl); } catch { await open(calUrl); }
    return;
  }

  // 5. System Controls (Volume, Brightness, Toggles)
  if (action === "set_volume") {
    const levelStr = String(level || "").toLowerCase();
    let volScript = "";
    
    if (levelStr === "increase" || levelStr === "up") {
      volScript = "$obj = New-Object -ComObject WScript.Shell; for($i=0; $i -lt 5; $i++) { $obj.SendKeys([char]175) }";
    } else if (levelStr === "decrease" || levelStr === "down") {
      volScript = "$obj = New-Object -ComObject WScript.Shell; for($i=0; $i -lt 5; $i++) { $obj.SendKeys([char]174) }";
    } else {
      const levelNum = parseInt(level) || 50;
      const loops = Math.floor(levelNum / 2);
      volScript = `$obj = New-Object -ComObject WScript.Shell; for($i=0; $i -lt 50; $i++) { $obj.SendKeys([char]173) }; for($i=0; $i -lt ${loops}; $i++) { $obj.SendKeys([char]175) }`;
    }

    confirmAction(action, { level }, aiReply);
    await invoke("system_control_raw", { script: volScript });
    return;
  }

  if (action === "set_brightness") {
    const levelStr = String(level || "").toLowerCase();
    confirmAction(action, { level }, aiReply);
    const br = (levelStr === "increase" || levelStr === "up") ? 80 : (levelStr === "decrease" || levelStr === "down") ? 20 : (parseInt(level) || 50);
    await invoke("system_control_raw", { script: `(Get-WmiObject -Namespace root/WMI -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1, ${br})` });
    return;
  }

  const systemActions = ["toggle_wifi", "toggle_bluetooth", "toggle_airplane_mode", "toggle_hotspot", "toggle_night_light", "toggle_energy_saver", "toggle_battery_saver", "toggle_screenshot", "take_screenshot", "toggle_screen_recording", "start_screen_recording", "stop_screen_recording"];
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

    const targetRecipient = to || data.to || "";
    const subjectLine = subject || "Message from Sonix";
    const bodyText = message || data.message || "";
    
    // Construct valid mailto URI
    const mailto = `mailto:${targetRecipient}?subject=${encodeURIComponent(subjectLine)}&body=${encodeURIComponent(bodyText)}`;
    
    console.log("Opening email:", mailto);
    
    try {
      // Step 1: Try the specialized opener plugin
      await openUrl(mailto);
    } catch {
      try {
        // Step 2: Try the native Windows "start" command via our Rust backend
        await invoke("open_app", { appName: mailto });
      } catch {
        // Step 3: Last resort shell open
        await open(mailto);
      }
    }
    
    if (action === "email_and_schedule") {
      setTimeout(async () => {
        const calUrl = buildCalendarUrl(meetingTitle, dateStr, timeStr);
        try { await openUrl(calUrl); } catch { await open(calUrl); }
      }, 500);
    }
    return;
  }

  // 6b. Parser / Gemini actions (kept in sync with aiParser prompt)
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

  if (action === "search_file") {
    const query = data.query || task || "";
    const uri = `search-ms:query=${encodeURIComponent(query)}`;
    try { await openUrl(uri); } catch { await open(uri); }
    return;
  }

  if (action === "open_file") {
    const raw = (data.name || data.file || task || "").trim();
    const safe = raw.replace(/[^a-zA-Z0-9._\- ]/g, "");
    if (!safe) return;
    const esc = safe.replace(/'/g, "''");
    const script =
      `$n = '${esc}'; ` +
      `$dirs = @("$env:USERPROFILE\\Desktop", "$env:USERPROFILE\\Documents", "$env:USERPROFILE\\Downloads"); ` +
      `foreach ($d in $dirs) { if (Test-Path $d) { $f = Get-ChildItem -Path $d -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Name -like ('*' + $n + '*') } | Select-Object -First 1; if ($null -ne $f) { Invoke-Item -LiteralPath $f.FullName; break } } }`;
    try {
      await invoke("system_control_raw", { script });
    } catch (e) {
      console.error("open_file failed:", e);
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

  if (action === "shutdown_timer") {
    const mins = Math.max(1, parseInt(data.time, 10) || 10);
    confirmAction(action, { ...data, time: mins }, aiReply);
    await invoke("system_control_raw", { script: `shutdown.exe /s /t ${mins * 60}` });
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
      await invoke("system_control_raw", { script: "explorer.exe shell:Recent" });
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
      const res = eval((data.expression || task).replace(/[^-()\d/*+.]/g, ''));
      await executeWorkflow({ action: "speak_text", data: { text: `The answer is ${res}` } });
    } catch (e) { console.error("Calc failed", e); }
    return;
  }
  if (action === "open_url") { try { await openUrl(data.url || task); } catch { await open(data.url || task); } return; }

  console.log("No workflow matched for action:", action);
}
