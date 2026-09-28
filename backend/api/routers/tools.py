"""
Tools router — Phase 4.6 (ROADMAP.md).

Standalone utilities exposed as first-class endpoints, independent of the
dub pipeline. The Tools page UI consumes these. Headless CLI consumers
(omnivoice-dub) will share the same service layer.

Shipped today:

    POST /tools/probe       → ffprobe-style metadata for a file path.
    POST /tools/incremental → plan what segments need regenerating.
    POST /tools/direction   → parse a natural-language direction into tokens.
    POST /tools/rate-fit    → LLM-assisted slot-fit for translated text.
    POST /tools/merge-audio → concatenate uploaded audio clips into a WAV.

More utilities (vocal separation and alignment) remain for follow-up passes.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import os
import re
import tempfile
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, File, UploadFile, Form
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from services import director, speech_rate, incremental
from services.ffmpeg_utils import find_ffmpeg, find_ffprobe, run_ffmpeg, spawn_subprocess
from api.dependencies import require_native_access
from core.path_security import UnsafePath, resolve_within

logger = logging.getLogger("omnivoice.tools")
router = APIRouter()


def _write_audio_input(path: str, data: bytes) -> None:
    with open(path, "wb") as audio_file:
        audio_file.write(data)


def _read_audio_output(path: str) -> bytes:
    with open(path, "rb") as audio_file:
        return audio_file.read()


async def _communicate_with_timeout(
    proc: Any, timeout: float
) -> tuple[bytes | None, bytes | None]:
    try:
        return await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        with contextlib.suppress(ProcessLookupError, OSError):
            proc.kill()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(proc.wait(), timeout=5)
        raise


@router.post("/tools/merge-audio", dependencies=[Depends(require_native_access)])
async def merge_audio(files: list[UploadFile] = File(...)):
    """Concatenate uploaded audio clips in order into a clone-ready WAV."""
    if not 2 <= len(files) <= 20:
        raise HTTPException(status_code=422, detail="Choose between 2 and 20 audio files.")

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise HTTPException(status_code=501, detail="FFmpeg is not available. Open Settings → Audio tools to install it.")
    ffprobe = find_ffprobe()
    if not ffprobe:
        raise HTTPException(status_code=501, detail="FFprobe is not available. Open Settings → Audio tools to install it.")

    max_file_bytes = 64 * 1024 * 1024
    max_total_bytes = 256 * 1024 * 1024
    max_total_duration = 30 * 60
    total_bytes = 0
    inputs: list[bytes] = []
    for upload in files:
        data = await upload.read(max_file_bytes + 1)
        if not data:
            raise HTTPException(status_code=422, detail="One of the selected files is empty.")
        if len(data) > max_file_bytes:
            raise HTTPException(status_code=413, detail="Each audio file must be 64 MiB or smaller.")
        total_bytes += len(data)
        if total_bytes > max_total_bytes:
            raise HTTPException(status_code=413, detail="The selected audio files exceed 256 MiB total.")
        inputs.append(data)

    with tempfile.TemporaryDirectory(prefix="voicestudio-merge-") as temp_dir:
        input_paths = [os.path.join(temp_dir, f"input-{index}.audio") for index in range(len(inputs))]
        output_path = os.path.join(temp_dir, "merged.wav")
        for path, data in zip(input_paths, inputs, strict=True):
            await run_in_threadpool(_write_audio_input, path, data)

        total_duration = 0.0
        for path in input_paths:
            probe = await spawn_subprocess(
                ffprobe, "-v", "error", "-select_streams", "a:0",
                "-show_entries", "stream=duration:format=duration", "-of", "json", path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, _ = await _communicate_with_timeout(probe, 30)
            except asyncio.TimeoutError as exc:
                raise HTTPException(
                    status_code=422,
                    detail="One or more files could not be read as audio.",
                ) from exc
            try:
                metadata = json.loads(stdout.decode("utf-8")) if probe.returncode == 0 else {}
                stream_duration = (metadata.get("streams") or [{}])[0].get("duration")
                try:
                    duration = float(stream_duration)
                except (ValueError, TypeError):
                    duration = float(metadata.get("format", {}).get("duration", 0))
            except (ValueError, TypeError, json.JSONDecodeError, AttributeError):
                duration = 0.0
            if not math.isfinite(duration) or duration <= 0:
                raise HTTPException(status_code=422, detail="One or more files could not be read as audio.")
            total_duration += duration
            if total_duration > max_total_duration:
                raise HTTPException(status_code=413, detail="The combined audio must be 30 minutes or shorter.")

        filters = []
        for index in range(len(input_paths)):
            filters.append(
                f"[{index}:a:0]aresample=24000,aformat=sample_fmts=fltp:channel_layouts=mono,"
                f"asetpts=PTS-STARTPTS[a{index}]"
            )
        concat_inputs = "".join(f"[a{index}]" for index in range(len(input_paths)))
        filters.append(f"{concat_inputs}concat=n={len(input_paths)}:v=0:a=1[out]")
        command = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
        for path in input_paths:
            command.extend(["-i", path])
        command.extend([
            "-filter_complex", ";".join(filters), "-map", "[out]",
            "-c:a", "pcm_s16le", "-ar", "24000", "-ac", "1", "-f", "wav", output_path,
        ])
        try:
            returncode, _, stderr = await run_ffmpeg(command, timeout=300, capture=False)
        except asyncio.TimeoutError as exc:
            raise HTTPException(
                status_code=408,
                detail="Audio merge took too long. Try shorter clips.",
            ) from exc
        if returncode != 0:
            logger.info("Audio merge decode failed: %s", (stderr or b"").decode(errors="replace")[-1000:])
            raise HTTPException(status_code=422, detail="One or more files could not be read as audio.")
        try:
            output = await run_in_threadpool(_read_audio_output, output_path)
        except OSError as exc:
            raise HTTPException(status_code=500, detail="The merged audio file could not be created.") from exc

    return Response(
        output,
        media_type="audio/wav",
        headers={"Content-Disposition": 'attachment; filename="merged-reference.wav"'},
    )


# ── Probe (ffprobe wrapper) ────────────────────────────────────────────────


class ProbeReq(BaseModel):
    path: str


@router.post("/tools/probe", dependencies=[Depends(require_native_access)])
async def probe(req: ProbeReq):
    target = os.path.realpath(os.path.expanduser(req.path))
    if not os.path.exists(target):
        raise HTTPException(
            status_code=404,
            detail="File not found. Provide an absolute path to an existing file.",
        )
    ffprobe = find_ffprobe()
    if not ffprobe:
        raise HTTPException(
            status_code=501,
            detail="ffprobe binary not available. Install system ffmpeg or re-run the setup.",
        )
    proc = await spawn_subprocess(
        ffprobe, "-v", "quiet", "-print_format", "json",
        "-show_format", "-show_streams", target,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise HTTPException(
            status_code=500,
            detail=f"ffprobe failed: {stderr.decode(errors='replace')[:400]}",
        )
    try:
        return json.loads(stdout.decode("utf-8"))
    except json.JSONDecodeError:
        return {"raw": stdout.decode("utf-8", errors="replace")}


# ── Incremental plan (what needs regenerating) ─────────────────────────────


class IncrementalReq(BaseModel):
    segments: list[dict]
    stored_hashes: Optional[dict[str, str]] = None
    # P1.3 — the ACTIVE track's language code. When set, fingerprints are
    # scoped to that language (pass that language's stored hashes alongside);
    # omitted → legacy language-agnostic hashing, kept for old callers.
    lang: Optional[str] = None
    # Voice-identity mode the client will generate with (DubRequest.voice_match).
    # Only "consistent" changes the hash (per_line/omitted == legacy), so
    # flipping the Voice-match toggle marks every segment stale — the audio
    # really would come out with a different reference (#281 class).
    voice_match: Optional[str] = None


@router.post("/tools/incremental")
def plan_incremental(req: IncrementalReq):
    return incremental.plan_incremental(
        req.segments,
        stored_hashes=req.stored_hashes or {},
        track_lang=req.lang,
        voice_match=req.voice_match,
    )


# ── Directorial AI parse ───────────────────────────────────────────────────


class DirectionReq(BaseModel):
    text: str = Field(..., description="Natural-language direction, e.g. 'urgent and surprised'")


@router.post("/tools/direction")
def parse_direction(req: DirectionReq):
    d = director.parse(req.text)
    return {
        "tokens":          d.tokens,
        "instruct_prompt": d.instruct_prompt(),
        "translate_hint":  d.translate_hint(),
        "rate_bias":       d.rate_bias(),
        "method":          d.method,
        "error":           d.error,
        "taxonomy":        director.TAXONOMY,
    }


# ── Speech-rate fit ────────────────────────────────────────────────────────


class RateFitReq(BaseModel):
    text: str
    slot_seconds: float
    target_lang: str
    source_text: Optional[str] = None


@router.post("/tools/rate-fit")
def rate_fit(req: RateFitReq):
    return speech_rate.adjust_for_slot(
        req.text,
        slot_seconds=req.slot_seconds,
        target_lang=req.target_lang,
        source_text=req.source_text,
    )


# ── Audio effects presets ──────────────────────────────────────────────────


@router.get("/tools/effects")
def list_effects():
    """Return available audio effect presets (Broadcast, Cinematic, etc.)."""
    from services.audio_dsp import list_effect_presets
    return list_effect_presets()


# ── TTS Plugin SDK ─────────────────────────────────────────────────────────


@router.get("/tools/plugins")
def list_tts_plugins():
    """Return all registered TTS engine plugins and their availability."""
    from services.plugin_sdk import list_plugins
    return list_plugins()


# ── Video context analysis ─────────────────────────────────────────────────


@router.post("/tools/video-context/{job_id}")
async def analyse_video_context(job_id: str):
    """Analyse the source video's visual context for dubbing decisions.

    Returns per-segment mood, brightness, and complexity cues that
    can be used as TTS instruct hints.
    """
    import os
    from api.routers.dub_core import _get_job
    from core.config import DUB_DIR
    from services.video_context import analyse_video

    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", job_id or ""):
        raise HTTPException(status_code=400, detail="Invalid job id")
    try:
        job_dir = resolve_within(DUB_DIR, job_id)
    except UnsafePath as exc:
        raise HTTPException(status_code=400, detail="Invalid job id") from exc
    job = _get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    video_path = resolve_within(DUB_DIR, job_dir / "source.mp4")
    if not video_path.is_file():
        try:
            video_path = resolve_within(DUB_DIR, job.get("video_path", ""))
        except UnsafePath:
            return {"error": "Source video not found", "segments": {}}

    if not video_path.is_file():
        return {"error": "Source video not found", "segments": {}}

    segments = job.get("segments") or []
    ctx = await analyse_video(str(video_path), segments)
    return ctx.to_dict()


# Workflow audio is already synthetic. Re-mark after processing through the
# existing chokepoint rather than routing it through human mic cleanup.
def _decode_workflow_audio(data: bytes):
    import io
    import numpy as np
    import soundfile as sf
    import torch

    try:
        with sf.SoundFile(io.BytesIO(data)) as source:
            if source.format != "WAV" or source.channels not in (1, 2):
                raise ValueError("Expected mono or stereo WAV")
            if source.frames < 1 or source.frames * source.channels > 16_000_000:
                raise ValueError("Audio exceeds the processing limit")
            audio = source.read(dtype="float32", always_2d=True)
            rate = source.samplerate
        if not np.isfinite(audio).all():
            raise ValueError("Invalid audio samples")
        return torch.from_numpy(audio.T.copy()), rate
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=422, detail="Provide a valid WAV within the audio size limit.") from exc


def _encode_workflow_audio(audio, rate: int) -> bytes:
    import io
    from services.audio_io import _safe_soundfile_write

    output = io.BytesIO()
    _safe_soundfile_write(output, audio.detach().cpu().numpy().T, rate, format="WAV", subtype="PCM_16")
    return output.getvalue()


@router.post("/tools/normalize-speech")
async def normalize_workflow_speech(
    audio: UploadFile = File(...),
    target_dbfs: float = Form(-2.0, ge=-24.0, le=-1.0),
):
    """Peak-normalize synthetic speech; bounded and entirely local."""
    from services.audio_dsp import normalize_audio
    from services.watermark import mark_synthetic_async

    data = await audio.read(64 * 1024 * 1024 + 1)
    if len(data) > 64 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Audio exceeds 64 MiB.")
    waveform, rate = await run_in_threadpool(_decode_workflow_audio, data)
    waveform = await run_in_threadpool(normalize_audio, waveform, target_dBFS=target_dbfs)
    waveform = await mark_synthetic_async(waveform, rate, context="workflow.normalize")
    encoded = await run_in_threadpool(_encode_workflow_audio, waveform, rate)
    return Response(encoded, media_type="audio/wav")
