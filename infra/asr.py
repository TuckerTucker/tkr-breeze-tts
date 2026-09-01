"""Speech recognition, deployed as a sibling app.

The word timestamps are the point. A reference recording and its transcript
have to describe the same audio — the vendor requires the transcript to be
*exact* — so trimming a recording without re-deriving its transcript breaks the
pair. Per-word times make the trimmed transcript a slice of the one already
computed, rather than a second GPU request per drag of a handle.

Three things are deliberately not shared with ``infra.service``:

* **The app.** A once-per-sitting transcription and an interactive synthesis
  want opposite warm windows, and `AsrConfig` is frozen per service. Separate
  apps is what expressing that honestly looks like, and it means redeploying
  one never restarts the other.
* **The GPU.** An L4 transcribes far faster than real time. Transcription is
  not the latency claim this demo makes, and an H100 for it is waste.
* **The image.** No torch, no FlashAttention, no vendor clone. CTranslate2 is
  its own runtime.

What they do share is the weights Volume and the workspace's proxy token pair.

The model load lives in ``@modal.enter()``, not the ASGI lifespan, for the same
reason it does in the synthesis service: Modal marks a container warm when
``enter()`` returns, so a load left in the lifespan lets requests route to a
container that is not ready.
"""

# Deliberately no `from __future__ import annotations`.
#
# The route handlers below are defined inside `serve()`, where `UploadFile` and
# friends are local imports — the container has FastAPI, this repo's own
# environment does not, and the tests import this module. Under PEP 563 an
# annotation is stored as a *string* and FastAPI resolves it through
# `get_type_hints`, which looks in the function's **module** globals. There it
# finds nothing, and the route 500s at first request with a
# `PydanticUserError: ... is not fully defined`. Evaluated eagerly, the
# annotation binds the class that is actually in scope.

import time
from typing import Any, Final

import modal

from infra.asr_image import asr_image
from infra.asr_weights import ASR_MODEL_DIR, require_asr_model
from infra.config import ASR_APP_NAME, ASR_CONFIG, MODEL_MOUNT_PATH
from infra.weights import volume

app: Final[modal.App] = modal.App(ASR_APP_NAME)

# Silero VAD is applied before decoding, so a recording's cost tracks its
# speech rather than its length. A forty-minute podcast is mostly not silence,
# but the interviews and field recordings this demo takes as references often
# are.
VAD_ENABLED: Final[bool] = True


@app.cls(
    image=asr_image,
    gpu=ASR_CONFIG.gpu_spec,
    volumes={MODEL_MOUNT_PATH: volume},
    scaledown_window=ASR_CONFIG.scaledown_window_s,
    min_containers=ASR_CONFIG.min_containers,
    timeout=ASR_CONFIG.timeout_s,
)
class AsrService:
    """Transcribes reference audio, with a start and end time per word."""

    load_ms: float | None = None

    @modal.enter()
    def load(self) -> None:
        """Place the model on the GPU before the container reports warm.

        Raises:
            AsrModelIncomplete: If the Volume holds no usable conversion. The
                container then never reports warm, so no request is routed to
                it — a clearer failure than one that answers 503 forever.
        """
        from faster_whisper import WhisperModel

        started = time.perf_counter()
        report = require_asr_model(ASR_MODEL_DIR)
        print(
            f"recognition model verified: {report.total_bytes} bytes at "
            f"{ASR_MODEL_DIR}",
            flush=True,
        )

        # Loaded from the Volume by path, never by repo id: a repo id would
        # send this to the Hub on every cold start, which is the download the
        # Volume exists to avoid.
        self.model = WhisperModel(
            ASR_MODEL_DIR,
            device="cuda",
            compute_type=ASR_CONFIG.compute_type,
        )
        self.load_ms = (time.perf_counter() - started) * 1000
        print(
            f"asr service ready load_ms={self.load_ms:.1f} "
            f"gpu={ASR_CONFIG.gpu_spec} compute_type={ASR_CONFIG.compute_type}",
            flush=True,
        )

    @modal.asgi_app(requires_proxy_auth=ASR_CONFIG.requires_proxy_auth)
    def serve(self) -> Any:
        """Build the FastAPI app.

        Returns:
            An app exposing ``GET /health`` and
            ``POST /v1/audio/transcriptions``.
        """
        import tempfile
        from pathlib import Path

        from fastapi import FastAPI, File, UploadFile
        from fastapi.responses import JSONResponse

        api = FastAPI(title="breeze-tts-asr")
        model = self.model
        load_ms = self.load_ms

        @api.get("/health")
        def health() -> dict[str, object]:
            """Report readiness without touching the model.

            Returns:
                The load time and the posture in force.
            """
            return {
                "status": "ok",
                "load_ms": load_ms,
                "compute_type": ASR_CONFIG.compute_type,
                "model": ASR_MODEL_DIR,
            }

        @api.post("/v1/audio/transcriptions")
        async def transcribe(file: UploadFile = File(...)) -> Any:
            """Transcribe one recording, with per-word times.

            The OpenAI endpoint's shape, so callers read it as a convention
            rather than something invented here. No language field is accepted:
            the language is *detected* and reported back. The demo's EN/ZH
            toggle drives the vocal-event palette and nothing else, and giving
            it a second meaning would be a second thing to keep true.

            Args:
                file: The audio to transcribe. The gateway normalises to WAV
                    before sending, but PyAV decodes whatever arrives.

            Returns:
                The full text, the detected language, the audio duration, and
                every word with a start and an end.
            """
            payload = await file.read()
            if not payload:
                return JSONResponse(
                    status_code=400,
                    content={"error": "the uploaded file is empty"},
                )

            started = time.perf_counter()
            # Written to disk rather than passed as a stream: PyAV probes by
            # seeking, and a non-seekable body makes format detection fail on
            # exactly the containers a browser produces.
            with tempfile.TemporaryDirectory() as workdir:
                source = Path(workdir) / (file.filename or "reference")
                source.write_bytes(payload)
                try:
                    segments, info = model.transcribe(
                        str(source),
                        word_timestamps=True,
                        vad_filter=VAD_ENABLED,
                        beam_size=ASR_CONFIG.beam_size,
                    )
                    # `segments` is a generator: nothing is decoded until it is
                    # consumed, so the timing below covers the real work.
                    collected = list(segments)
                except Exception as exc:  # noqa: BLE001 — reported, not raised
                    return JSONResponse(
                        status_code=400,
                        content={
                            "error": f"the audio could not be decoded: {exc}",
                        },
                    )

            words = [
                {
                    "word": word.word,
                    "start": round(word.start, 3),
                    "end": round(word.end, 3),
                }
                for segment in collected
                for word in (segment.words or ())
            ]
            text = "".join(segment.text for segment in collected).strip()
            elapsed_ms = (time.perf_counter() - started) * 1000
            print(
                f"transcribed duration={info.duration:.1f}s "
                f"language={info.language} words={len(words)} "
                f"elapsed_ms={elapsed_ms:.0f}",
                flush=True,
            )

            return {
                "text": text,
                "language": info.language,
                "language_probability": round(info.language_probability, 4),
                "duration": round(info.duration, 3),
                "words": words,
            }

        return api
