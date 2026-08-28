import { callGemini, geminiAvailable } from "./geminiConfig";
export async function detectWakeWord(userCommand) {
  if (!userCommand || userCommand.trim().length === 0) {
    return { wake: false };
  }

  if (!(await geminiAvailable())) {
    console.warn("Gemini API Key for wake-word detection not found.");
    // Fast local fallback for basic variations
    const lower = userCommand.toLowerCase();
    const isWake = lower.includes("sonix") || lower.includes("hey") || lower.includes("hi");
    return { wake: isWake };
  }

  const prompt = `You are a wake-word detection assistant. Your job is to detect if the user is trying to activate the assistant.

IMPORTANT:
- Return ONLY JSON
- No explanation

========================
RULES
========================
- If user says "hey sonix", "hi sonix", "ok sonix", "sonix" -> activate
- Ignore other sentences
- Be slightly flexible (handle small variations)

========================
OUTPUT FORMAT
========================
IF ACTIVATED:
{ "wake": true }

IF NOT:
{ "wake": false }

========================
EXAMPLES
========================
User: hey sonix
{ "wake": true }

User: hi sonix
{ "wake": true }

User: sonix open chrome
{ "wake": true }

User: open chrome
{ "wake": false }

========================
USER INPUT
========================
"${userCommand}"
`;

  try {
    const result = await callGemini({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 20,
      }
    });
    let aiText = result.candidates?.[0]?.content?.parts?.[0]?.text || '{"wake": false}';
    aiText = aiText.replace(/```json/gi, "").replace(/```/g, "").trim();
    
    return JSON.parse(aiText);
  } catch (error) {
    console.error("Failed to detect wake word:", error);
    return { wake: false };
  }
}
