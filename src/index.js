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

async function registerTalkCommand(guild) {
  try { await guild.commands.set([talkCommand]); }
  catch (e) { console.warn(`[slash] register failed for ${guild.id}: ${e?.message || e}`); }
}

webUI.onSetClipChannel = (payload, socket) => {
  if (payload.guildId && payload.channelId !== undefined) {
    guildManager.setConfig(payload.guildId, 'clipChannelId', payload.channelId || null);
    console.log(`[web] clip channel for ${payload.guildId} set to ${payload.channelId}`);
    // broadcast update
    const g = guildManager.guilds.get(payload.guildId);
    if (g && g.channel) {
      webUI.updateWebMembers(g.channel, payload.guildId);
    }
  }
};

webUI.onPlayUpload = (payload, socket) => {
  if (!payload.guildId || !payload.data) {
    socket.emit('play_error', 'Invalid play request');
    return;
  }
  try {
    const upDir = path.join(__dirname, '..', 'public', 'uploads');
    if (!fs.existsSync(upDir)) fs.mkdirSync(upDir, { recursive: true });

    const ext = (payload.name && payload.name.includes('.')) ? payload.name.split('.').pop() : 'bin';
    const filename = `upload-${Date.now()}.${ext}`;
    const filepath = path.join(upDir, filename);

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
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'talk') return;
    if (!interaction.guild) {
      await interaction.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
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
