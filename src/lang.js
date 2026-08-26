// Shared language config for the /language command + LLM reply steering.
// Balthazar is an LLM voice companion, so we steer the model's reply language
// rather than translating fixed strings. NOTE: the Piper TTS voice is currently
// English (en_US-kristin); non-English replies are spoken by that voice until
// language-specific Piper voices are added (separate infra task).
const LANGS = {
  en: { label: "English", name: "English" },
  es: { label: "Español", name: "Spanish" },
  "pt-br": { label: "Português (BR)", name: "Brazilian Portuguese" },
  fr: { label: "Français", name: "French" },
  de: { label: "Deutsch", name: "German" },
  vi: { label: "Tiếng Việt", name: "Vietnamese" },
  th: { label: "ไทย", name: "Thai" },
};

// Appended to the reply prompt to steer the language (empty for English).
function langLine(code) {
  if (!code || code === "en" || !LANGS[code]) return "";
  return ` Reply ENTIRELY in ${LANGS[code].name} (not English), keeping the same Balthazar personality.`;
}

module.exports = { LANGS, langLine };
