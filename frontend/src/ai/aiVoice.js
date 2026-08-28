const LOCAL_REPLIES = {
  "open_app": (data) => `Opening ${data.app || "application"} for you.`,
  "generate_dashboard_report": "Generating dashboard report.",
  "toggle_wifi_off": "Disconnecting network access.",
  "toggle_wifi_on": "Connection restored.",
  "take_screenshot": "Screenshot captured.",
  "toggle_screenshot": "Screenshot captured.",
  "start_screen_recording": "Recording has begun.",
  "stop_screen_recording": "Recording stopped.",
  "error": "Something went wrong."
};

export async function generateVoiceReply(action, data = {}) {
  // Quick local check
  const statePart = data.state ? `_${data.state}` : "";
  const key = action === "toggle_wifi" ? `toggle_wifi${statePart}` : action;
  
  if (LOCAL_REPLIES[key]) {
    return typeof LOCAL_REPLIES[key] === "function" ? LOCAL_REPLIES[key](data) : LOCAL_REPLIES[key];
  }

  const API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
  if (!API_KEY) {
    console.error("Gemini API Key not found for voice reply generation.");
    return `Performing ${action.replace(/_/g, ' ')}`;
  }

  const prompt = `You are "Sonix", a highly intelligent and sophisticated female AI assistant.
Your job is to generate a short, stylish, and professional voice reply.

IMPORTANT:
- Return ONLY plain text
- Keep it short (max 10 words)
- No emojis
- Sound confident, helpful, and slightly futuristic

========================
STYLE
========================
- Smart
- Calm
- Slightly futuristic
- Confident

========================
EXAMPLES
========================
Action: open_app chrome
Reply: Opening Chrome for you.

Action: toggle_wifi off
Reply: Disconnecting network access.

Action: toggle_wifi on
Reply: Connection restored.

Action: take_screenshot
Reply: Screenshot captured.

Action: start_screen_recording
Reply: Recording has begun.

Action: stop_screen_recording
Reply: Recording stopped.

Action: error
Reply: Something went wrong.

========================
INPUT
========================
Action: ${action}
Data: ${JSON.stringify(data)}
`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 50,
          }
        }),
      }
    );

    const result = await response.json();
    const reply = result.candidates?.[0]?.content?.parts?.[0]?.text || `Ok, ${action.replace(/_/g, ' ')}`;
    return reply.trim();
  } catch (error) {
    console.error("Failed to generate voice reply:", error);
    return `Action ${action} initiated.`;
  }
}
