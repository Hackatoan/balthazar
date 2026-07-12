import io
import os
import wave

from flask import Flask, request, jsonify, send_file
from piper import PiperVoice

app = Flask(__name__)

# Model is mounted from the host piper-data dir (see docker-compose).
# PIPER_MODEL is an absolute path to a .onnx voice; its .json config must sit beside it.
MODEL_PATH = os.environ.get("PIPER_MODEL", "/models/en_US-kristin-medium.onnx")

print(f"[piper] loading voice: {MODEL_PATH}")
try:
    voice = PiperVoice.load(MODEL_PATH)
    print(f"[piper] voice loaded ({voice.config.sample_rate} Hz)")
except Exception as e:  # noqa: BLE001
    print(f"[piper] FAILED to load voice: {e}")
    voice = None


def synth_wav_bytes(text):
    """Synthesize text to an in-memory WAV (mono, 16-bit, voice-native sample rate)."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav_file:
        voice.synthesize(text, wav_file)
    buf.seek(0)
    return buf


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
        buf = synth_wav_bytes(text)
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 500

    return send_file(buf, mimetype="audio/wav", as_attachment=False,
                     download_name="tts.wav")


@app.route("/", methods=["GET"])
def health():
    return jsonify({
        "ok": voice is not None,
        "model": os.path.basename(MODEL_PATH),
        "sample_rate": getattr(getattr(voice, "config", None), "sample_rate", None),
    }), (200 if voice is not None else 503)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5006)
