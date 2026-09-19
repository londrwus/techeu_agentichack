"""/api/briefing: Gemini writes a ~30s script from summary.json, Gemini TTS speaks it, cached as WAV."""
import base64
import io
import json
import wave

from backend import data
from backend.agent import gemini, MODEL
from backend.live import COUNTERS

TTS_MODEL = "gemini-3.1-flash-tts-preview"
WAV = "briefing.wav"


def pcm_to_wav(pcm: bytes, rate=24000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


async def build_briefing() -> bytes:
    client = gemini()
    summ = data.get_summary()
    mods = [{k: m.get(k) for k in ("name", "pressure", "top_item", "prob_up_6m", "change_6m_pct")} for m in summ.get("modules", [])]
    heads = {m["module_id"]: (data.read_json(f"insights/{m['module_id']}.json") or {}).get("headline") for m in summ.get("modules", [])}
    prompt = ("Write a punchy spoken radio briefing called \"Tomorrow's Prices\" for Londoners, about 70 words (30 seconds). "
              "Open with 'This is Orbit, with tomorrow's prices.' Mention that satellites spotted it first. Cover the 2-3 "
              "highest-pressure categories with concrete % moves, and end with one buy-now tip. Plain text only, no markup.\n\n"
              f"DATA: {json.dumps({'modules': mods, 'headlines': heads}, default=str)}")
    it = await client.aio.interactions.create(model=MODEL, input=prompt, store=False, generation_config={"thinking_level": "low"})
    COUNTERS["gemini_calls"] += 1
    script = (it.output_text or "").strip() or "This is Orbit, with tomorrow's prices."
    tts = await client.aio.interactions.create(
        model=TTS_MODEL, store=False,
        input=f"Say in a confident, upbeat newsreader voice: {script}",
        response_format={"type": "audio"},
        generation_config={"speech_config": [{"voice": "Charon"}]})
    COUNTERS["gemini_calls"] += 1
    audio = tts.output_audio
    raw = base64.b64decode(audio.data) if isinstance(audio.data, str) else audio.data
    mime = (getattr(audio, "mime_type", "") or "").lower()
    wav = raw if raw[:4] == b"RIFF" else pcm_to_wav(raw, int(mime.split("rate=")[1].split(";")[0]) if "rate=" in mime else 24000)
    p = data.DATA / WAV
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(wav)
    (data.DATA / "briefing.txt").write_text(script, encoding="utf-8")
    return wav
