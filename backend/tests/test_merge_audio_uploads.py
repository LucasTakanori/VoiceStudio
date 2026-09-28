"""Real local decoding for the clone picker's automatic multi-file reference."""
import io
import math
import shutil
import struct
import wave

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def client(monkeypatch):
    from api.routers import tools
    from api.dependencies import require_native_access

    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        pytest.skip("real FFmpeg and FFprobe required")
    monkeypatch.setattr(tools, "find_ffmpeg", lambda: ffmpeg)
    monkeypatch.setattr(tools, "find_ffprobe", lambda: ffprobe)
    app = FastAPI()
    app.dependency_overrides[require_native_access] = lambda: None
    app.include_router(tools.router)
    with TestClient(app) as client:
        yield client


def wav(value, rate=24000, channels=1):
    out = io.BytesIO()
    with wave.open(out, "wb") as audio:
        audio.setnchannels(channels)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        audio.writeframes(struct.pack("<h", value) * (rate // 10) * channels)
    return out.getvalue()


def test_five_clips_merge_in_order_with_mixed_rates_and_channels(client):
    levels = [1000, 2000, 3000, 4000, 5000]
    response = client.post("/tools/merge-audio", files=[
        ("files", (f"{index}.wav", wav(level, 16000 if index % 2 else 48000,
                                     2 if index % 2 else 1), "audio/wav"))
        for index, level in enumerate(levels)
    ])
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("audio/wav")
    with wave.open(io.BytesIO(response.content)) as audio:
        assert audio.getnchannels() == 1
        assert audio.getframerate() == 24000
        assert audio.getnframes() == 12000
        samples = struct.unpack("<12000h", audio.readframes(12000))
    for index, expected in enumerate(levels):
        # FFmpeg's float stereo downmix weights each channel by 1/sqrt(2).
        if index % 2:
            expected *= math.sqrt(2)
        assert samples[index * 2400 + 1200] == pytest.approx(expected, abs=2)


@pytest.mark.parametrize("count", [1, 21])
def test_invalid_count_is_rejected(client, count):
    response = client.post("/tools/merge-audio", files=[
        ("files", (f"{i}.wav", wav(1000), "audio/wav")) for i in range(count)
    ])
    assert response.status_code == 422


@pytest.mark.parametrize("bad", [b"", b"not an audio file"])
def test_bad_clip_does_not_produce_partial_output(client, bad):
    response = client.post("/tools/merge-audio", files=[
        ("files", ("good.wav", wav(1000), "audio/wav")),
        ("files", ("bad.wav", bad, "audio/wav")),
    ])
    assert response.status_code == 422
