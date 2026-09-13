# Balthazar

A Discord voice bot that streams call audio to the browser, transcribes speech with Whisper, and captures clips.

☕ **Support:** [Buy Me a Coffee](https://buymeacoffee.com/hackatoa)

## Overview

Balthazar joins a voice channel, streams the audio to a browser view, transcribes speech in real time with Whisper, and captures the last 30 seconds on command or a voice trigger. Includes a live talk/voice-call mode.

## Features

- Live audio streaming to the browser (WebRTC)
- Real-time Whisper transcription
- 30-second clip capture on command or voice trigger
- Live voice-call mode (STT → LLM → TTS)
- Per-guild `/language`

## Tech Stack

Node.js · discord.js · Whisper · WebRTC · Docker

## Development

```bash
npm install
# set the required tokens in the environment, then:
npm start
```

## Deployment

Docker on the homelab host; GHCR + Watchtower auto-deploy.

## Support

If this project is useful to you, consider supporting development:

☕ **[Buy Me a Coffee](https://buymeacoffee.com/hackatoa)**

---

Part of the **[Hackatoa](https://hackatoa.com)** ecosystem — self-hosted apps, browser games, and bots. · [All repositories »](https://github.com/Hackatoan)
