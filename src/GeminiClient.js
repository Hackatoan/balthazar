const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

const DEFAULT_PERSONA = [
  'You are Balthazar, a Discord voice-chat companion hanging out in a live voice call.',
  'Your replies are SPOKEN ALOUD by a text-to-speech voice, so:',
  '- Keep it to one or two short sentences. Never use lists, markdown, emoji, or code.',
  '- Sound natural and conversational, a little witty and dry, never robotic.',
  '- Spell things out for speech (say "twenty twenty six", not "2026").',
  '- You are hearing imperfect speech-to-text transcripts; if something is garbled, roll with it or ask a short clarifying question.',
  'Do not narrate actions or describe yourself. Just say the reply.'
].join('\n');

const SAFETY = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
].map((category) => ({ category, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH }));

class GeminiClient {
  constructor(opts = {}) {
    this.apiKey = opts.apiKey || process.env.GEMINI_API_KEY || '';
    this.modelName = opts.model || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    this.persona = opts.persona || process.env.TALK_PERSONA || DEFAULT_PERSONA;
    this.enabled = !!this.apiKey;

    if (this.enabled) {
      const genAI = new GoogleGenerativeAI(this.apiKey);
      this.model = genAI.getGenerativeModel({
        model: this.modelName,
        systemInstruction: this.persona,
        safetySettings: SAFETY,
        // thinkingBudget 0 disables 2.5's "thinking" step — much lower latency for chat.
        generationConfig: { temperature: 0.9, maxOutputTokens: 160, thinkingConfig: { thinkingBudget: 0 } },
      });
    }
  }

  /**
   * history: array of { name, text, bot } (oldest-first), latest turn included last.
   * Returns a short spoken reply string, or '' if nothing usable.
   */
  async reply(history, context) {
    if (!this.enabled) return '';
    const lines = (history || []).map((t) =>
      t.bot ? `Balthazar: ${t.text}` : `${t.name}: ${t.text}`
    );
    let ctxLine = '';
    if (context) {
      const who = (context.participants || []).filter(Boolean).join(', ');
      const parts = [];
      if (context.channelName) parts.push(`the "${context.channelName}" voice channel`);
      if (who) parts.push(`with: ${who}`);
      if (parts.length) ctxLine = `You are in ${parts.join(' ')}.\n`;
    }
    const prompt =
      ctxLine +
      'Here is the recent voice chat (speech-to-text, may be imperfect):\n' +
      lines.join('\n') +
      '\n\nReply as Balthazar with one or two short spoken sentences.';

    try {
      const result = await this.model.generateContent(prompt);
      let text = (result.response.text() || '').trim();
      // Strip any accidental "Balthazar:" prefix the model might add.
      text = text.replace(/^\s*balthazar\s*:\s*/i, '').trim();
      return text;
    } catch (e) {
      const msg = e?.message || String(e);
      if (/429|quota|rate/i.test(msg)) {
        console.warn('[gemini] QUOTA/RATE LIMIT hit — no reply. Free tier is very limited; consider a billing-enabled key.');
      } else {
        console.warn('[gemini] reply error:', msg);
      }
      return '';
    }
  }
}

module.exports = GeminiClient;
