import tempfile
import os
import threading
import time
import concurrent.futures
from flask import Flask, request, jsonify
import numpy as np
import soundfile as sf
import webrtcvad

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

app = Flask(__name__)

# Use faster-whisper instead of Vosk
ASR_ENGINE = 'faster-whisper'
try:
    from faster_whisper import WhisperModel
    MODEL_SIZE = os.environ.get("WHISPER_MODEL", "base.en")
    # For CPU usage; change to 'cuda' and 'float16' if GPU is available
    print(f"[ASR] Loading faster-whisper model: {MODEL_SIZE}")
    whisper_model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
except Exception as e:
    print('[ASR] faster-whisper initialization failed:', e)
    whisper_model = None

MAX_QUEUE_SIZE = 6
JOB_TIMEOUT = 20

# Was a single dedicated worker thread pulling one job at a time off a queue —
# in a group voice call, the 2nd/3rd person talking at once had to wait for the
# 1st person's whisper inference to fully finish before their own even started.
# Measured directly: 3 concurrent requests landed at 2.2s / 4.3s / 6.6s total —
# almost pure serialization (each ~2.2s inference, stacked). ctranslate2 (the
# backend faster-whisper uses) releases the GIL during the actual compute, so a
# small thread pool gives real concurrency, not just interleaving. Kept modest
# (2) since this is a 4-core host shared with 30+ other containers — going
# wider would trade queue-wait for CPU thrash instead of fixing anything.
MAX_WORKERS = 2
executor = concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="asr-worker")
_in_flight = 0
_in_flight_lock = threading.Lock()

# Initialize VAD
vad = webrtcvad.Vad()
vad.set_mode(2) # 0 is least aggressive, 3 is most aggressive about filtering out non-speech

def frame_generator(frame_duration_ms, audio, sample_rate):
    n = int(sample_rate * (frame_duration_ms / 1000.0) * 2)
    offset = 0
    while offset + n <= len(audio):
        yield audio[offset:offset + n]
        offset += n

def contains_speech(audio_data, sample_rate=16000):
    # WebRTC VAD requires 16000Hz, 16-bit mono PCM. Frames must be 10, 20, or 30 ms.
    # Convert numpy array to bytes
    audio_bytes = audio_data.tobytes()
    frames = list(frame_generator(30, audio_bytes, sample_rate))

    if not frames:
        return False

    speech_frames = 0
    for frame in frames:
        if vad.is_speech(frame, sample_rate):
            speech_frames += 1

    # If at least 20% of frames contain speech, consider it valid speech
    return (speech_frames / len(frames)) > 0.2

def process_job(tmp_name, enqueue_time):
    dequeue_time = time.time()
    queue_wait_ms = (dequeue_time - enqueue_time) * 1000
    print(f"[ASR QUEUE] starting (waited {queue_wait_ms:.0f}ms for a worker)", flush=True)

    try:
        if whisper_model is not None:
            # beam_size=1 is ~2-3x faster than 5 on CPU; initial_prompt biases the
            # decoder toward the name "Balthazar" (otherwise heard as "Beth Azar" etc).
            infer_start = time.time()
            segments, info = whisper_model.transcribe(
                tmp_name,
                beam_size=1,
                vad_filter=True,
                condition_on_previous_text=False,
                initial_prompt="Conversation with Balthazar.",
            )
            # segments is a generator — the actual inference work happens here,
            # while it's being iterated, not on the .transcribe() call above.
            text_out = " ".join([segment.text for segment in segments])
            text = text_out.strip()
            infer_ms = (time.time() - infer_start) * 1000
            total_ms = (time.time() - enqueue_time) * 1000
            print(f"[ASR TIMING] queue_wait={queue_wait_ms:.0f}ms infer={infer_ms:.0f}ms total={total_ms:.0f}ms", flush=True)
            return {"text": text}, 200
        else:
            return {"error": "faster-whisper model unavailable."}, 500
    except Exception as e:
        return {"error": str(e)}, 500
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)

@app.route('/transcribe', methods=['POST'])
def transcribe():
    global _in_flight

    audio_bytes = request.data
    if not audio_bytes or len(audio_bytes) < 128:
        return jsonify({"error": "No or too little audio received"}), 400

    arr = np.frombuffer(audio_bytes, dtype=np.int16)
    if arr.size == 0 or np.all(arr == 0):
        return jsonify({"error": "Audio data is empty or silent"}), 400

    if arr.size < 3200:
        return jsonify({"error": "Audio data too short (<0.2s)"}), 204

    # Use VAD instead of simple energy gate
    if not contains_speech(arr):
        return jsonify({"error": "No speech detected by VAD"}), 204

    with _in_flight_lock:
        if _in_flight >= MAX_QUEUE_SIZE:
            return jsonify({"error": "Dropped due to queue overflow"}), 429
        _in_flight += 1

    tmp_name = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            sf.write(tmp.name, arr, 16000, subtype='PCM_16')
            tmp_name = tmp.name

        future = executor.submit(process_job, tmp_name, time.time())
        try:
            data, code = future.result(timeout=JOB_TIMEOUT + 5)
        except concurrent.futures.TimeoutError:
            return jsonify({"error": f"Server response timed out after {JOB_TIMEOUT+5}s"}), 504

        return jsonify(data), code
    finally:
        with _in_flight_lock:
            _in_flight -= 1

@app.route('/', methods=['POST'])
def root_post():
    return transcribe()

@app.route('/', methods=['GET'])
def root_get():
    info = {
        "ok": True,
        "endpoint": "/transcribe",
        "engine": ASR_ENGINE,
        "model": os.environ.get("WHISPER_MODEL", "base.en"),
        "max_workers": MAX_WORKERS,
    }
    return jsonify(info), 200

if __name__ == '__main__':
    # threaded=True is required here too — without it Flask's dev server only
    # accepts one request at a time regardless of the worker pool above, which
    # would silently defeat the whole point of parallelizing the ASR workers.
    app.run(host='0.0.0.0', port=5005, threaded=True)
