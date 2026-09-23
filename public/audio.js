const socket = io();

// Connection lifecycle handling
socket.on('connect_error', () => {
  try { socket.connect(); } catch (e){}
});
socket.on('reconnect_attempt', () => {
});

// Guild-specific state and UI elements
const guildContainers = {}; // guildId -> { container, channelEl, membersEl, transcriptEl, clipsEl, playMode }
const guildClipsData = {}; // guildId -> array of clip objects
const userVolumes = {}; // userId -> 0..2, applied both to clips and the live listen mix below

function refreshVolumeSliders() {
  document.querySelectorAll('.vol-slider').forEach(s => {
    const v = userVolumes[s.dataset.userid];
    if (v != null) {
      s.value = Math.round(v * 100);
      s.title = `Volume (${Math.round(v * 100)}%)`;
    }
  });
}

// Dragging a volume slider shouldn't also fire the member row's click handler
// (which switches the live-listen play mode to that user).
document.addEventListener('mousedown', (e) => { if (e.target.closest('.vol-slider')) e.stopPropagation(); }, true);
document.addEventListener('click', (e) => { if (e.target.closest('.vol-slider')) e.stopPropagation(); }, true);
document.addEventListener('input', (e) => {
  const slider = e.target.closest('.vol-slider');
  if (!slider) return;
  const userId = slider.dataset.userid;
  const guildId = slider.dataset.guild;
  const volume = Number(slider.value) / 100;
  userVolumes[userId] = volume;
  slider.title = `Volume (${slider.value}%)`;
  socket.emit('set_user_volume', { guildId, userId, volume });
});

socket.on('user_volumes', ({ guildId, volumes }) => {
  Object.assign(userVolumes, volumes || {});
  refreshVolumeSliders();
});
socket.on('user_volume_updated', ({ userId, volume }) => {
  userVolumes[userId] = volume;
  refreshVolumeSliders();
});

// Dashboard reload: repopulate clip history from the server instead of
// starting from an empty list every time the page is opened.
socket.on('clip_history', ({ guildId, clips }) => {
  if (!guildId || !Array.isArray(clips)) return;
  const g = getGuildContainer(guildId);
  if (!g) return;
  const existingUrls = new Set(guildClipsData[guildId].map(c => c.url));
  clips.forEach(c => {
    if (!existingUrls.has(c.url)) {
      guildClipsData[guildId].push(c);
      existingUrls.add(c.url);
    }
  });
  renderClips(guildId, guildClipsData[guildId]);
});

