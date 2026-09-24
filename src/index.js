require("libsodium-wrappers");
require("@snazzah/davey");
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, SlashCommandBuilder, MessageFlags } = require('discord.js');
const WebUI = require('./WebUI');
const GuildManager = require('./GuildManager');
const CommandManager = require('./CommandManager');
const TalkManager = require('./TalkManager');
const { LANGS } = require('./lang');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const webUI = new WebUI();
const guildManager = new GuildManager(client, webUI);
webUI.guildManager = guildManager;
const commandManager = new CommandManager(client, guildManager, webUI);
const talkManager = new TalkManager(guildManager, webUI);
guildManager.talkManager = talkManager;

const talkCommand = new SlashCommandBuilder()
  .setName('talk')
  .setDescription('Toggle Balthazar conversational voice mode on/off')
  .toJSON();

const languageCommand = new SlashCommandBuilder()
  .setName('language')
  .setDescription('Set the language Balthazar replies in for this server')
  .addStringOption((o) =>
    o.setName('language').setDescription('Language Balthazar will talk in').setRequired(true)
      .addChoices(...Object.entries(LANGS).map(([value, { label }]) => ({ name: label, value }))))
  .toJSON();

// Actual clamping to [MIN_CLIP_SECONDS, buffer size] happens in
// GuildManager.handleVoiceClipCommand — these bounds just keep the Discord UI honest.
const clipCommand = new SlashCommandBuilder()
  .setName('clip')
  .setDescription('Create a clip of recent voice')
  .addIntegerOption((o) =>
    o.setName('seconds').setDescription('How many seconds back to grab (default 30, up to 120)').setMinValue(5).setMaxValue(120).setRequired(false))
  .addStringOption((o) => o.setName('title').setDescription('Optional title for the clip').setRequired(false))
  .addUserOption((o) => o.setName('user').setDescription('Deliver to this user instead of the clip channel').setRequired(false))
  .addStringOption((o) => o.setName('name').setDescription('Filename for the saved clip (optional)').setRequired(false))
  .addBooleanOption((o) => o.setName('only').setDescription('Isolate just this user\'s audio instead of mixing everyone talking').setRequired(false))
  .toJSON();

const sayCommand = new SlashCommandBuilder()
  .setName('say')
  .setDescription('Balthazar speaks a message aloud in the current voice channel')
  .addStringOption((o) => o.setName('message').setDescription('What Balthazar should say').setRequired(true))
  .toJSON();

async function registerTalkCommand(guild) {
  try { await guild.commands.set([talkCommand, languageCommand, clipCommand, sayCommand]); }
  catch (e) { console.warn(`[slash] register failed for ${guild.id}: ${e?.message || e}`); }
}

function refreshGuildPanel(guildId) {
  const st = guildManager.getGuildState(guildId);
  if (!st || !st.currentChannelId) return;
  const guild = client.guilds.cache.get(guildId);
  const ch = guild && guild.channels.cache.get(st.currentChannelId);
  if (ch) webUI.updateWebMembers(ch, guildId);
}

webUI.onSetClipChannel = (payload, socket) => {
  if (payload.guildId && payload.channelId !== undefined) {
    guildManager.setConfig(payload.guildId, 'clipChannelId', payload.channelId || null);
    console.log(`[web] clip channel for ${payload.guildId} set to ${payload.channelId}`);
    refreshGuildPanel(payload.guildId);
  }
};

webUI.onClipRequest = (payload) => {
  if (!payload || !payload.guildId) return;
  guildManager.handleVoiceClipCommand(payload.guildId, 'Web Panel', null, payload.title || '', payload.onlyUserId || null, null, payload.seconds, payload.name, !!payload.onlyUserId);
  console.log(`[web] clip requested for ${payload.guildId} (${payload.seconds || 30}s)${payload.onlyUserId ? ' solo:' + payload.onlyUserId : ''}`);
};

webUI.onSetUserVolume = (payload) => {
  if (!payload || !payload.guildId || !payload.userId) return;
  guildManager.setUserVolume(payload.guildId, payload.userId, payload.volume);
};

webUI.onMicStart = (payload) => {
  if (!payload || !payload.guildId) return;
  guildManager.startWebMic(payload.guildId);
};

webUI.onMicAudio = (payload) => {
  if (!payload || !payload.guildId || !payload.data) return;
  guildManager.pushWebMicAudio(payload.guildId, Buffer.from(payload.data));
};

webUI.onMicStop = (payload) => {
  if (!payload || !payload.guildId) return;
  guildManager.stopWebMic(payload.guildId);
};

webUI.onSayText = (payload, socket) => {
  if (!payload || !payload.guildId || !payload.text) return;
  talkManager.speakText(payload.guildId, payload.text).then((ok) => {
    if (!ok) socket.emit('say_error', 'Not in a voice channel, or message was empty.');
  });
};

webUI.onReplayClip = (payload, socket) => {
  if (!payload || !payload.guildId || !payload.url) return;
  guildManager.playClipIntoChannel(payload.guildId, payload.url,
    () => socket.emit('replay_started'),
    () => socket.emit('replay_ended'),
    (err) => socket.emit('replay_error', err?.message || String(err))
  );
};

webUI.onClientConnected = (socket) => {
  for (const guild of client.guilds.cache.values()) {
    const clips = guildManager.getGuildClips(guild.id);
    if (clips.length) socket.emit('clip_history', { guildId: guild.id, clips });
    const volumes = guildManager.getUserVolumes(guild.id);
    if (Object.keys(volumes).length) socket.emit('user_volumes', { guildId: guild.id, volumes });
  }
};

webUI.onAssignClip = (payload) => {
  if (!payload || !payload.userId || !payload.url) return;
  guildManager.addUserClip(payload.userId, payload.title || '', payload.url, payload.guildId || null);
  console.log(`[web] clip assigned to ${payload.userId}`);
};

