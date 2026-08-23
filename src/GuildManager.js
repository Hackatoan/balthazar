const { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior, StreamType, AudioPlayerStatus, VoiceConnectionStatus, entersState, EndBehaviorType } = require('@discordjs/voice');
const { spawn } = require('child_process');
const prism = require('prism-media');
const fs = require('fs');
const path = require('path');
const wav = require('wav');

const CLIP_SECONDS = 30;
const CLIP_SAMPLE_RATE = 48000;
const CLIP_CHANNELS = 2;
const MIN_STABLE_MS = 3000;
const TOTAL_CLIP_SAMPLES = CLIP_SAMPLE_RATE * CLIP_CHANNELS * CLIP_SECONDS;

// Discord's speaking.on('start') fires on ANY detected audio from a user's mic —
// brief blips, background noise, someone else's own aside to a different person —
// not just meaningful sustained speech. Barge-in used to act on it immediately and
// unconditionally, so in a livelier/quicker conversation basically any of that
// noise from ANYONE cut the bot off mid-reply, whether or not it was actually
// meant to interrupt it. Wait this long to see if the person is STILL talking
// before actually committing to the interruption — filters brief noise without
// meaningfully hurting responsiveness for a genuine "ok stop, let me talk" case.
const BARGE_IN_DEBOUNCE_MS = Number(process.env.TALK_BARGE_IN_DEBOUNCE_MS || 300);

// The debounce above only filters brief blips — it doesn't help when someone's
// mic is picking up a bit of the bot's own TTS output off their speakers
// (no/imperfect echo cancellation), since that's sustained for as long as the
// bot keeps talking, same as real speech would be. Confirmed directly in logs:
// barge-in was firing within 0.5-2.6s of nearly every single reply, almost
// always with no real transcript in between. Acoustic bleed through a room is
// real signal loss, so it should come through measurably quieter than someone
// actually talking into their mic — require the accumulated RMS over the
// debounce window to also clear this floor. Raw int16 PCM scale (0-32768), not
// normalized. No real audio to calibrate against ahead of time, so every
// decision logs its actual computed value — tune this from real numbers once
// there's a session's worth of them, don't guess twice.
const BARGE_IN_MIN_RMS = Number(process.env.TALK_BARGE_IN_MIN_RMS || 300);

const KEEP_UPLOADS = process.env.KEEP_UPLOADS === '1';

// Shared config loading
const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_FILE = path.join(__dirname, '..', 'clips-config.json');

let config = { guilds: {}, dmPrefs: {} };
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      config = JSON.parse(data);
    }
  } catch (e) { console.error('[config] load error:', e); }
  if (!config.guilds) config.guilds = {};
  if (!config.dmPrefs) config.dmPrefs = {};
}
function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }
  catch (e) { console.error('[config] save error:', e); }
}
loadConfig();

const USER_CLIPS_FILE = path.join(DATA_DIR, 'user-clips.json');
let userClips = {};
function loadUserClips() {
  try {
    if (fs.existsSync(USER_CLIPS_FILE)) {
      userClips = JSON.parse(fs.readFileSync(USER_CLIPS_FILE, 'utf8'));
    }
  } catch (e) { console.error('[clips] load error:', e); }
}
function saveUserClips() {
  try { fs.writeFileSync(USER_CLIPS_FILE, JSON.stringify(userClips, null, 2)); }
  catch (e) { console.error('[clips] save error:', e); }
}
loadUserClips();

class GuildManager {
  constructor(client, webUI) {
    this.client = client;
    this.webUI = webUI;
    this.guilds = new Map();
    this.talkManager = null; // set by index.js after construction
    // Legacy support logic that still relies on file-level state
    this.userJoinTimestamps = {};
  }

  getConfig(guildId) {
      if(!config.guilds[guildId]) {
          config.guilds[guildId] = {};
          saveConfig();
      }
      return config.guilds[guildId];
  }

  setConfig(guildId, key, value) {
      if(!config.guilds[guildId]) {
          config.guilds[guildId] = {};
      }
      config.guilds[guildId][key] = value;
      saveConfig();
  }

  getDmPrefs(userId) {
      return config.dmPrefs[userId];
  }