function getGuildContainer(guildId) {
  if (!guildId) return null;
  if (guildContainers[guildId]) return guildContainers[guildId];

  const template = document.getElementById('guild-template');
  if (!template) return null;

  const clone = template.content.cloneNode(true);
  const container = clone.querySelector('.guild-container');
  container.dataset.guildId = guildId;

  const channelEl = container.querySelector('.guild-channel');
  const membersEl = container.querySelector('.guild-members');
  const transcriptEl = container.querySelector('.guild-transcript');
  const clipsEl = container.querySelector('.guild-clips');
  const clipBtn = container.querySelector('.clip-btn');
  const micBtn = container.querySelector('.mic-btn');
  const sayInput = container.querySelector('.say-input');
  const sayBtn = container.querySelector('.say-btn');
  const clipChannelSelector = container.querySelector('.clip-channel-selector');

  document.getElementById('guilds-container').appendChild(container);

  const g = {
    guildId, container, channelEl, membersEl, transcriptEl, clipsEl, playMode: 'all',
    micActive: false, micStream: null, micSource: null, micProcessor: null, micGainNode: null
  };

  guildContainers[guildId] = g;
  guildClipsData[guildId] = [];

  if (clipChannelSelector) {
    clipChannelSelector.addEventListener('change', (e) => {
      socket.emit('set_clip_channel', { guildId, channelId: e.target.value });
    });
  }

  if (clipBtn) {
    clipBtn.addEventListener('click', () => {
      try {
        const secInput = prompt('How many seconds back should the clip go? (default 30, up to 120)', '30');
        if (secInput === null) return;
        let seconds = parseInt(secInput, 10);
        if (!seconds || seconds <= 0) seconds = 30;
        if (seconds > 120) seconds = 120;
        const title = prompt('Optional title for this clip? (Leave blank for default)') || '';
        socket.emit('clip_request', { title, guildId, seconds });
        showToast(`Clipping last ${seconds}s...`);
      } catch (_) {}
    });
  }

  if (micBtn) {
    micBtn.addEventListener('click', async () => {
      if (!g.micActive) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
          if (audioCtx.state === 'suspended') await audioCtx.resume();
          g.micStream = stream;
          g.micSource = audioCtx.createMediaStreamSource(stream);
          g.micProcessor = audioCtx.createScriptProcessor(4096, 1, 1);
          g.micProcessor.onaudioprocess = (e) => {
            const input = e.inputBuffer.getChannelData(0);
            // Discord expects interleaved 48kHz stereo s16le — duplicate the
            // mono mic input across both channels (matches how it decodes
            // everyone else's mono mic on the way in).
            const pcm = new Int16Array(input.length * 2);
            for (let i = 0; i < input.length; i++) {
              const s = Math.max(-1, Math.min(1, input[i]));
              const v = s < 0 ? s * 32768 : s * 32767;
              pcm[i * 2] = v;
              pcm[i * 2 + 1] = v;
            }
            socket.emit('mic_audio', { guildId, data: pcm.buffer });
          };
          // A ScriptProcessorNode only fires once it's part of a live graph —
          // route it through a silent gain node instead of straight to
          // destination, so the mic doesn't also play back locally (feedback).
          g.micGainNode = audioCtx.createGain();
          g.micGainNode.gain.value = 0;
          g.micSource.connect(g.micProcessor);
          g.micProcessor.connect(g.micGainNode);
          g.micGainNode.connect(audioCtx.destination);

          socket.emit('mic_start', { guildId });
          g.micActive = true;
          micBtn.textContent = '🎤 Mic On';
          micBtn.style.background = '#ed4245';
          showToast('Mic live in voice channel');
        } catch (e) {
          showToast('Mic access denied or unavailable');
        }
      } else {
        try { g.micProcessor && g.micProcessor.disconnect(); } catch (_) {}
        try { g.micGainNode && g.micGainNode.disconnect(); } catch (_) {}
        try { g.micSource && g.micSource.disconnect(); } catch (_) {}
        try { g.micStream && g.micStream.getTracks().forEach(t => t.stop()); } catch (_) {}
        socket.emit('mic_stop', { guildId });
        g.micActive = false;
        micBtn.textContent = '🎤 Mic Off';
        micBtn.style.background = '#3a994e';
        showToast('Mic stopped');
      }
    });
  }

  if (sayBtn && sayInput) {
    const doSay = () => {
      const text = sayInput.value.trim();
      if (!text) return;
      socket.emit('say_text', { guildId, text });
      showToast('Speaking...');
      sayInput.value = '';
    };
    sayBtn.addEventListener('click', doSay);
    sayInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSay(); });
  }

  if (channelEl) {
    channelEl.addEventListener('click', () => {
      g.playMode = 'all';
      updateSelectionStyles(g);
      resetJitter();
    });
  }

  return g;
}

function updateSelectionStyles(g) {
  if (!g) return;
  const playMode = g.playMode;
  const memberEls = g.membersEl.querySelectorAll('.member');
  if (playMode === 'all') {
    g.channelEl.style.textDecoration = 'underline';
    memberEls.forEach(div => div.style.textDecoration = 'none');
  } else {
    g.channelEl.style.textDecoration = 'none';
    memberEls.forEach(div => {
      div.style.textDecoration = (div.dataset.userid === playMode) ? 'underline' : 'none';
    });
  }
}

function setUserClickHandlers(g) {
  if (!g) return;
  g.membersEl.querySelectorAll('.member').forEach(div => {
    div.onclick = () => {
      g.playMode = div.dataset.userid;
      updateSelectionStyles(g);
      resetJitter();
    };
  });
}

