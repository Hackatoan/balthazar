const axios = require('axios');

const API_URL = 'https://api.anthropic.com/v1/messages';

const DEFAULT_PERSONA = [
  'You are Balthazar, a Discord voice-chat companion hanging out in a live voice call.',
  'Your replies are SPOKEN ALOUD by a text-to-speech voice, so:',
  '- Keep it to one or two short sentences. Never use lists, markdown, emoji, or code.',
  '- Sound natural and conversational, a little witty and dry, never robotic.',
  '- Spell things out for speech (say "twenty twenty six", not "2026").',
  '- You are hearing imperfect speech-to-text transcripts; if something is garbled, roll with it or ask a short clarifying question.',
  'Do not narrate actions or describe yourself. Just say the reply.',
].join('\n');

// Reuses the Claude Code OAuth token (sk-ant-oat...) from the Lamar/lamarlive setup.
class ClaudeClient {
  constructor(opts = {}) {
    this.token = opts.token || process.env.ANTHROPIC_OAUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
    this.model = opts.model || process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
    this.persona = opts.persona || process.env.TALK_PERSONA || DEFAULT_PERSONA;
    this.enabled = !!this.token;
  }

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
    const userContent =
      ctxLine +
      'Here is the recent voice chat (speech-to-text, may be imperfect):\n' +
      lines.join('\n') +
      '\n\nReply as Balthazar with one or two short spoken sentences.';

    try {
      const res = await axios.post(
        API_URL,
        {
          model: this.model,
          max_tokens: 160,
          system: this.persona,
          messages: [{ role: 'user', content: userContent }],
        },
        {
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'oauth-2025-04-20',
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        }
      );
      const blocks = res.data?.content || [];
      let text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
      text = text.replace(/^\s*balthazar\s*:\s*/i, '').trim();
      return text;
    } catch (e) {
      const status = e?.response?.status;
      const msg = e?.response?.data?.error?.message || e?.message || String(e);
      if (status === 401 || status === 403) {
        console.warn('[claude] AUTH failed — the Claude OAuth token may have expired/rotated. Re-copy it.');
      } else if (status === 429) {
        console.warn('[claude] rate/usage limit hit — no reply.');
      } else {
        console.warn('[claude] reply error:', status || '', msg);
      }
      return '';
    }
  }
}

module.exports = ClaudeClient;
