import io
import os
import time
import wave
from math import gcd

import numpy as np
from scipy.signal import resample_poly
from flask import Flask, request, jsonify, Response
from piper import PiperVoice

app = Flask(__name__)

# Model is mounted from the host piper-data dir (see docker-compose).
# PIPER_MODEL is an absolute path to a .onnx voice; its .json config must sit beside it.
MODEL_PATH = os.environ.get("PIPER_MODEL", "/models/en_US-kristin-medium.onnx")

# Discord voice needs 48kHz stereo 16-bit PCM. Piper's voices synthesize at their own
# native rate (22050Hz mono for the voices used here) — used to be resampled by an
# ffmpeg subprocess spawned per-reply on the bot side (@discordjs/voice's default
# behavior for a bare file path). That subprocess has to keep pace in real time with
# no CPU reservation on a host where ASR/Piper themselves regularly spike well over
# 100% CPU each — exactly the situation most likely to starve it mid-stream and glitch
# the bot's own voice. Doing the resample once, synchronously, right here (not
# real-time-constrained since it happens before playback starts) and handing the bot
# already-final 48kHz stereo PCM to feed straight into StreamType.Raw (in-process
# @discordjs/opus encoding, no subprocess at all) removes that failure mode entirely.
TARGET_RATE = 48000

print(f"[piper] loading voice: {MODEL_PATH}")
try:
    voice = PiperVoice.load(MODEL_PATH)
    print(f"[piper] voice loaded ({voice.config.sample_rate} Hz)")
except Exception as e:  # noqa: BLE001
    print(f"[piper] FAILED to load voice: {e}")
    voice = None


def synth_native_mono(text):
    """Synthesize text to native-rate mono int16 samples + the voice's sample rate."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav_file:
        voice.synthesize(text, wav_file)
    buf.seek(0)
    with wave.open(buf, "rb") as wav_file:
        native_rate = wav_file.getframerate()
        n_frames = wav_file.getnframes()
        raw = wav_file.readframes(n_frames)
    samples = np.frombuffer(raw, dtype=np.int16)
    return samples, native_rate


def to_48k_stereo_pcm(samples, native_rate):
    """Resample native-rate mono int16 samples to 48kHz, duplicate to stereo, and
    return raw interleaved (LRLRLR...) int16 PCM bytes — no WAV header."""
    if native_rate != TARGET_RATE:
        g = gcd(TARGET_RATE, native_rate)
        up, down = TARGET_RATE // g, native_rate // g
        # Work in float for the polyphase filter, then requantize to int16.
        resampled = resample_poly(samples.astype(np.float32), up, down)
        resampled = np.clip(resampled, -32768, 32767).astype(np.int16)
    else:
        resampled = samples
    stereo = np.column_stack([resampled, resampled]).astype(np.int16)
    return stereo.tobytes()


@app.route("/synthesize", methods=["POST"])
def synthesize():
    if voice is None:
        return jsonify({"error": "voice not loaded"}), 503

    # Accept either JSON {"text": "..."} or a raw text body.
    text = ""
    if request.is_json:
        text = (request.get_json(silent=True) or {}).get("text", "")
    if not text:
        text = request.data.decode("utf-8", errors="ignore")
    text = (text or "").strip()

    if not text:
        return jsonify({"error": "no text"}), 400
    if len(text) > 1200:
        text = text[:1200]

    try:
        t0 = time.time()
        samples, native_rate = synth_native_mono(text)
        synth_ms = (time.time() - t0) * 1000
        t1 = time.time()
        pcm_bytes = to_48k_stereo_pcm(samples, native_rate)
        resample_ms = (time.time() - t1) * 1000
        print(f"[piper TIMING] synth={synth_ms:.0f}ms resample={resample_ms:.0f}ms len={len(text)}", flush=True)
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 500

    return Response(
        pcm_bytes,
        mimetype="application/octet-stream",
        headers={
            "X-Sample-Rate": str(TARGET_RATE),
            "X-Channels": "2",
            "X-Sample-Format": "s16le",
        },
    )


@app.route("/", methods=["GET"])
def health():
    return jsonify({
        "ok": voice is not None,
        "model": os.path.basename(MODEL_PATH),
        "native_sample_rate": getattr(getattr(voice, "config", None), "sample_rate", None),
        "output_sample_rate": TARGET_RATE,
        "output_format": "raw s16le stereo",
    }), (200 if voice is not None else 503)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5006)