function renderClips(guildId, items) {
  const g = guildContainers[guildId];
  if (!g) return;
  g.clipsEl.innerHTML = '';

  let list = items.slice();

  // Filter by playMode if necessary
  if (g.playMode !== 'all') {
     // Simplified: we would normally filter by assigned user clips if we had that detailed state.
     // For now, if there's a playMode, we'll just show everything but visually you could filter.
     // Original logic filtered `list = clipItems.filter(x => x.username ...)`
     // We will just show all clips for the guild for simplicity unless we specifically implement user clip tracking per guild.
  }

  if (list.length === 0) {
      g.clipsEl.innerHTML = '<div style="color:#72767d;font-style:italic;">No clips yet.</div>';
      return;
  }

  list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  list.forEach(c => {
    const div = document.createElement('div');
    div.style.marginBottom = '12px';
    div.style.paddingBottom = '12px';
    div.style.borderBottom = '1px solid #3a3f44';

    const timeStr = c.timestamp ? new Date(c.timestamp).toLocaleTimeString() : '';
    const safeUrl = String(c.url).replace(/"/g, '&quot;');
    const safeName = (c.title || c.filename || 'Clip').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeReq = (c.requestedBy || 'Unknown').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    let html = `<div style="margin-bottom:6px;"><span style="color:#72767d;font-size:0.85em;margin-right:8px;">[${timeStr}]</span>` +
                 `<strong>${safeReq}</strong> created a clip: <a href="${safeUrl}" target="_blank" rel="noopener" style="color:#5865f2;text-decoration:none;">${safeName}</a></div>`;

    html += `<audio controls src="${safeUrl}" style="height:32px;outline:none;width:100%;margin-bottom:6px;"></audio>`;

    html += `<div style="display:flex;gap:8px;font-size:0.85em;">`;
    html += `<button class="copy-btn" data-url="${safeUrl}" style="background:#4f545c;color:#fff;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;">Copy</button>`;
    html += `<button class="replay-btn" data-url="${safeUrl}" data-guild="${guildId}" style="background:#3a994e;color:#fff;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;" title="Play this back into the voice channel">▶ Play in channel</button>`;
    html += `<button class="assign-btn" data-url="${safeUrl}" data-title="${safeName}" data-guild="${guildId}" style="background:#5865f2;color:#fff;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;" title="Assign to selected user">Assign</button>`;
    html += `<button class="remove-btn" data-url="${safeUrl}" data-guild="${guildId}" style="background:#ed4245;color:#fff;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;" title="Remove from selected user">Remove</button>`;
    html += `</div>`;

    div.innerHTML = html;
    g.clipsEl.appendChild(div);
  });
}

// Simple toast
let toastEl;
function ensureToast() {
  if (toastEl) return toastEl;
  toastEl = document.createElement('div');
  toastEl.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#111;color:#fff;padding:8px 14px;border-radius:8px;opacity:0;transition:opacity .2s;z-index:2000;border:1px solid #333';
  document.body.appendChild(toastEl);
  return toastEl;
}
function showToast(msg) {
  const el = ensureToast();
  el.textContent = msg || '';
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 1200);
}

document.addEventListener('click', async (e) => {
  const btnCopy = e.target.closest('.copy-btn');
  if (btnCopy) {
    const url = btnCopy.getAttribute('data-url');
    try {
      await navigator.clipboard.writeText(url);
      showToast('Link copied');
    } catch (_) { showToast('Copy failed'); }
    return;
  }

  const btnReplay = e.target.closest('.replay-btn');
  if (btnReplay) {
    const url = btnReplay.getAttribute('data-url');
    const guildId = btnReplay.getAttribute('data-guild');
    socket.emit('replay_clip', { guildId, url });
    showToast('Playing in voice channel...');
    return;
  }

  const btnAssign = e.target.closest('.assign-btn');
  if (btnAssign) {
    const url = btnAssign.getAttribute('data-url');
    const title = btnAssign.getAttribute('data-title');
    const guildId = btnAssign.getAttribute('data-guild');
    const g = guildContainers[guildId];
    if(!g) return;
    const targetUser = g.playMode === 'all' ? null : g.playMode;
    if (!targetUser) { showToast('Select a user first'); return; }
    socket.emit('assign_clip_to_user', { url, title, userId: targetUser, guildId });
    showToast('Assigned to user');
    return;
  }

  const btnRemove = e.target.closest('.remove-btn');
  if (btnRemove) {
    const url = btnRemove.getAttribute('data-url');
    const guildId = btnRemove.getAttribute('data-guild');
    const g = guildContainers[guildId];
    if(!g) return;
    const targetUser = g.playMode === 'all' ? null : g.playMode;
    if (!targetUser) { showToast('Select a user first'); return; }
    socket.emit('remove_user_clip', { url, userId: targetUser, guildId });
    showToast('Removed from user');
    return;
  }
});

socket.on('say_error', (msg) => showToast(msg || 'Speak failed'));
socket.on('replay_started', () => showToast('Now playing in voice channel'));
socket.on('replay_ended', () => showToast('Playback finished'));
socket.on('replay_error', (msg) => showToast(`Replay failed: ${msg || ''}`));

