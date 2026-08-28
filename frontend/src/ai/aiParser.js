export async function detectIntentWithGemini(text) {
  if (!text || text.trim().length === 0) {
    return null;
  }

  const command = text.toLowerCase().trim();

  // ── Screen Analysis (highest priority — checked before dashboard) ──────────
  const screenReportPattern =
    /\b(?:analyze|analyse|scan|capture|summarize|summarise|generate|create|prepare|make|write|build)\b.*\b(?:screen|display|desktop|monitor|window)\b|\b(?:screen|display)\b.*\b(?:report|analysis|summary|insights)\b|\bwhat(?:'s| is) on (?:the |my )?screen\b|\bprepare (?:a )?report on (?:what'?s? on (?:the |my )?screen|(?:the |my )?screen)\b/i;

  if (screenReportPattern.test(command)) {
    return {
      action: "analyze_screen_report",
      reply: "Analyzing current screen",
      autoSave: /\bsave\b|\bsaved\b|\bfile\b|\bdesktop\b/i.test(command),
    };
  }

  // ── Dashboard Report ────────────────────────────────────────────────────────
  const dashboardReportPattern =
    /\b(?:generate|create|make|prepare|write|build|summarize|analyse|analyze)\b.*\b(?:dashboard|analytics|report)\b|\b(?:dashboard|analytics)\b.*\b(?:report|summary|insights|analysis)\b|\bcreate report\b|\bgenerate report\b/i;

  if (dashboardReportPattern.test(command)) {
    return {
      action: "generate_dashboard_report",
      reply: "Generating dashboard report",
      autoSave: /\bsave\b|\bsaved\b|\bfile\b|\bdesktop\b/i.test(command),
    };
  }

  const playYtMatch =
    command.match(/(?:play|search(?: for)?)\s+(.+?)\s*(?:on )?youtube/i) ||
    command.match(/(?:play|search(?: for)?)\s+(?:a\s+)?(?:youtube|yt)(?:\s+video)?(?:\s+of|\s+about)?\s+(.+)/i) ||
    command.match(/youtube(?: play| search(?: for)?)\s+(.+)/i);

  if (playYtMatch) {
    let query = (playYtMatch[1] || playYtMatch[2] || playYtMatch[3] || "").trim();
    query = query.replace(/^youtube\s+/i, "").replace(/\s+on\s+youtube$/i, "");
    if (query.endsWith(" on")) query = query.slice(0, -3).trim();
    if (["a", "the", "a video", "video"].includes(query)) query = "";

    if (query) {
      return { action: "youtube_search", task: query };
    }
  }

  if (command.includes("youtube")) return { action: "open_app", app: "youtube" };
  if (command.includes("calculator")) return { action: "open_app", app: "calc" };
  if (command.includes("whatsapp")) return { action: "open_app", app: "whatsapp" };

  if (command.includes("reminder") || command.includes("remind")) {
    return { action: "create_task", task: "reminder", date: "", time: "" };
  }

  if (command.includes("volume up") || command.includes("increase volume") || command.includes("louder")) {
    return { action: "set_volume", level: "increase" };
  }
  if (command.includes("volume down") || command.includes("decrease volume") || command.includes("quieter")) {
    return { action: "set_volume", level: "decrease" };
  }
  if (command.match(/volume.*(\d+)/i)) {
    const match = command.match(/volume.*(\d+)/i);
    return { action: "set_volume", level: match[1] };
  }

  if (command.includes("brightness up") || command.includes("increase brightness") || command.includes("brighter")) {
    return { action: "set_brightness", level: "increase" };
  }
  if (command.includes("brightness down") || command.includes("decrease brightness") || command.includes("darker")) {
    return { action: "set_brightness", level: "decrease" };
  }
  if (command.match(/brightness.*(\d+)/i)) {
    const match = command.match(/brightness.*(\d+)/i);
    return { action: "set_brightness", level: match[1] };
  }

  if (command.includes("wifi on") || command.includes("enable wifi") || command.includes("turn on wifi")) {
    return { action: "toggle_wifi", state: "on" };
  }
  if (command.includes("wifi off") || command.includes("disable wifi") || command.includes("turn off wifi")) {
    return { action: "toggle_wifi", state: "off" };
  }
  if (command.includes("toggle wifi") || command.includes("wifi")) return { action: "toggle_wifi" };

  if (command.includes("bluetooth on") || command.includes("enable bluetooth") || command.includes("turn on bluetooth")) {
    return { action: "toggle_bluetooth", state: "on" };
  }
  if (command.includes("bluetooth off") || command.includes("disable bluetooth") || command.includes("turn off bluetooth")) {
    return { action: "toggle_bluetooth", state: "off" };
  }
  if (command.includes("toggle bluetooth") || command.includes("bluetooth")) return { action: "toggle_bluetooth" };

  if (command.includes("airplane mode on") || command.includes("enable airplane mode")) {
    return { action: "toggle_airplane_mode", state: "on" };
  }
  if (command.includes("airplane mode off") || command.includes("disable airplane mode")) {
    return { action: "toggle_airplane_mode", state: "off" };
  }
  if (command.includes("airplane mode") || command.includes("flight mode")) return { action: "toggle_airplane_mode" };

  if (command.includes("night light on") || command.includes("enable night light")) {
    return { action: "toggle_night_light", state: "on" };
  }
  if (command.includes("night light off") || command.includes("disable night light")) {
    return { action: "toggle_night_light", state: "off" };
  }
  if (command.includes("night light")) return { action: "toggle_night_light" };

  if (command.includes("energy saver on") || command.includes("battery saver on") || command.includes("enable energy saver")) {
    return { action: "toggle_energy_saver", state: "on" };
  }
  if (command.includes("energy saver off") || command.includes("battery saver off") || command.includes("disable energy saver")) {
    return { action: "toggle_energy_saver", state: "off" };
  }
  if (command.includes("energy saver") || command.includes("battery saver")) return { action: "toggle_energy_saver" };

  const closeMatch = command.match(/\b(?:close|exit|quit|kill|terminate)\b\s+(?:the\s+)?(.+)/i);
  if (closeMatch) {
    const targetApp = closeMatch[1].trim();
    if (["app", "application", "program", "window", "this", "it"].includes(targetApp)) {
      return { action: "close_app", app: "current" };
    }
    return { action: "close_app", app: targetApp };
  }

  if (/^(close|exit|quit)$/.test(command)) return { action: "close_app", app: "current" };

  const API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
  const todayStr = new Date().toISOString().split("T")[0];

  const emptyIntent = {
    action: "",
    query: "",
    reply: "",
    to: "",
    subject: "",
    message: "",
    meeting: { title: "", time: "" },
    task: "",
    date: "",
    time: "",
    app: "",
    level: "",
    state: "",
  };

  if (!API_KEY) return emptyIntent;

  const prompt = `You are an advanced AI command parser for a voice assistant called Sonix.

Convert the user's command into strict JSON only. Do not include markdown or explanations.

Intent priority:
1. send_email
2. schedule_meeting
3. email_and_schedule
4. analyze_screen_report
5. generate_dashboard_report
6. youtube_search
7. open_app
8. create_task
9. system_controls
10. close_app

Rules:
- Commands referencing the screen, display, desktop, or monitor combined with words like analyze, report, summarize, or scan use action "analyze_screen_report" and reply "Analyzing current screen".
- Dashboard or analytics reporting requests use action "generate_dashboard_report" and reply "Generating dashboard report".
- If the sentence contains send, email, or mail, prefer send_email over close_app.
- Never interpret "send email" as "end email".
- YouTube play/search requests use youtube_search with a cleaned query.
- "open youtube" uses open_app with app "youtube".
- App opening requests use open_app.
- Reminder or task requests use create_task.
- Volume requests use set_volume with level up/down/integer.
- Brightness requests use set_brightness with level up/down/integer.
- WiFi, Bluetooth, Airplane Mode, Night Light, and Energy Saver requests use their matching toggle action with optional state "on" or "off".
- Close, exit, quit, or terminate requests use close_app. If no app is named, app is "current".
- Always return date in YYYY-MM-DD format. If date is missing or today, use "${todayStr}".
- Always return time in 24-hour HH:mm format. If time is missing, return "".
- If a value is missing, return "".
- Keep reply short, natural, and under 10 words.

Return exactly this JSON shape:
{
  "action": "",
  "query": "",
  "reply": "",
  "to": "",
  "subject": "",
  "message": "",
  "meeting": { "title": "", "time": "" },
  "task": "",
  "date": "",
  "time": "",
  "app": "",
  "level": "",
  "state": ""
}

User command: "${text}"`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  );

  const data = await response.json();
  console.log("FULL GEMINI RESPONSE:", data);

  if (data?.error) {
    throw new Error(`Gemini API Error: ${data.error.message}`);
  }

  const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!aiText) throw new Error("Invalid Gemini response: missing text");

  const cleanedText = aiText.replace(/```json/gi, "").replace(/```/g, "").trim();

  try {
    const parsed = JSON.parse(cleanedText);
    console.log("Parsed Intent JSON:", parsed);
    return parsed;
  } catch {
    console.error("Gemini returned invalid JSON:", aiText);
    return emptyIntent;
  }
}
