const os = require('os');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const GeminiClient = require('./GeminiClient');

const ASR_URL = process.env.ASR_URL || 'http://balthazar-asr:5005/transcribe';
const PIPER_URL = process.env.PIPER_URL || 'http://balthazar-piper:5006/synthesize';

const ALWAYS_RESPOND = process.env.TALK_ALWAYS_RESPOND === '1';
const FOLLOWUP_MS = Number(process.env.TALK_FOLLOWUP_MS || 25000);
const HISTORY_MAX = Number(process.env.TALK_HISTORY || 12);
const MIN_CHARS = Number(process.env.TALK_MIN_CHARS || 2);

// Balthazar hears his name; whisper often mangles it, so accept close variants.
const NAME_RE = /\b(bal|balthazar|balthasar|balthzar|baltazar|balthizar)\b/i;

// 48kHz stereo int16 -> 16kHz mono int16 (3:1 decimation with a light average).
function downsampleTo16kMono(pcm48kStereo) {
  const numSamples = Math.floor(pcm48kStereo.length / 2);
  const out = new Int16Array(Math.floor(numSamples / 3));
  let o = 0;
  for (let i = 0; i + 2 < numSamples; i += 3) {
    let sum = 0;
    for (let j = 0; j < 3; j++) {
      const idx = (i + j) * 2;
      sum += (pcm48kStereo[idx] + pcm48kStereo[idx + 1]) / 2;
    }
    out[o++] = sum / 3;
  }
  return out;
}

function normalizeToTargetRms(int16, targetRms = 0.1, maxGain = 6.0) {
  if (int16.length === 0) return int16;
  let sumSq = 0;
  for (let i = 0; i < int16.length; i++) {
    const n = int16[i] / 32768.0;
    sumSq += n * n;
  }
  const rms = Math.sqrt(sumSq / int16.length);
  if (rms < 0.0001) return int16;
  let gain = targetRms / rms;
  if (gain > maxGain) gain = maxGain;
  if (gain < 1.0) return int16;
  const out = new Int16Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    out[i] = Math.max(-32768, Math.min(32767, Math.floor(int16[i] * gain)));
  }
  return out;
}

class TalkManager {
  constructor(guildManager, webUI) {
    this.guildManager = guildManager;
    this.webUI = webUI;
    this.gemini = new GeminiClient();
    this.states = new Map(); // guildId -> { history, turn, lastRespondedAt }
  }

  get configured() {
    return this.gemini.enabled;
  }

  _state(guildId) {
    if (!this.states.has(guildId)) {
      this.states.set(guildId, { history: [], turn: 0, lastRespondedAt: 0 });
    }
    return this.states.get(guildId);
  }

  isActive(guildId) {
    return this.guildManager.getGuildState(guildId).talkActive === true;
  }

  setActive(guildId, on) {
    const gs = this.guildManager.getGuildState(guildId);
    gs.talkActive = !!on;
    if (!on) {
      this.guildManager.stopSpeaking(guildId);
      const s = this._state(guildId);
      s.turn++;
      s.history = [];
    }
    return gs.talkActive;
  }

  // Called when a user starts speaking while Balthazar is talking -> stop and yield.
  bargeIn(guildId) {
    const s = this._state(guildId);
    s.turn++;
    this.guildManager.stopSpeaking(guildId);
  }

  _pushHistory(guildId, entry) {
    const s = this._state(guildId);
    s.history.push(entry);
    if (s.history.length > HISTORY_MAX) s.history.shift();
  }

  _shouldRespond(guildId, text) {
    if (!text || text.replace(/[^a-z0-9]/gi, '').length < MIN_CHARS) return false;
    if (ALWAYS_RESPOND) return true;
    if (NAME_RE.test(text)) return true;
    const s = this._state(guildId);
    if (Date.now() - s.lastRespondedAt < FOLLOWUP_MS) return true; // mid-conversation
    return false;
  }

  async _transcribe(pcm48kStereo) {
    // Require ~0.3s of audio (48k stereo -> 0.3 * 96000 samples).
    if (!pcm48kStereo || pcm48kStereo.length < 96000 * 0.3) return '';
    let mono = downsampleTo16kMono(pcm48kStereo);
    mono = normalizeToTargetRms(mono, 0.1, 6.0);
    try {
      const res = await axios.post(ASR_URL, Buffer.from(mono.buffer), {
        headers: { 'Content-Type': 'application/octet-stream' },
        timeout: 20000,
      });
      return String(res.data?.text || '').trim();
    } catch (_) {
      return '';
    }
  }

  async _synthesize(text) {
    try {
      const res = await axios.post(PIPER_URL, { text }, {
        responseType: 'arraybuffer',
        timeout: 20000,
      });
      return Buffer.from(res.data);
    } catch (e) {
      console.warn('[talk] tts error:', e?.message || e);
      return null;
    }
  }

  // pcm48kStereo: Int16Array of one speaker's utterance (captured in GuildManager).
  async onUtterance(guildId, userId, name, pcm48kStereo) {
    if (!this.isActive(guildId)) return;

    const text = await this._transcribe(pcm48kStereo);
    if (!text) { console.log(`[talk] ${name}: <no transcript>`); return; }
    console.log(`[talk] heard ${name}: "${text}"`);

    this._pushHistory(guildId, { name, text, bot: false });
    try {
      this.webUI?.emitToAll('transcript', { guildId, userId, username: name, text, timestamp: Date.now() });
    } catch (_) {}

    if (!this._shouldRespond(guildId, text)) { console.log('[talk] not addressed, ignoring'); return; }
    if (!this.configured) return;

    const s = this._state(guildId);
    const myTurn = ++s.turn; // claim this turn; a newer utterance or barge-in supersedes

    const reply = await this.gemini.reply(s.history);
    if (myTurn !== s.turn) { console.log('[talk] superseded, dropping reply'); return; }
    if (!reply) { console.log('[talk] empty gemini reply'); return; }
    console.log(`[talk] reply: "${reply}"`);

    this._pushHistory(guildId, { name: 'Balthazar', text: reply, bot: true });
    await this._speak(guildId, reply, myTurn);
  }

  async _speak(guildId, text, myTurn) {
    const wav = await this._synthesize(text);
    const s = this._state(guildId);
    if (!wav || myTurn !== s.turn) return; // barge-in happened while synthesizing

    const dir = path.join(os.tmpdir(), 'balthazar-tts');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    const file = path.join(dir, `tts-${guildId}-${Date.now()}.wav`);
    try { fs.writeFileSync(file, wav); } catch (e) { console.warn('[talk] write tts:', e?.message); return; }

    const cleanup = () => { try { fs.unlinkSync(file); } catch (_) {} };

    console.log(`[talk] speaking (${wav.length} bytes) in ${guildId}`);
    this.guildManager.setBotSpeaking(guildId, true);
    this.guildManager.playFileFromDisk(
      guildId,
      file,
      null,
      () => { // onEnd
        this.guildManager.setBotSpeaking(guildId, false);
        s.lastRespondedAt = Date.now();
        cleanup();
      },
      (err) => { // onError
        console.warn('[talk] play error:', err?.message || err);
        this.guildManager.setBotSpeaking(guildId, false);
        cleanup();
      }
    );
  }
}

module.exports = TalkManager;