socket.on('transcript', (data) => {
  if (!data || !data.guildId) return;
  const g = getGuildContainer(data.guildId);
  if (!g) return;
  const div = document.createElement('div');
  div.style.marginBottom = '6px';
  const safeName = String(data.username || 'Unknown').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeText = String(data.text || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  div.innerHTML = `<strong style="color:#5865f2;">${safeName}:</strong> <span style="color:#dcddde;">${safeText}</span>`;
  g.transcriptEl.appendChild(div);
  g.transcriptEl.scrollTop = g.transcriptEl.scrollHeight;
});

socket.on('update', data => {
  if (!data || !data.channel || !data.channel.guildId) return;
  const guildId = data.channel.guildId;
  const g = getGuildContainer(guildId);
  if (!g) return;

  g.channelEl.textContent = `Channel: ${data.channel.name}`;

  const clipChannelSelector = g.container.querySelector('.clip-channel-selector');
  if (clipChannelSelector && data.textChannels) {
    const currentVal = clipChannelSelector.value;
    clipChannelSelector.innerHTML = '<option value="">Default Clip Channel</option>';
    data.textChannels.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      clipChannelSelector.appendChild(opt);
    });
    if (data.clipChannelId) {
      clipChannelSelector.value = data.clipChannelId;
    } else if (currentVal) {
      // keep current selection if valid
      if (data.textChannels.find(c => c.id === currentVal)) {
        clipChannelSelector.value = currentVal;
      }
    }
  }
  const guildSelect = document.getElementById('guild-selector');
  if (guildSelect) {
    let option = guildSelect.querySelector(`option[value="${guildId}"]`);
    if (!option) {
      option = document.createElement('option');
      option.value = guildId;
      guildSelect.appendChild(option);
    }
    option.textContent = `${data.channel.name} (${guildId})`;
  }
  g.membersEl.innerHTML = '';

  (data.members || []).forEach(m => {
    const div = document.createElement('div');
    div.className = 'member';
    div.dataset.userid = m.id;
    const vol = userVolumes[m.id] != null ? userVolumes[m.id] : 1;
    div.innerHTML = `<img src="${m.avatar}" alt="avatar" style="width:32px;height:32px;border-radius:50%;margin-right:8px;">`+
      `<span style="margin-right:6px;">${m.username}</span>`+
      `<input type="range" class="vol-slider" min="0" max="200" value="${Math.round(vol * 100)}" data-userid="${m.id}" data-guild="${guildId}" title="Volume (${Math.round(vol * 100)}%)" style="width:70px;">`;
    g.membersEl.appendChild(div);
  });

  setUserClickHandlers(g);

  if (g.playMode !== 'all') {
    const stillPresent = (data.members || []).some(m => m.id === g.playMode);
    if (!stillPresent) g.playMode = 'all';
  }
  updateSelectionStyles(g);
});

socket.on('clip_posted', (clip) => {
  if (!clip || !clip.guildId) return;
  const guildId = clip.guildId;
  const g = getGuildContainer(guildId);
  if (!g) return;
  clip.timestamp = clip.timestamp || Date.now();
  guildClipsData[guildId].unshift(clip);
  if (guildClipsData[guildId].length > 200) guildClipsData[guildId].pop();
  renderClips(guildId, guildClipsData[guildId]);
});

// File upload / playback handling
document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('file-input');
  const dropZone = document.getElementById('drop-zone');
  const playBtn = document.getElementById('play-btn');
  const status = document.getElementById('play-status');
  let objectUrl = '';

  function setStatus(msg) { if (status) status.textContent = msg || ''; }

  function setFile(file) {
    if (!file) return;
    try { if (objectUrl) URL.revokeObjectURL(objectUrl); } catch (_) {}
    objectUrl = URL.createObjectURL(file);
    setStatus(`Selected: ${file.name} (${Math.round(file.size/1024)} KB)`);
  }

  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) setFile(f);
    });
  }
  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.borderColor = '#5865f2'; });
    dropZone.addEventListener('dragleave', () => { dropZone.style.borderColor = '#3a3f44'; });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault(); dropZone.style.borderColor = '#3a3f44';
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) setFile(f);
    });
  }
  if (playBtn) {
    playBtn.addEventListener('click', async () => {
      const f = (fileInput && fileInput.files && fileInput.files[0]) || null;
      if (!f) { setStatus('Please select a file first.'); return; }
      try { if (audioCtx && audioCtx.state === 'suspended') await audioCtx.resume(); } catch (_) {}
      try {
        const arrBuf = await f.arrayBuffer();
        const guildSelect = document.getElementById('guild-selector');
        const selectedGuildId = guildSelect ? guildSelect.value : null;
        if (!selectedGuildId) { setStatus('Please select a server first.'); return; }
        socket.emit('play_upload', { data: new Uint8Array(arrBuf), mime: f.type || 'application/octet-stream', name: f.name || 'upload', guildId: selectedGuildId });
        setStatus('Playing...');
      } catch (e) { setStatus('Failed to send play request.'); }
    });
  }
  socket.on('play_started', () => setStatus('Playing in Discord...'));
  socket.on('play_ended', () => setStatus('Playback finished.'));
  socket.on('play_error', (msg) => setStatus(`Playback error: ${msg || ''}`));
  socket.on('play_saved', ({ url, name }) => {
    if (!url) return;
    const safe = String(url).replace(/"/g, '&quot;');
    setStatus(`Saved on server: <a href="${safe}" target="_blank" rel="noopener">${name || safe}</a>`);
  });
});