  setDmPrefs(userId, value) {
      config.dmPrefs[userId] = value;
      saveConfig();
  }

  getGuildState(guildId) {
    if (!this.guilds.has(guildId)) {
      this.guilds.set(guildId, {
        currentChannelId: null,
        currentConnection: null,
        currentPlayer: null,
        userRings: new Map(),
        activeStreams: new Map(),
        transcriptContextByUser: new Map(),
        lastClipTriggerByUser: new Map(),
        transcriptHistoryByUser: new Map(),
        // /talk conversational mode
        talkActive: false,
        botSpeaking: false,
        speakingUsers: new Set(), // userIds Discord currently reports as transmitting
        speakingEnergy: new Map(), // userId -> { sumSq, count } accumulated during the current speaking burst
        utterBuf: new Map() // userId -> { chunks: number[], len: number, name: string }
      });
    }
    return this.guilds.get(guildId);
  }

  setBotSpeaking(guildId, on) {
    this.getGuildState(guildId).botSpeaking = !!on;
  }

  stopSpeaking(guildId) {
    const state = this.getGuildState(guildId);
    state.botSpeaking = false;
    try { if (state.currentPlayer) state.currentPlayer.stop(true); } catch (_) {}
  }

  // Who/where Balthazar is talking to right now, for LLM context.
  getCallContext(guildId) {
    const state = this.getGuildState(guildId);
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild || !state.currentChannelId) return null;
    const ch = guild.channels.cache.get(state.currentChannelId);
    if (!ch) return null;
    const botId = this.client.user?.id;
    const participants = Array.from(ch.members.values())
      .filter((m) => m.id !== botId && !m.user.bot)
      .map((m) => m.user.username);
    return { channelName: ch.name, guildName: guild.name, participants };
  }

  checkEligibleChannels() {
    this.client.guilds.cache.forEach(guild => {
      if (!this.userJoinTimestamps[guild.id]) this.userJoinTimestamps[guild.id] = {};
      const now = Date.now();
      guild.channels.cache.forEach(channel => {
        if (channel.type === 2) {
          for (const [userId, member] of channel.members) {
            if (!this.userJoinTimestamps[guild.id][userId]) {
              this.userJoinTimestamps[guild.id][userId] = now;
            }
          }
        }
      });

      const state = this.getGuildState(guild.id);
      const channel = this.getMostPopulatedVoiceChannel(guild);

      if (state.currentChannelId) {
        const curr = guild.channels.cache.get(state.currentChannelId);
        const isEmpty = !curr || (curr.members && Array.from(curr.members.values()).filter(m => m.id !== this.client.user.id).length === 0);
        if (isEmpty) {
          state.emptyCheckCount = (state.emptyCheckCount || 0) + 1;
          if (state.emptyCheckCount >= 3) {
            state.emptyCheckCount = 0;
            this.leaveVoiceChannel(guild.id, 'periodic-empty');
          }
        } else {
          state.emptyCheckCount = 0;
        }
      }

      if (!state.currentChannelId && channel && channel.members && channel.members.size > 0) {
        const botId = this.client.user.id;
        const now2 = Date.now();
        const realMembers = Array.from(channel.members.values()).filter(m => m.id !== botId);
        const joinMap = this.userJoinTimestamps[guild.id] || {};
        const hasStable = realMembers.some(m => joinMap[m.id] && (now2 - joinMap[m.id]) >= MIN_STABLE_MS);
        if (realMembers.length > 0 && hasStable) {
          this.joinAndMonitor(channel);
        }
      }

      if (state.currentChannelId) {
        const channel = guild.channels.cache.get(state.currentChannelId);
        if (channel) this.webUI.updateWebMembers(channel);
      }
    });
  }

  getMostPopulatedVoiceChannel(guild) {
    let maxMembers = 0;
    let targetChannel = null;
    const now = Date.now();
    const gcfg = config.guilds[guild.id] || {};
    const ignored = new Set(gcfg.ignoredVoiceChannels || []);

    guild.channels.cache.forEach(channel => {
      if (channel.type === 2) {
        if (ignored.has(channel.id)) return;
        let count = 0;
        for (const [userId, member] of channel.members) {
          const joinMap = this.userJoinTimestamps[guild.id] || {};
          if (this.client.user && userId === this.client.user.id) continue;
          if (joinMap[userId] && now - joinMap[userId] >= MIN_STABLE_MS) {
            count++;
          }
        }
        if (count > maxMembers) {
          maxMembers = count;
          targetChannel = channel;
        }
      }
    });
    return targetChannel;
  }

  handleVoiceStateUpdate(oldState, newState) {
    const guild = newState.guild;
    const state = this.getGuildState(guild.id);
    if (!state.currentChannelId) return;
    const channel = guild.channels.cache.get(state.currentChannelId);
    if (channel) this.webUI.updateWebMembers(channel);
  }

  joinAndMonitor(channel) {
    const guildId = channel.guild.id;
    const state = this.getGuildState(guildId);

    console.log(`[voice][${guildId}] joining channel ${channel.id} ${channel.name}`);
    state.currentChannelId = channel.id;
    this.webUI.updateWebMembers(channel);

    state.currentConnection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });

    try {
      state.currentConnection.on('stateChange', (oldS, newS) => {
        console.log(`[voice][${guildId}] connection stateChange: ${oldS?.status} -> ${newS?.status}`);
      });
    } catch (_) {}

    if (!state.currentPlayer) {
      state.currentPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
      try {
        state.currentPlayer.on('stateChange', (o, n) => console.log(`[voice][${guildId}] player stateChange: ${o?.status} -> ${n?.status}`));
        state.currentPlayer.on('error', (e) => console.warn(`[voice][${guildId}] player error: ${e?.message || e}`));
      } catch (_) {}
    }
    try {
      state.currentConnection.subscribe(state.currentPlayer);
      console.log(`[voice][${guildId}] subscribed player to connection`);
    } catch (e) {
      console.warn(`[voice][${guildId}] subscribe error: ${e?.message}`);
    }

    entersState(state.currentConnection, VoiceConnectionStatus.Ready, 15000)
      .then(() => console.log(`[voice][${guildId}] connection Ready`))
      .catch((e) => console.warn(`[voice][${guildId}] connection not ready: ${e?.message || e}`));

    const receiver = state.currentConnection.receiver;
    receiver.speaking.on('start', (userId) => {
      const state = this.getGuildState(guildId);
      const userObj = this.client.users.cache.get(userId);
      if (userObj && userObj.bot) return;

      state.speakingUsers.add(userId);
      state.speakingEnergy.set(userId, { sumSq: 0, count: 0 });

      // Barge-in: if Balthazar is talking and a human starts, yield the floor —
      // but only if they're still actually talking after a short debounce (not
      // just a blip) AND it's loud enough to plausibly be them, not the bot's
      // own voice bleeding back in through their mic. See BARGE_IN_DEBOUNCE_MS /
      // BARGE_IN_MIN_RMS above for why.
      if (state.talkActive && state.botSpeaking && this.talkManager) {
        setTimeout(() => {
          const s = this.getGuildState(guildId);
          if (!s.talkActive || !s.botSpeaking || !s.speakingUsers.has(userId)) return;
          const e = s.speakingEnergy.get(userId);
          const rms = e && e.count > 0 ? Math.sqrt(e.sumSq / e.count) : 0;
          console.log(`[voice][${guildId}] barge-in candidate from ${userId}: rms=${rms.toFixed(0)} (min=${BARGE_IN_MIN_RMS})`);
          if (rms >= BARGE_IN_MIN_RMS) {
            this.talkManager.bargeIn(guildId);
          } else {
            console.log(`[voice][${guildId}] barge-in suppressed — too quiet, likely echo bleed`);
          }
        }, BARGE_IN_DEBOUNCE_MS);
      }

      if (state.activeStreams && state.activeStreams.has(userId)) return;
      const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
      const stream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 500 } });
      if (state.activeStreams) state.activeStreams.set(userId, true);

      // While /talk is active, buffer this utterance for speech-to-text.
      let utter = state.talkActive
        ? { chunks: [], len: 0, name: userObj ? userObj.username : userId }
        : null;

      // Guard: a receive-stream 'error' (e.g. a DAVE decrypt hiccup) must never crash the process.
      stream.on('error', (err) => {
        console.warn(`[voice][${guildId}] receive stream error for ${userId}: ${err?.message || err}`);
        if (state.activeStreams) state.activeStreams.delete(userId);
        try { decoder.destroy(); } catch (_) {}
        utter = null;
      });
      stream.pipe(decoder);
      decoder.on('data', chunk => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
        this.writeToUserRing(guildId, userId, pcm);
        // Fed to the barge-in energy check above — reset fresh on every speaking
        // 'start', accumulated here regardless of which 'start' originally set up
        // this decoder (a currently-live stream keeps feeding whatever the latest
        // reset accumulator is).
        const energy = state.speakingEnergy.get(userId);
        if (energy) {
          for (let i = 0; i < pcm.length; i++) energy.sumSq += pcm[i] * pcm[i];
          energy.count += pcm.length;
        }
        // Live web-panel monitor: stream decoded audio only while a browser is watching.
        if (this.webUI && this.webUI.hasClients && this.webUI.hasClients()) {
          this.webUI.emitToAll('audio', { userId, data: buf.toString('base64') });
        }
        if (utter && utter.len < 48000 * 2 * 20) { // cap ~20s of 48k stereo
          utter.chunks.push(pcm.slice()); // copy: decoder buffer is reused
          utter.len += pcm.length;
        }
      });
      decoder.on('end', () => {
        if (state.activeStreams) state.activeStreams.delete(userId);
        if (utter && utter.len > 0 && state.talkActive && this.talkManager) {
          const merged = new Int16Array(utter.len);
          let off = 0;
          for (const c of utter.chunks) { merged.set(c, off); off += c.length; }
          utter.chunks = null;
          this.talkManager.onUtterance(guildId, userId, utter.name, merged);
        }
        utter = null;
      });
      decoder.on('error', () => { if (state.activeStreams) state.activeStreams.delete(userId); });
    });

    receiver.speaking.on('end', (userId) => {
      const state = this.getGuildState(guildId);
      state.speakingUsers.delete(userId);
    });
  }

  leaveVoiceChannel(guildId, reason = '') {
    try {
      const state = this.getGuildState(guildId);
      console.log(`[voice][${guildId}] leaving voice channel ${state.currentChannelId || '(none)'} reason= ${reason}`);

      if (state.currentPlayer) {
        try { state.currentPlayer.stop(true); } catch (e) { console.warn(`[voice][${guildId}] currentPlayer.stop error:`, e?.message); }
        state.currentPlayer = null;
      }
      if (state.currentConnection) {
        try { state.currentConnection.destroy(); } catch (e) { console.warn(`[voice][${guildId}] connection.destroy error:`, e?.message); }
        state.currentConnection = null;
      }
      state.currentChannelId = null;
      state.userRings.clear();
      this.webUI.updateWebMembers(null, guildId);
    } catch (_) {}
  }

  writeToUserRing(guildId, userId, pcm16Stereo) {
    const state = this.getGuildState(guildId);
    let ring = state.userRings.get(userId);
    if (!ring) {
      ring = { buffer: new Int16Array(TOTAL_CLIP_SAMPLES), lastWriteTimeMs: 0, writePos: 0 };
      state.userRings.set(userId, ring);
    }
    const buf = ring.buffer;
    const now = Date.now();
    const pcmSamples = pcm16Stereo.length;

    // If this is the first packet or there has been a gap > 100ms, snap the writePos to the absolute time.
    // Otherwise, just advance writePos sequentially to avoid jitter/overlaps within continuous speech.
    const gapMs = ring.lastWriteTimeMs > 0 ? (now - ring.lastWriteTimeMs) : Infinity;

    if (gapMs > 100) {
      // Re-align to global clock based on Date.now()
      const endIndex = Math.floor(now * 96) % TOTAL_CLIP_SAMPLES;
      ring.writePos = (endIndex - pcmSamples + TOTAL_CLIP_SAMPLES) % TOTAL_CLIP_SAMPLES;

      // Clear the gap in the buffer from where we left off
      if (ring.lastWriteTimeMs > 0) {
        let gapSamplesToClear = Math.floor(gapMs * 96);
        if (gapSamplesToClear > TOTAL_CLIP_SAMPLES) gapSamplesToClear = TOTAL_CLIP_SAMPLES;
        let clearStartIndex = Math.floor(ring.lastWriteTimeMs * 96) % TOTAL_CLIP_SAMPLES;
        for (let i = 0; i < gapSamplesToClear; i++) {
          buf[(clearStartIndex + i) % TOTAL_CLIP_SAMPLES] = 0;
        }
      }
    }

    for (let i = 0; i < pcmSamples; i++) {
      buf[ring.writePos] = pcm16Stereo[i];
      ring.writePos = (ring.writePos + 1) % TOTAL_CLIP_SAMPLES;
    }

    // Since we write sequentially, the "effective" write time increments by exactly the duration of the packet
    if (gapMs > 100) {
      ring.lastWriteTimeMs = now;
    } else {
      ring.lastWriteTimeMs += (pcmSamples / 96);
    }
  }

  getLast30sMix(guildId, userIds) {
    const state = this.getGuildState(guildId);
    const result = new Float32Array(TOTAL_CLIP_SAMPLES);
    const now = Date.now();
    const cutoffMs = now - (CLIP_SECONDS * 1000);
    const endIndex = Math.floor(now * 96) % TOTAL_CLIP_SAMPLES;

    let mixedCount = 0;
    for (const uid of userIds) {
      const ring = state.userRings.get(uid);
      if (!ring) continue;
      if (ring.lastWriteTimeMs < cutoffMs) continue;

      for (let i = 0; i < TOTAL_CLIP_SAMPLES; i++) {
        const readIdx = (endIndex - TOTAL_CLIP_SAMPLES + i + TOTAL_CLIP_SAMPLES) % TOTAL_CLIP_SAMPLES;
        result[i] += ring.buffer[readIdx];
      }
      mixedCount++;
    }

    // Hard clamp / soft-limit to 16-bit integer range
    const finalResult = new Int16Array(TOTAL_CLIP_SAMPLES);
    for (let i = 0; i < TOTAL_CLIP_SAMPLES; i++) {
        let val = result[i];
        if (val > 32767) val = 32767;
        else if (val < -32768) val = -32768;
        finalResult[i] = val;
    }

    return finalResult;
  }

  addUserClip(userId, title, url, guildId) {
      if (!userClips[userId]) userClips[userId] = [];
      userClips[userId].push({ url, timestamp: Date.now(), title: title || '' });
      saveUserClips();
      this.webUI.emitToAll('user_clips_updated', { guildId, userId, clips: userClips[userId] });
  }

  removeUserClip(userId, url, guildId) {
      if (!userClips[userId]) return;
      userClips[userId] = userClips[userId].filter(e => e.url !== url);
      saveUserClips();
      this.webUI.emitToAll('user_clips_updated', { guildId, userId, clips: userClips[userId] });
  }

  getUserClips(userId) {
      return userClips[userId] || [];
  }

  _looksLikeTrigger(ctx) {
    // Exact and common spelling variants
    const nameVariants = [
      'balthazar', 'balthasar', 'baltazar', 'balthezar', 'balthaser',
      'bal thazar', 'bal tha zar', 'bal ta zar',
      // Whisper phonetic breakdowns seen in transcripts
      'about the czar', 'about tzar', 'about the tzar', 'about azar',
      'abouts are', 'alphas are', 'alpha czar', 'alpha tzar',
      'south is our', 'balth', 'bal',
    ];
    const hasName = nameVariants.some(v => ctx.includes(v));
    // "clip" must appear somewhere in the joined context
    const hasClip = /\bclip\b/.test(ctx);
    // czar/tzar alone near clip is strong enough (Whisper almost always renders the zar sound this way)
    const hasCzarWithClip = /\b(czar|tzar|azar)\b/.test(ctx) && hasClip;

    return (hasName && hasClip) || hasCzarWithClip;
  }

  shouldTriggerClipFromContext(guildId, userId) {
    const state = this.getGuildState(guildId);
    const now = Date.now();
    const last = state.lastClipTriggerByUser.get(userId) || 0;

    // Cooldown
    if (now - last < 15000) return false;

    const hist = state.transcriptHistoryByUser.get(userId) || [];
    const ctx = hist.join(' ').toLowerCase();

    if (!ctx) return false;

    if (this._looksLikeTrigger(ctx)) {
      state.lastClipTriggerByUser.set(userId, now);
      state.transcriptHistoryByUser.set(userId, []);
      return true;
    }
    return false;
  }

  async playFileFromDisk(guildId, filePath, onStart, onEnd, onError) {
    try {
      const state = this.getGuildState(guildId);
      if (!state.currentConnection) throw new Error('No voice connection');
      await entersState(state.currentConnection, VoiceConnectionStatus.Ready, 10000);
      if (!state.currentPlayer) {
        state.currentPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
        try { state.currentConnection.subscribe(state.currentPlayer); } catch (_) {}
      }

      const resource = createAudioResource(filePath);

      const started = () => { onStart && onStart(); try { state.currentPlayer.off(AudioPlayerStatus.Playing, started); } catch (_) {} };
      const ended = () => { onEnd && onEnd(); try { state.currentPlayer.off(AudioPlayerStatus.Idle, ended); } catch (_) {} };
      try { state.currentPlayer.removeAllListeners(AudioPlayerStatus.Playing); } catch (_) {}
      try { state.currentPlayer.removeAllListeners(AudioPlayerStatus.Idle); } catch (_) {}

      state.currentPlayer.on(AudioPlayerStatus.Playing, started);
      state.currentPlayer.on(AudioPlayerStatus.Idle, ended);
      // A fresh 'error' listener was added on every single call and never removed
      // (Playing/Idle self-remove on fire, but most calls never error, so those
      // never fire and pile up) — hit 11 accumulated listeners and Node's
      // MaxListenersExceededWarning during one real session. Track and remove the
      // specific previous handler instead of leaving it there forever; this does
      // NOT touch the permanent logger registered once at connection setup.
      if (state._playErrorHandler) { try { state.currentPlayer.off('error', state._playErrorHandler); } catch (_) {} }
      state._playErrorHandler = (err) => { onError && onError(err); };
      state.currentPlayer.on('error', state._playErrorHandler);

      state.currentPlayer.play(resource);
    } catch (e) {
      if (onError) onError(e);
    }
  }

  // For pre-resampled 48kHz stereo s16le PCM (i.e. Piper's /talk TTS output) only.
  // createAudioResource() on a bare file path defaults to spawning an ffmpeg
  // subprocess to transcode in real time as it plays — with zero CPU reservation
  // on a host where ASR/Piper themselves routinely spike well over 100% CPU each,
  // that subprocess is exactly what was glitching the bot's own voice mid-reply.
  // StreamType.Raw skips ffmpeg entirely: @discordjs/opus encodes the (already
  // final-format) PCM in-process, no subprocess, nothing to starve mid-stream.
  async playRawPcmFromDisk(guildId, filePath, onStart, onEnd, onError) {
    try {
      const state = this.getGuildState(guildId);
      if (!state.currentConnection) throw new Error('No voice connection');
      await entersState(state.currentConnection, VoiceConnectionStatus.Ready, 10000);
      if (!state.currentPlayer) {
        state.currentPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
        try { state.currentConnection.subscribe(state.currentPlayer); } catch (_) {}
      }

      const resource = createAudioResource(fs.createReadStream(filePath), { inputType: StreamType.Raw });

      const started = () => { onStart && onStart(); try { state.currentPlayer.off(AudioPlayerStatus.Playing, started); } catch (_) {} };
      const ended = () => { onEnd && onEnd(); try { state.currentPlayer.off(AudioPlayerStatus.Idle, ended); } catch (_) {} };
      try { state.currentPlayer.removeAllListeners(AudioPlayerStatus.Playing); } catch (_) {}
      try { state.currentPlayer.removeAllListeners(AudioPlayerStatus.Idle); } catch (_) {}

      state.currentPlayer.on(AudioPlayerStatus.Playing, started);
      state.currentPlayer.on(AudioPlayerStatus.Idle, ended);
      // See playFileFromDisk() above — same accumulating-listener fix.
      if (state._playErrorHandler) { try { state.currentPlayer.off('error', state._playErrorHandler); } catch (_) {} }
      state._playErrorHandler = (err) => { onError && onError(err); };
      state.currentPlayer.on('error', state._playErrorHandler);

      state.currentPlayer.play(resource);
    } catch (e) {
      if (onError) onError(e);
    }
  }

  async handleVoiceClipCommand(guildId, requestedByName, requestedById, titleOptional, targetUserId, triggerChannelId) {
      try {
          const state = this.getGuildState(guildId);
          const guild = this.client.guilds.cache.get(guildId);
          if (!guild || !state.currentChannelId) return;
          const voiceChan = guild.channels.cache.get(state.currentChannelId);
          if (!voiceChan) return;

          const now = Date.now();
          const cutoff = CLIP_SECONDS * 1000;
          const botId = this.client.user?.id;
          const gcfg = config.guilds[guild.id] || {};
          const includeBots = !!gcfg.clipBots;
          const windowStart = now - cutoff;

          const memberIds = Array.from(state.userRings.entries())
            .filter(([uid, ring]) => ring && ring.lastWriteTimeMs > windowStart)
            .filter(([uid]) => uid !== botId)
            .filter(([uid]) => includeBots || !(guild.members.cache.get(uid)?.user?.bot))
            .map(([uid]) => uid);

          if (memberIds.length === 0) return;

          const mixed = this.getLast30sMix(guildId, memberIds);

          const clipsDir = path.join(__dirname, '..', 'public', 'clips');
          if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });
          const filename = `clip-${Date.now()}.wav`;
          const filepath = path.join(clipsDir, filename);

          const writer = new wav.FileWriter(filepath, { channels: 2, sampleRate: 48000, bitDepth: 16 });
          const buf = Buffer.from(mixed.buffer);
          writer.write(buf);
          writer.end();

          writer.on('done', async () => {
              const fileUrl = `${process.env.CLIPS_BASE_URL || 'http://localhost:3000'}/clips/${filename}`;
              const titleText = titleOptional ? ` - ${titleOptional}` : '';

              let postedUrl = '';

              // Target clip to a specific user?
              const actualTargetUserId = targetUserId || requestedById;
              const dmPrefs = this.getDmPrefs(actualTargetUserId);

              if (dmPrefs) {
                  try {
                      const user = await this.client.users.fetch(actualTargetUserId);
                      if (user) {
                          const msg = await user.send({
                              content: `🎥 Voice Clip requested by **${requestedByName}**${titleText}`,
                              files: [filepath]
                          });
                          if (msg.attachments.size > 0) postedUrl = msg.attachments.first().url;
                      }
                  } catch (e) { console.error('Failed to DM clip:', e); }
              } else {
                  const targetChannelId = gcfg.clipChannelId || process.env.CLIPS_CHANNEL_ID || triggerChannelId;
                  if (targetChannelId) {
                      try {
                          const destChan = guild.channels.cache.get(targetChannelId);
                          if (destChan && typeof destChan.send === 'function') {
                              const titleLine = titleOptional ? ` - ${titleOptional}` : '';
                              const msg = await destChan.send({
                                  content: `🎬 **${requestedByName}** clipped the last 30s!${titleLine}`,
                                  files: [filepath]
                              });
                              if (msg.attachments.size > 0) postedUrl = msg.attachments.first().url;
                          }
                      } catch (e) { console.error('Failed to post clip to channel:', e); }
                  }
              }

              if (postedUrl) {
                  this.addUserClip(actualTargetUserId, titleOptional, postedUrl, guildId);
                  this.webUI.emitToAll('clip_posted', { guildId, url: postedUrl, filename, requestedBy: requestedByName, title: titleOptional });
              }

              if (!KEEP_UPLOADS && fs.existsSync(filepath)) {
                  setTimeout(() => { try { fs.unlinkSync(filepath); } catch (_) {} }, 5000);
              }
          });
      } catch (e) {
          console.error('[clip] error:', e);
      }
  }

}

module.exports = GuildManager;
