const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
// Optional shared secret gating the control-plane socket (clip requests, "say"
// TTS, mic injection into the live voice channel, and file uploads). Without
// it, anyone who can reach this port can drive those actions anonymously.
const WEB_UI_TOKEN = process.env.WEB_UI_TOKEN || '';

class WebUI {
  constructor() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.io = new Server(this.server);
    this.setupExpress();
    this.setupSocketIO();
  }

  setupExpress() {
    this.app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      next();
    });
    this.app.use(express.static(path.join(__dirname, '..', 'public')));
  }

  setupSocketIO() {
    if (WEB_UI_TOKEN) {
      this.io.use((socket, next) => {
        const provided = (socket.handshake.auth && socket.handshake.auth.token)
          || socket.handshake.query.token;
        if (provided === WEB_UI_TOKEN) return next();
        next(new Error('unauthorized'));
      });
    } else {
      console.warn('[web] WEB_UI_TOKEN is not set — the control panel (clip requests, "say" TTS, mic injection into the live voice channel, uploads) accepts commands from anyone who can reach this port, with no login. Set WEB_UI_TOKEN in .env to require a shared secret; visit the panel once with ?token=<value> and the browser remembers it.');
    }

    this.io.on('connection', (socket) => {
      console.log('[web] client connected');

      socket.on('set_clip_channel', (payload) => {
        if (this.onSetClipChannel) {
          this.onSetClipChannel(payload, socket);
        }
      });

      socket.on('play_upload', (payload) => {
        if (this.onPlayUpload) {
          this.onPlayUpload(payload, socket);
        }
      });

      socket.on('clip_request', (payload) => {
        if (this.onClipRequest) this.onClipRequest(payload, socket);
      });

      socket.on('assign_clip_to_user', (payload) => {
        if (this.onAssignClip) this.onAssignClip(payload, socket);
      });

      socket.on('remove_user_clip', (payload) => {
        if (this.onRemoveClip) this.onRemoveClip(payload, socket);
      });

      socket.on('set_user_volume', (payload) => {
        if (this.onSetUserVolume) this.onSetUserVolume(payload, socket);
      });

      socket.on('mic_start', (payload) => {
        if (this.onMicStart) this.onMicStart(payload, socket);
      });

      socket.on('mic_audio', (payload) => {
        if (this.onMicAudio) this.onMicAudio(payload, socket);
      });

      socket.on('mic_stop', (payload) => {
        if (this.onMicStop) this.onMicStop(payload, socket);
      });

      socket.on('say_text', (payload) => {
        if (this.onSayText) this.onSayText(payload, socket);
      });

      socket.on('replay_clip', (payload) => {
        if (this.onReplayClip) this.onReplayClip(payload, socket);
      });

      // Lets index.js push a new connection's initial state (clip history,
      // saved per-user volumes) without WebUI needing to know what those are.
      if (this.onClientConnected) this.onClientConnected(socket);
    });
  }

  // True when at least one browser is connected (used to gate live-audio streaming).
  hasClients() {
    try { return this.io.engine.clientsCount > 0; } catch (_) { return false; }
  }

  start() {
    this.server.listen(PORT, () => {
      console.log(`Web server running on http://localhost:${PORT}`);
    });
  }

  updateWebMembers(channel, guildId) {
    let textChannels = [];
    let clipChannelId = null;
    if (this.guildManager && channel) {
        textChannels = Array.from(channel.guild.channels.cache.values())
            .filter(c => c.type === 0)
            .map(c => ({ id: c.id, name: c.name }));
        const config = this.guildManager.getConfig(channel.guild.id);
        clipChannelId = config.clipChannelId || null;
    }

    let currentMembers = [];
    let channelObj = null;
    if (channel) {
      currentMembers = Array.from(channel.members.values()).map(m => ({
        id: m.id,
        username: m.user.username,
        bot: m.user.bot,
        avatar: m.user.displayAvatarURL({ format: 'png', size: 64 })
      }));
      channelObj = { id: channel.id, name: channel.name, guildId: channel.guild.id };
    }
    // We emit guild-specific updates. Clients can filter based on guildId if needed.
    this.io.emit('update', {
      channel: channelObj,
      members: currentMembers,
      textChannels,
      clipChannelId
    });
  }

  emitToAll(event, data) {
    this.io.emit(event, data);
  }
}

module.exports = WebUI;
