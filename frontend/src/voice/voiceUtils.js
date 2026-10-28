let defaultFemaleVoice = null;

export function loadVoices() {
  if (typeof window === "undefined" || !window.speechSynthesis) return;

  const voices = window.speechSynthesis.getVoices();
  if (voices.length > 0) {
    const preferredFemaleVoices = [
      "Microsoft Zira",
      "Google English Female",
      "Google UK English Female",
      "Google US English Female",
      "Samantha",
      "Victoria",
      "Karen",
      "Moira",
      "Tessa"
    ];

    for (const name of preferredFemaleVoices) {
      const voice = voices.find(v => v.name.includes(name));
      if (voice) {
        defaultFemaleVoice = voice;
        break;
      }
    }

    if (!defaultFemaleVoice) {
      defaultFemaleVoice = voices.find(v => v.name.toLowerCase().includes("female") || v.name.toLowerCase().includes("girl"));
    }

    if (!defaultFemaleVoice) {
      // Fallback: look for a neutral/pleasing voice if no female is found
      defaultFemaleVoice = voices.find(v => v.lang.startsWith("en"));
    }
  }
}

// Initial load
if (typeof window !== "undefined" && window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => {
    loadVoices();
  };
  loadVoices();
}

// What Sonix said last, so speechRecognition.js can drop it if the mic picks it up from
// the speakers.
let lastSpoken = { words: [], at: 0 };

// Lowercase words without punctuation: "Wi-Fi," -> "wifi", "I'm" -> "im".
const normalizeWords = (text) =>
  text
    .split(/\s+/)
    .map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);

/** Call whenever Sonix speaks. */
export function rememberSpoken(text) {
  lastSpoken = { words: normalizeWords(text), at: Date.now() };
}

/**
 * Removes Sonix's own reply from the start of a transcript ("I'm here. Open Chrome." ->
 * "Open Chrome.") when the mic picked it up from the speakers. The recording may hold
 * just the end of the reply, so it looks for the reply's last words. Returns "" when
 * the transcript is nothing but the reply.
 */
export function stripOwnSpeech(transcript) {
  const said = lastSpoken.words;
  if (!said.length || Date.now() - lastSpoken.at > 15000) return transcript;
  const heard = transcript
    .trim()
    .split(/\s+/)
    .map((raw) => ({ raw, word: normalizeWords(raw)[0] }))
    .filter((t) => t.word);
  for (let k = Math.min(heard.length, said.length); k > 0; k--) {
    // One shared word could be the user ("Chrome" after "Opening Chrome"); need two,
    // unless the whole reply was a single word.
    if (k < 2 && said.length > 1) break;
    if (heard.slice(0, k).every((t, i) => t.word === said[said.length - k + i])) {
      return heard.slice(k).map((t) => t.raw).join(" ");
    }
  }
  return transcript;
}

export function speakText(text, options = {}) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;

  rememberSpoken(text);

  // Cancel any ongoing speech
  window.speechSynthesis.cancel();
  
  const utterance = new SpeechSynthesisUtterance(text);
  
  // Try to find voice if not already found
  if (!defaultFemaleVoice) {
    loadVoices();
  }

  if (defaultFemaleVoice) {
    utterance.voice = defaultFemaleVoice;
  }

  // Settings
  utterance.rate = options.rate || 1.1; // Slightly faster for responsiveness
  utterance.pitch = options.pitch || 1.1; // Slightly higher pitch for a "girl's voice"
  utterance.volume = options.volume || 1.0;

  window.speechSynthesis.speak(utterance);
}
