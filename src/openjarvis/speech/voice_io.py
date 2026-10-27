"""Microphone recording with silence detection and audio playback helpers."""

from __future__ import annotations

import io
import wave
from typing import Any

_SAMPLE_RATE = 16000
_CHANNELS = 1
_CHUNK = 1024
_SILENCE_THRESHOLD = 500  # RMS below this → silence
_SILENCE_SECONDS = 1.5  # seconds of silence before auto-stop
_STARTUP_SILENCE_SECONDS = 5.0  # give up early if speech never begins
_MAX_RECORD_SECONDS = 30  # safety ceiling


def _rms(data: bytes) -> float:
    """Compute RMS amplitude of 16-bit PCM bytes."""
    import struct

    n = len(data) // 2
    if n == 0:
        return 0.0
    shorts = struct.unpack(f"{n}h", data[: n * 2])
    return (sum(s * s for s in shorts) / n) ** 0.5


def record_until_silence(
    *,
    sample_rate: int = _SAMPLE_RATE,
    silence_threshold: int = _SILENCE_THRESHOLD,
    silence_seconds: float = _SILENCE_SECONDS,
    startup_silence_seconds: float = _STARTUP_SILENCE_SECONDS,
    max_seconds: float = _MAX_RECORD_SECONDS,
) -> bytes:
    """Record from the default microphone until silence is detected.

    Returns raw WAV bytes (16-bit mono).
    Raises RuntimeError if sounddevice is not installed.
    """
    try:
        import sounddevice as sd
    except ImportError:
        raise RuntimeError(
            "sounddevice is required for voice input. "
            "Install with: pip install sounddevice"
        )

    chunks_per_second = sample_rate / _CHUNK
    silence_chunks = int(silence_seconds * chunks_per_second)
    startup_silence_chunks = max(1, int(startup_silence_seconds * chunks_per_second))
    max_chunks = int(max_seconds * chunks_per_second)

    frames: list[bytes] = []
    silence_count = 0
    has_speech = False

    with sd.RawInputStream(
        samplerate=sample_rate,
        channels=_CHANNELS,
        dtype="int16",
        blocksize=_CHUNK,
    ) as stream:
        for _ in range(max_chunks):
            raw, _ = stream.read(_CHUNK)
            data = bytes(raw)
            frames.append(data)

            amplitude = _rms(data)
            if amplitude > silence_threshold:
                has_speech = True
                silence_count = 0
            elif not has_speech and len(frames) >= startup_silence_chunks:
                break
            elif has_speech:
                silence_count += 1
                if silence_count >= silence_chunks:
                    break

    return _frames_to_wav(frames, sample_rate)


def _frames_to_wav(frames: list[bytes], sample_rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(_CHANNELS)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(sample_rate)
        wf.writeframes(b"".join(frames))
    return buf.getvalue()


def play_wav(audio: bytes, sample_rate: int = 24000) -> None:
    """Play raw WAV bytes through the default output device.

    If the bytes are a valid WAV file, sample rate is read from the header;
    otherwise ``sample_rate`` is used as a fallback.
    """
    try:
        import numpy as np
        import sounddevice as sd
        import soundfile as sf
    except ImportError:
        raise RuntimeError(
            "sounddevice, numpy, and soundfile are required for voice output. "
            "Install with: pip install sounddevice numpy soundfile"
        )

    buf = io.BytesIO(audio)
    try:
        data, sr = sf.read(buf, dtype="float32")
    except Exception:
        # Fall back: treat as raw PCM
        import struct

        n = len(audio) // 2
        data = (
            np.array(struct.unpack(f"{n}h", audio[: n * 2]), dtype="float32") / 32768.0
        )
        sr = sample_rate

    sd.play(data, sr)
    sd.wait()


def decode_audio(audio: bytes, sample_rate: int = 24000) -> tuple[Any, int]:
    """Decode WAV bytes to ``(float32 mono samples, sample_rate)``.

    16-bit PCM WAV (what the local TTS backends emit) is decoded with the
    stdlib; other WAV encodings go through soundfile when it is installed;
    anything else is treated as raw 16-bit PCM at ``sample_rate``.
    """
    import numpy as np

    try:
        with wave.open(io.BytesIO(audio), "rb") as wf:
            if wf.getsampwidth() != 2:
                raise wave.Error("not 16-bit PCM")
            rate = wf.getframerate()
            channels = wf.getnchannels()
            pcm = wf.readframes(wf.getnframes())
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        if channels > 1:
            samples = samples.reshape(-1, channels).mean(axis=1)
        return samples, rate
    except (wave.Error, EOFError):
        pass
    try:
        import soundfile as sf

        data, rate = sf.read(io.BytesIO(audio), dtype="float32")
        if data.ndim > 1:
            data = data.mean(axis=1)
        return data, int(rate)
    except Exception:
        n = len(audio) // 2
        raw = np.frombuffer(audio[: n * 2], dtype="<i2").astype(np.float32)
        return raw / 32768.0, sample_rate


class StreamPlayer:
    """Gapless playback of float32 mono chunks through one output stream.

    ``play_wav`` opens a device stream per clip, which leaves an audible gap
    between clips and cannot start until a whole clip exists. Streaming TTS
    instead hands over ~80 ms frames; this player feeds them to a single
    stream. It holds back ``prebuffer_seconds`` of audio before starting the
    device so a producer running only slightly faster than real time (a TTS
    sharing the GPU with the LLM) does not underrun on the first syllables.
    """

    def __init__(self, prebuffer_seconds: float = 0.25) -> None:
        self._prebuffer_seconds = prebuffer_seconds
        self._stream: Any = None
        self._rate: int | None = None
        self._pending: list[Any] = []
        self._pending_frames = 0

    def write(self, samples: Any, sample_rate: int) -> None:
        """Queue ``samples`` for playback, blocking while the device is busy."""
        import numpy as np

        data = np.ascontiguousarray(samples, dtype=np.float32).reshape(-1, 1)
        if self._rate is not None and sample_rate != self._rate:
            self._finish()
        self._rate = sample_rate
        if self._stream is not None:
            self._stream.write(data)
            return
        self._pending.append(data)
        self._pending_frames += len(data)
        if self._pending_frames >= self._prebuffer_seconds * sample_rate:
            self._start()

    def close(self) -> None:
        """Play out everything written so far, then release the device."""
        self._finish()

    def abort(self) -> None:
        """Stop immediately, discarding queued audio."""
        self._pending, self._pending_frames = [], 0
        stream, self._stream = self._stream, None
        if stream is not None:
            stream.abort()
            stream.close()

    def _start(self) -> None:
        try:
            import sounddevice as sd
        except ImportError:
            raise RuntimeError(
                "sounddevice is required for voice output. "
                "Install with: pip install sounddevice"
            )
        stream = sd.OutputStream(samplerate=self._rate, channels=1, dtype="float32")
        stream.start()
        self._stream = stream
        pending, self._pending, self._pending_frames = self._pending, [], 0
        for block in pending:
            stream.write(block)

    def _finish(self) -> None:
        if self._stream is None and self._pending:
            self._start()
        stream, self._stream = self._stream, None
        self._rate = None
        if stream is not None:
            # PortAudio's stop waits for queued buffers to finish playing.
            stream.stop()
            stream.close()


def open_stream_player() -> StreamPlayer:
    """Return a player for one spoken reply (seam for tests)."""
    return StreamPlayer()


__all__ = [
    "StreamPlayer",
    "decode_audio",
    "open_stream_player",
    "play_wav",
    "record_until_silence",
]