webUI.onRemoveClip = (payload) => {
  if (!payload || !payload.userId || !payload.url) return;
  guildManager.removeUserClip(payload.userId, payload.url, payload.guildId || null);
  console.log(`[web] clip removed from ${payload.userId}`);
};

webUI.onPlayUpload = (payload, socket) => {
  if (!payload.guildId || !payload.data) {
    socket.emit('play_error', 'Invalid play request');
    return;
  }
  try {
    const upDir = path.join(__dirname, '..', 'public', 'uploads');
    if (!fs.existsSync(upDir)) fs.mkdirSync(upDir, { recursive: true });

    // Strip anything but alphanumerics from the client-supplied extension so a
    // crafted name (e.g. "a.b/../../evil") can't inject path separators into
    // the generated filename and write outside the uploads directory.
    const rawExt = (payload.name && payload.name.includes('.')) ? payload.name.split('.').pop() : 'bin';
    const ext = (String(rawExt).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10)) || 'bin';
    const filename = `upload-${Date.now()}.${ext}`;
    const filepath = path.join(upDir, filename);
    if (!filepath.startsWith(upDir + path.sep)) {
      socket.emit('play_error', 'Invalid file name');
      return;
    }

    // Write array buffer to file
    const buf = Buffer.from(payload.data);
    fs.writeFileSync(filepath, buf);

    const url = `/uploads/${filename}`;
    socket.emit('play_saved', { url, name: payload.name || filename });

    socket.emit('play_started');
    guildManager.playFileFromDisk(payload.guildId, filepath,
      () => { console.log(`[web] playing file ${filename} in guild ${payload.guildId}`); },
      () => { socket.emit('play_ended'); },
      (err) => { socket.emit('play_error', err.message); }
    );
  } catch (e) {
    console.error('Error handling upload:', e);
    socket.emit('play_error', 'Upload handling failed');
  }
};

client.on('ready', async () => {
  console.log(`[discord] Logged in as ${client.user.tag}`);
  console.log(`[talk] mode ${talkManager.configured ? 'configured' : 'DISABLED (no GEMINI_API_KEY)'}`);
  for (const guild of client.guilds.cache.values()) {
    await registerTalkCommand(guild);
  }
  console.log(`[slash] /talk registered in ${client.guilds.cache.size} guild(s)`);
});

client.on('guildCreate', (guild) => {
  registerTalkCommand(guild);
});

client.on('voiceStateUpdate', (oldState, newState) => {
  guildManager.handleVoiceStateUpdate(oldState, newState);
});

client.on('messageCreate', async (message) => {
  commandManager.handleMessage(message);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (!['talk', 'language', 'clip', 'say'].includes(interaction.commandName)) return;
    if (!interaction.guild) {
      await interaction.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.commandName === 'language') {
      const code = interaction.options.getString('language');
      guildManager.setConfig(interaction.guild.id, 'language', code);
      const label = (LANGS[code] || LANGS.en).label;
      await interaction.reply({ content: `🌍 Balthazar will reply in **${label}** for this server.` });
      return;
    }
    if (interaction.commandName === 'clip') {
      const guildId = interaction.guild.id;
      const state = guildManager.getGuildState(guildId);
      if (!state.currentChannelId) {
        await interaction.reply({ content: 'Not currently in a voice channel.', flags: MessageFlags.Ephemeral });
        return;
      }
      const seconds = interaction.options.getInteger('seconds');
      const title = interaction.options.getString('title') || '';
      const targetUser = interaction.options.getUser('user');
      const name = interaction.options.getString('name') || '';
      const only = !!interaction.options.getBoolean('only');
      const titleNote = title ? ` — ${title}` : '';
      const onlyNote = only ? ` (${targetUser ? targetUser.username : interaction.user.username} only)` : '';
      await interaction.reply(`🎬 Clipping the last ${seconds || 30}s${onlyNote}${titleNote}...`);
      guildManager.handleVoiceClipCommand(guildId, interaction.user.username, interaction.user.id, title, targetUser ? targetUser.id : null, interaction.channelId, seconds, name, only);
      return;
    }
    if (interaction.commandName === 'say') {
      const guildId = interaction.guild.id;
      const state = guildManager.getGuildState(guildId);
      if (!state.currentChannelId) {
        await interaction.reply({ content: 'Not currently in a voice channel.', flags: MessageFlags.Ephemeral });
        return;
      }
      const text = interaction.options.getString('message');
      await interaction.reply(`🗣️ Saying: ${text}`);
      talkManager.speakText(guildId, text);
      return;
    }
    if (!talkManager.configured) {
      await interaction.reply({ content: 'Talk mode is not configured (missing GEMINI_API_KEY).', flags: MessageFlags.Ephemeral });
      return;
    }
    const guildId = interaction.guild.id;
    const on = talkManager.setActive(guildId, !talkManager.isActive(guildId));
    const inVc = !!guildManager.getGuildState(guildId).currentChannelId;
    const note = on
      ? (inVc ? 'I\'m listening — say my name and I\'ll chime in.' : 'On — I\'ll start once I\'m in a voice channel.')
      : 'Conversation mode off.';
    await interaction.reply({ content: `🎙️ Talk mode **${on ? 'ON' : 'OFF'}**. ${note}` });
  } catch (e) {
    console.warn('[slash] interaction error:', e?.message || e);
  }
});

setInterval(() => {
  guildManager.checkEligibleChannels();
}, 2000);

webUI.start();

if (DISCORD_TOKEN) {
    client.login(DISCORD_TOKEN);
} else {
    console.warn("DISCORD_TOKEN is not set. Bot will not connect to Discord.");
}
