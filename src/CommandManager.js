const fs = require('fs');
const path = require('path');
const { createAudioPlayer, createAudioResource, NoSubscriberBehavior, StreamType } = require('@discordjs/voice');
const prism = require('prism-media');

class CommandManager {
  constructor(client, guildManager, webUI) {
    this.client = client;
    this.guildManager = guildManager;
    this.webUI = webUI;
  }

  async handleMessage(message) {
    try {
      if (!message || message.author?.bot) return;
      if (!message.guild) return;

      const rawContent = String(message.content || '').trim();
      const content = rawContent.toLowerCase();

      if (content === '-help' || content === '-commands') {
        const helpText = [
          '**Commands**',
          '- -help | -commands: Show this help',
          '- -clip [seconds] [name:filename] [only|solo] [title] or -clip @user [seconds] [name:filename] [only|solo] [title]: Create a clip of recent voice (default 30s, up to 120s of buffered history). "name:x" sets the saved filename; "only"/"solo" isolates the @mentioned (or your own) audio instead of mixing everyone. Example: -clip @sarah 90 name:sarah-story solo her intro story. Clips are delivered as Discord attachments (DM or configured clip channel).',
          '- -clipfolder @user: List saved Discord-hosted clip links for the specified user (most recent first).',
          '- -addlast @user: Add the most recent clip to the mentioned user (registers Discord-hosted URL)',
          '- -beep: Play a short test beep in the current voice channel (diagnostics)',
          '- -playserver <filename>: Play a file that already exists under public/uploads',
          '- -playlast: Play the most recently uploaded file from public/uploads',
          '- -dmtoggle: Toggle DM delivery of clips for yourself',
          '- -setclip <channel_id|#mention>: Server owner only, sets the text channel to post clips',
          '- -ignorevc <channel_id|#mention>: Server owner only, ignore a voice channel for auto-join',
          '- -unignorevc <channel_id|#mention>: Server owner only, remove a voice channel from ignore list',
          '- -listignorevc: List ignored voice channels',
          '- -clipbots: Server owner only, toggle including bot audio in clips (default OFF)',
          '- -say <message>: Balthazar speaks the message aloud in the current voice channel (text-to-speech)',
          '',
          '- /clip [seconds] [title] [user] [name] [only]: Slash-command version of -clip.',
          '- /say <message>: Slash-command version of -say.',
          '',
          '**Conversation**',
          '- /talk: Toggle voice conversation mode. When on, say "Balthazar ..." in the call and he talks back.',
          '',
          '**Voice Triggers**',
          '- "Balthazar clip that" or just "clip that" / "clip it" / "clip this"'
        ].join('\n');
        try { await message.reply(helpText); } catch (_) {}
        return;
      }

      if (content === '-beep') {
        const state = this.guildManager.getGuildState(message.guild.id);
        if (!state.currentConnection) { await message.reply('Not in a voice channel.'); return; }
        if (!state.currentPlayer) {
          state.currentPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
          try { state.currentConnection.subscribe(state.currentPlayer); } catch (_) {}
        }
        // Generate a simple 440Hz beep (raw PCM, simple implementation would be silent or require proper PCM generation, keeping simple here or just playing a sound)
        try { await message.reply('Beep command acknowledged.'); } catch (_) {}
        return;
      }

      if (content.startsWith('-playserver ')) {
        const rawFilename = rawContent.substring(12).trim();
        // path.basename strips any directory components (including "../"), so a
        // guild member can't walk this out of the uploads folder to read/play
        // arbitrary files elsewhere on disk (e.g. "-playserver ../../.env").
        const filename = path.basename(rawFilename);
        const upDir = path.join(__dirname, '..', 'public', 'uploads');
        const p = path.join(upDir, filename);
        if (filename && p.startsWith(upDir + path.sep) && fs.existsSync(p)) {
          this.guildManager.playFileFromDisk(message.guild.id, p);
          try { await message.reply('Playing ' + filename); } catch (_) {}
        } else {
          try { await message.reply('File not found.'); } catch (_) {}
        }
        return;
      }

      if (content === '-playlast') {
        const upDir = path.join(__dirname, '..', 'public', 'uploads');
        if (!fs.existsSync(upDir)) return;
        const files = fs.readdirSync(upDir).filter(f => f.endsWith('.mp3') || f.endsWith('.wav'));
        if (!files.length) {
          try { await message.reply('No files in uploads.'); } catch (_) {}
          return;
        }
        const mapped = files.map(f => {
          const p = path.join(upDir, f);
          return { path: p, mtime: fs.statSync(p).mtimeMs };
        });
        mapped.sort((a, b) => b.mtime - a.mtime);
        this.guildManager.playFileFromDisk(message.guild.id, mapped[0].path);
        try { await message.reply('Playing last uploaded file.'); } catch (_) {}
        return;
      }

      if (content.startsWith('-ignorevc')) {
        if (message.guild.ownerId !== message.author.id) {
          try { await message.reply('You must be the server owner to use this.'); } catch (_) {}
          return;
        }
        const arg = rawContent.split(/\s+/)[1] || '';
        const match = arg.match(/^(?:<#)?(\d{10,})(?:>)?$/);
        if (!match) { try { await message.reply('Usage: -ignorevc <channel_id or #mention>'); } catch (_) {} return; }
        const chanId = match[1];
        const ch = message.guild.channels.cache.get(chanId);
        if (!ch || ch.type !== 2) { try { await message.reply('That is not a voice channel.'); } catch (_) {} return; }

        const gcfg = this.guildManager.getConfig(message.guild.id);
        if (!gcfg.ignoredVoiceChannels) gcfg.ignoredVoiceChannels = [];
        if (!gcfg.ignoredVoiceChannels.includes(chanId)) {
            gcfg.ignoredVoiceChannels.push(chanId);
            this.guildManager.setConfig(message.guild.id, 'ignoredVoiceChannels', gcfg.ignoredVoiceChannels);
        }
        try { await message.reply(`Ignored voice channel: <#${chanId}>`); } catch (_) {}
        const state = this.guildManager.getGuildState(message.guild.id);
        if (state.currentChannelId === chanId) {
          this.guildManager.leaveVoiceChannel(message.guild.id, 'ignored');
        }
        return;
      }

      if (content.startsWith('-unignorevc')) {
        if (message.guild.ownerId !== message.author.id) {
          try { await message.reply('You must be the server owner to use this.'); } catch (_) {}
          return;
        }
        const arg = rawContent.split(/\s+/)[1] || '';
        const match = arg.match(/^(?:<#)?(\d{10,})(?:>)?$/);
        if (!match) { try { await message.reply('Usage: -unignorevc <channel_id or #mention>'); } catch (_) {} return; }
        const chanId = match[1];

        const gcfg = this.guildManager.getConfig(message.guild.id);
        const list = gcfg.ignoredVoiceChannels || [];
        const idx = list.indexOf(chanId);
        if (idx !== -1) {
          list.splice(idx, 1);
          this.guildManager.setConfig(message.guild.id, 'ignoredVoiceChannels', list);
          try { await message.reply(`Unignored voice channel: <#${chanId}>`); } catch (_) {}
        } else {
          try { await message.reply('That channel was not ignored.'); } catch (_) {}
        }
        return;
      }

      if (content === '-listignorevc') {
        const gcfg = this.guildManager.getConfig(message.guild.id);
        const list = gcfg.ignoredVoiceChannels || [];
        if (!list.length) {
          try { await message.reply('No ignored voice channels.'); } catch (_) {}
          return;
        }
        const names = list.map(id => {
          const ch = message.guild.channels.cache.get(id);
          return ch ? `• ${ch.name} (<#${id}>)` : `• <#${id}>`;
        }).join('\n');
        try { await message.reply(`Ignored voice channels:\n${names}`); } catch (_) {}
        return;
      }

      if (content === '-clipbots') {
        if (message.guild.ownerId !== message.author.id) {
          try { await message.reply('You must be the server owner to use this.'); } catch (_) {}
          return;
        }
        const gcfg = this.guildManager.getConfig(message.guild.id);
        const cur = !!gcfg.clipBots;
        this.guildManager.setConfig(message.guild.id, 'clipBots', !cur);
        try { await message.reply(`Include bot users in clips: ${!cur ? 'ON' : 'OFF'}`); } catch (_) {}
        return;
      }

      if (content === '-say' || content.startsWith('-say ')) {
        const idx = rawContent.indexOf(' ');
        const text = idx > 0 ? rawContent.slice(idx + 1).trim() : '';
        if (!text) { try { await message.reply('Usage: -say <message>'); } catch (_) {} return; }
        const state = this.guildManager.getGuildState(message.guild.id);
        if (!state.currentChannelId) { try { await message.reply('Not currently in a voice channel.'); } catch (_) {} return; }
        const talkManager = this.guildManager.talkManager;
        if (!talkManager) { try { await message.reply('Speech isn\'t available right now.'); } catch (_) {} return; }
        talkManager.speakText(message.guild.id, text);
        try { await message.react('🗣️'); } catch (_) {}
        return;
      }

      if (content === '-clip' || content.startsWith('-clip ')) {
        const parts = rawContent.split(/\s+/);
        let rest = parts.slice(1);
        let targetUserId = null;
        if (rest[0] && rest[0].startsWith('<@')) {
          targetUserId = rest[0].replace(/[<@!>]/g, '');
          rest = rest.slice(1);
        }
        let clipSeconds = null;
        const secMatch = rest[0] && rest[0].match(/^(\d+)s?$/i);
        if (secMatch) {
          clipSeconds = Number(secMatch[1]);
          rest = rest.slice(1);
        }
        // Flags can appear anywhere in the remaining args: name:<filename> sets
        // the saved file's name, and a bare "only"/"solo" isolates the tagged
        // (or, absent a mention, the requester's own) audio instead of mixing
        // everyone currently talking.
        let clipName = null;
        const nameIdx = rest.findIndex((t) => /^name:/i.test(t));
        if (nameIdx !== -1) {
          clipName = rest[nameIdx].slice(5);
          rest.splice(nameIdx, 1);
        }
        let onlyThem = false;
        const onlyIdx = rest.findIndex((t) => /^(only|solo)$/i.test(t));
        if (onlyIdx !== -1) {
          onlyThem = true;
          rest.splice(onlyIdx, 1);
        }
        const title = rest.join(' ').trim();
        this.guildManager.handleVoiceClipCommand(message.guild.id, message.author.username, message.author.id, title, targetUserId, message.channel.id, clipSeconds, clipName, onlyThem);
        try { await message.react('🎬'); } catch (_) {}
        return;
      }

      if (content.startsWith('-clipfolder')) {
        const parts = rawContent.split(/\s+/);
        if (parts.length < 2) { await message.reply('Usage: -clipfolder @user'); return; }
        const uid = parts[1].replace(/[<@!>]/g, '');
        const entries = this.guildManager.getUserClips(uid);
        if (!entries || entries.length === 0) { await message.reply('No clips for that user.'); return; }
        const urls = entries.slice(-50).reverse().map(e => `${e.url} ${e.title ? '- ' + e.title : ''}`);
        try { await message.reply(`Clips for <@${uid}>:\n${urls.join('\n')}`); } catch (_) { await message.reply('Failed to send clip list.'); }
        return;
      }

      if (content === '-dmtoggle') {
        const uid = message.author.id;
        const newVal = !this.guildManager.getDmPrefs(uid);
        this.guildManager.setDmPrefs(uid, newVal);
        try { await message.reply(newVal ? 'DM clips: ON' : 'DM clips: OFF'); } catch (_) {}
        return;
      }

      if (content.startsWith('-setclip')) {
        if (message.guild.ownerId !== message.author.id) {
          try { await message.reply('You must be the server owner to use this.'); } catch (_) {}
          return;
        }
        const arg = rawContent.split(/\s+/)[1] || '';
        const match = arg.match(/^(?:<#)?(\d{10,})(?:>)?$/);
        if (!match) { try { await message.reply('Usage: -setclip <channel_id or #mention>'); } catch (_) {} return; }
        const chanId = match[1];
        const ch = message.guild.channels.cache.get(chanId);
        if (!ch || !(typeof ch.isTextBased === 'function' && ch.isTextBased())) {
          try { await message.reply('That channel is not a text channel I can post to.'); } catch (_) {}
          return;
        }
        this.guildManager.setConfig(message.guild.id, 'clipChannelId', chanId);
        try { await message.reply(`Clip channel set to <#${chanId}>`); } catch (_) {}
        return;
      }
    } catch (e) {
      console.error('[command] handleMessage error:', e);
    }
  }
}

module.exports = CommandManager;