// --- Audio Setup ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
window.addEventListener('click', () => {
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}, { once: true });

const userBuffers = {};
const SAMPLE_RATE = 48000;
const BUFFER_SIZE = 4096;
const JITTER_MS = 30;
const JITTER_FRAMES = Math.ceil((SAMPLE_RATE * JITTER_MS) / 1000);
let jitterReady = false;
const CHANNELS = 2;

let scriptNode = null;
function startAudioNode() {
  if (scriptNode) return;
  scriptNode = audioCtx.createScriptProcessor(BUFFER_SIZE, 0, CHANNELS);
  scriptNode.onaudioprocess = (e) => {
    if (!jitterReady) {
      let ready = false;
      ready = Object.values(userBuffers).some(samples => samples && samples.length >= JITTER_FRAMES * CHANNELS);
      if (ready) {
        jitterReady = true;
      } else {
        e.outputBuffer.getChannelData(0).fill(0);
        e.outputBuffer.getChannelData(1).fill(0);
        return;
      }
    }
    const outL = e.outputBuffer.getChannelData(0);
    const outR = e.outputBuffer.getChannelData(1);
    outL.fill(0); outR.fill(0);

    const activeUsers = new Set();
    Object.values(guildContainers).forEach(g => {
      if (g.playMode === 'all') {
        g.membersEl.querySelectorAll('.member').forEach(el => activeUsers.add(el.dataset.userid));
      } else {
        activeUsers.add(g.playMode);
      }
    });

    const neededSamples = BUFFER_SIZE * CHANNELS;
    const slices = {};
    for (const userId in userBuffers) {
      if (!activeUsers.has(userId)) continue;
      const samples = userBuffers[userId];
      if (samples && samples.length >= neededSamples) {
        slices[userId] = samples.subarray(0, neededSamples);
      } else {
        slices[userId] = null;
      }
    }
    for (let j = 0; j < BUFFER_SIZE; j++) {
      let sumL = 0, sumR = 0, contributors = 0;
      for (const userId in slices) {
        const s = slices[userId];
        if (!s) continue;
        const vol = userVolumes[userId] != null ? userVolumes[userId] : 1;
        const idx = j * 2;
        sumL += s[idx] * vol;
        sumR += s[idx + 1] * vol;
        contributors++;
      }
      if (contributors > 0) {
        sumL = sumL / contributors;
        sumR = sumR / contributors;
      }
      if (sumL > 32767) sumL = 32767; else if (sumL < -32768) sumL = -32768;
      if (sumR > 32767) sumR = 32767; else if (sumR < -32768) sumR = -32768;
      outL[j] = sumL / 32768;
      outR[j] = sumR / 32768;
    }
    for (const userId in userBuffers) {
      const samples = userBuffers[userId];
      if (samples && samples.length >= neededSamples) {
        userBuffers[userId] = samples.subarray(neededSamples);
      }
    }
  };
  scriptNode.connect(audioCtx.destination);
}

socket.on('audio', ({ userId, data }) => {
  const bytes = atob(data);
  const len = bytes.length;
  const buf = new Uint8Array(len);
  for (let i = 0; i < len; i++) buf[i] = bytes.charCodeAt(i);
  const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
  const existing = userBuffers[userId];
  if (existing && existing.length > 0) {
    const merged = new Int16Array(existing.length + samples.length);
    merged.set(existing, 0);
    merged.set(samples, existing.length);
    userBuffers[userId] = merged;
  } else {
    const copy = new Int16Array(samples.length);
    copy.set(samples);
    userBuffers[userId] = copy;
  }
  startAudioNode();
});

function resetJitter() {
  jitterReady = false;
}




