"""Voice input/output helpers for the interactive chat session."""

from __future__ import annotations

import logging
import queue
import re
import threading
from typing import Any, Optional

from rich.markup import escape

logger = logging.getLogger(__name__)

VOICE_EXIT = object()

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?…:])\s+")
# Until the first audio chunk is out, clause boundaries (commas) also
# qualify: a long opening sentence must not delay time-to-first-audio.
_CLAUSE_SPLIT = re.compile(r"(?<=[.!?…:,;])\s+")
# Markdown noise that TTS engines read out loud ("asterisk asterisk...").
_MD_PATTERNS = [
    (re.compile(r"```.*?```", re.DOTALL), " "),
    (re.compile(r"`([^`]*)`"), r"\1"),
    (re.compile(r"\*\*?([^*]+)\*\*?"), r"\1"),
    (re.compile(r"^#{1,6}\s*", re.MULTILINE), ""),
    (re.compile(r"\[([^\]]+)\]\([^)]+\)"), r"\1"),
    (re.compile(r"^\s*[-*•]\s+", re.MULTILINE), ""),
]

# Backend selection is shared with the API server and lives in
# openjarvis.speech._tts_discovery. Importing that at module level would pull
# the whole speech stack -- numpy included -- into every `jarvis` invocation,
# which tests/cli/test_cli.py guards against, so these aliases resolve lazily.
_LAZY_TTS_NAMES = {
    "_TTS_BACKEND_ORDER": "TTS_BACKEND_ORDER",
    "_BACKEND_DEFAULT_VOICE": "BACKEND_DEFAULT_VOICE",
}


def __getattr__(name: str) -> Any:
    target = _LAZY_TTS_NAMES.get(name)
    if target is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    from openjarvis.speech import _tts_discovery

    return getattr(_tts_discovery, target)


def _terminal_safe_text(value: object) -> str:
    """Remove terminal controls and escape Rich markup from dynamic text."""
    printable = "".join(
        char for char in str(value) if char in ("\n", "\t") or char.isprintable()
    )
    return escape(printable)


class VoiceSession:
    """Cache healthy speech backends for one interactive chat session."""

    def __init__(self, config: object | None = None) -> None:
        self._config = config
        self._stt_resolved = False
        self._stt_backend: Any = None
        self._tts_backend: Any = None
        self._tts_attempted: set[str] = set()
        self._voice_prefs: tuple[str, str, float] | None = None
        self._voice_warned: set[str] = set()
        # A background preload and the first reply can both resolve the TTS
        # backend; without the lock each would instantiate (and load) its own.
        self._tts_lock = threading.Lock()

    def get_stt_backend(self) -> Any:
        """Resolve and health-check STT once, then reuse the loaded backend."""
        if not self._stt_resolved:
            from openjarvis.core.config import load_config
            from openjarvis.speech._discovery import get_speech_backend

            config = self._config if self._config is not None else load_config()
            self._stt_backend = get_speech_backend(config)
            self._stt_resolved = True
        return self._stt_backend

    def get_stt_language(self) -> Optional[str]:
        """Return the configured ``speech.language``, or None to auto-detect."""
        from openjarvis.core.config import load_config

        config = self._config if self._config is not None else load_config()
        return (getattr(config.speech, "language", "") or "").strip() or None

    def get_tts_backend(self) -> Any:
        """Return a cached healthy TTS backend, falling through once per key."""
        with self._tts_lock:
            if self._tts_backend is not None:
                return self._tts_backend

            from openjarvis.speech._tts_discovery import get_tts_backend

            preferred, _, _ = self.get_voice_preferences()
            self._tts_backend = get_tts_backend(
                preferred, attempted=self._tts_attempted
            )
            return self._tts_backend

    def preload_tts(self) -> None:
        """Resolve the TTS backend and load its model ahead of the first reply.

        Meant for a background thread at session start: importing a
        torch-based TTS and loading its model can take tens of seconds,
        which would otherwise all land on the first spoken answer.
        Failures are logged; the normal speak path retries and reports.
        """
        try:
            backend = self.get_tts_backend()
            preload = getattr(backend, "preload", None)
            if callable(preload):
                voice_id, _ = self.voice_for_backend(backend)
                if voice_id:
                    preload(voice_id)
                else:
                    preload()
        except Exception:
            logger.debug("TTS preload failed", exc_info=True)

    def get_voice_preferences(self) -> tuple[str, str, float]:
        """Resolve configured (tts_backend, voice_id, speed), cached per session."""
        if self._voice_prefs is None:
            from openjarvis.core.config import load_config
            from openjarvis.speech._tts_discovery import voice_preferences

            config = self._config if self._config is not None else load_config()
            self._voice_prefs = voice_preferences(config)
        return self._voice_prefs

    def voice_for_backend(self, backend: Any, console: Any = None) -> tuple[str, float]:
        """Return the voice ID valid for ``backend``, plus the configured speed.

        Voice IDs are not portable across backends, so the configured
        ``speech.voice_id`` is honored only when ``backend`` is the configured
        ``speech.tts_backend``. Otherwise the fallback backend's own default is
        used and the substitution is reported once per session.
        """
        want_backend, voice_id, speed = self.get_voice_preferences()
        active = getattr(backend, "backend_id", "") or ""
        if active == want_backend:
            return voice_id, speed

        from openjarvis.speech._tts_discovery import default_voice_for

        substitute = default_voice_for(active)
        if console is not None and active not in self._voice_warned:
            self._voice_warned.add(active)
            console.print(
                f"[dim yellow]Voice: {want_backend!r} unavailable — using "
                f"{active!r} with its default voice "
                f"({substitute or 'backend default'}).[/dim yellow]"
            )
        return substitute, speed

    def discard_tts_backend(self) -> None:
        """Forget a backend that failed synthesis and allow the next fallback."""
        self._tts_backend = None


def read_voice_input(console: Any, session: VoiceSession) -> Optional[str] | object:
    """Accept a typed command/message, or record after an empty submission."""
    try:
        typed = input("You> [type, or press Enter to speak] ")
    except (EOFError, KeyboardInterrupt):
        return VOICE_EXIT
    typed = typed.strip()
    return typed if typed else record_voice(console, session)


def record_voice(
    console: Any,
    session: VoiceSession | None = None,
) -> Optional[str] | object:
    """Record from mic, transcribe, and return text or a loop sentinel."""
    from openjarvis.speech.voice_io import record_until_silence

    active_session = session or VoiceSession()
    backend = active_session.get_stt_backend()
    if backend is None:
        console.print(
            "[red]No speech-to-text backend available. "
            "Install the voice dependencies with: "
            "pip install 'OpenJarvis[speech]', or configure a healthy "
            "OpenAI/Deepgram backend.[/red]"
        )
        return VOICE_EXIT

    console.print("[dim cyan]Listening… (speak now, stops on silence)[/dim cyan]")
    try:
        audio_bytes = record_until_silence()
    except KeyboardInterrupt:
        return VOICE_EXIT
    except Exception as exc:
        # PortAudio failures are regular Exceptions (and can surface as
        # OSError), so report them without letting terminal control sequences
        # through. SystemExit deliberately continues to propagate, while
        # Ctrl-C maps to the chat loop's graceful-exit sentinel above.
        console.print(f"[red]Mic error: {_terminal_safe_text(exc)}[/red]")
        return VOICE_EXIT

    console.print("[dim]Transcribing…[/dim]")
    try:
        result = backend.transcribe(
            audio_bytes, format="wav", language=active_session.get_stt_language()
        )
        text = result.text.strip()
        if text:
            console.print(f"[bold]You (voice):[/bold] {_terminal_safe_text(text)}")
            return text
        console.print("[dim]Nothing heard — try again.[/dim]")
        return None
    except Exception as exc:
        console.print(f"[red]Transcription error: {_terminal_safe_text(exc)}[/red]")
        return None


def _strip_markdown(text: str) -> str:
    for pattern, repl in _MD_PATTERNS:
        text = pattern.sub(repl, text)
    return text


def _split_sentences(
    text: str, min_chars: int = 60, first_chunk_chars: int = 20
) -> list[str]:
    """Split text into sentence chunks, merging fragments below a floor.

    The first chunk uses a lower floor: getting any first sentence out
    fast is what makes the speech feel responsive, while later chunks
    can be longer since they synthesize during playback.
    """
    parts = [p.strip() for p in _SENTENCE_SPLIT.split(text.strip()) if p.strip()]
    chunks: list[str] = []
    buf = ""
    for part in parts:
        buf = f"{buf} {part}".strip() if buf else part
        floor = first_chunk_chars if not chunks else min_chars
        if len(buf) >= floor:
            chunks.append(buf)
            buf = ""
    if buf:
        chunks.append(buf)
    return chunks


def _speak_chunks(chunks: list[str], backend: Any, synth_kwargs: dict) -> None:
    """Pipeline synthesis and playback: chunk N+1 renders while N plays.

    Raises only when nothing was played, so the caller's backend-fallback
    loop can retry from silence; a failure after partial playback is
    logged rather than re-spoken through another backend.
    """
    from openjarvis.speech.voice_io import play_wav

    done = object()
    audio_queue: queue.Queue = queue.Queue(maxsize=2)
    errors: list[Exception] = []

    def _producer() -> None:
        try:
            for chunk in chunks:
                result = backend.synthesize(chunk, **synth_kwargs)
                if result.audio:
                    audio_queue.put(result)
        except Exception as exc:
            errors.append(exc)
        finally:
            audio_queue.put(done)

    threading.Thread(target=_producer, daemon=True).start()

    played = False
    while (item := audio_queue.get()) is not done:
        play_wav(item.audio, sample_rate=item.sample_rate)
        played = True

    if errors:
        if not played:
            raise errors[0]
        logger.warning("TTS failed after partial playback: %s", errors[0])


def _iter_audio(backend: Any, text: str, synth_kwargs: dict) -> Any:
    """Yield ``(float32 samples, sample_rate)`` for *text*.

    Backends exposing ``synthesize_stream`` hand over frames while they
    decode; others are synthesized whole and decoded into a single frame.
    """
    from openjarvis.speech.voice_io import decode_audio

    stream = getattr(backend, "synthesize_stream", None)
    if callable(stream):
        kwargs = {k: v for k, v in synth_kwargs.items() if k in ("voice_id", "speed")}
        yield from stream(text, **kwargs)
        return
    result = backend.synthesize(text, **synth_kwargs)
    if result.audio:
        yield decode_audio(result.audio, result.sample_rate)


def speak_stream(
    deltas: Any,
    console: Any,
    session: VoiceSession,
) -> str:
    """Echo LLM text deltas as they arrive and speak completed sentences.

    Three-stage pipeline: the main thread consumes ``deltas`` (printing
    them plain, unrendered), an incremental splitter emits sentence
    chunks as soon as they complete, a synth thread renders them to
    audio (frame by frame when the backend streams), and a playback
    thread feeds the frames to one continuous output stream — so speech
    starts on the first completed sentence while the LLM is still
    generating, without waiting for that sentence to be fully rendered.

    Returns the full response text. TTS failures degrade to silent echo
    rather than interrupting the chat; engine errors propagate.
    """
    from openjarvis.speech import voice_io

    backend = None
    synth_kwargs: dict[str, Any] = {}
    try:
        session.get_voice_preferences()
        backend = session.get_tts_backend()
        if backend is not None:
            voice_id, speed = session.voice_for_backend(backend, console)
            synth_kwargs = {"output_format": "wav", "speed": speed}
            if voice_id:
                synth_kwargs["voice_id"] = voice_id
    except Exception as exc:
        console.print(
            f"[dim yellow]Voice setup failed: {_terminal_safe_text(exc)}[/dim yellow]"
        )
        backend = None

    done = object()
    text_queue: queue.Queue = queue.Queue()
    # Items are audio frames (~80 ms each for streaming backends), so the
    # bound is in frames: enough to run well ahead of playback.
    audio_queue: queue.Queue = queue.Queue(maxsize=512)
    stop = threading.Event()
    player = voice_io.open_stream_player() if backend is not None else None

    def _synth() -> None:
        try:
            while not stop.is_set():
                chunk = text_queue.get()
                if chunk is done:
                    break
                try:
                    for frame in _iter_audio(backend, chunk, synth_kwargs):
                        if stop.is_set():
                            break
                        audio_queue.put(frame)
                except Exception as exc:
                    logger.warning("Streaming TTS synthesis failed: %s", exc)
        finally:
            audio_queue.put(done)

    def _play() -> None:
        broken = False
        while not stop.is_set():
            item = audio_queue.get()
            if item is done:
                break
            if broken:
                continue
            try:
                player.write(*item)
            except Exception as exc:
                # One warning, not one per 80 ms frame; keep draining so the
                # synth thread never blocks on a full queue.
                logger.warning("Streaming TTS playback failed: %s", exc)
                broken = True
        if not stop.is_set() and not broken:
            try:
                player.close()
            except Exception as exc:
                logger.warning("Streaming TTS playback failed: %s", exc)

    workers: list[threading.Thread] = []
    if backend is not None:
        workers = [
            threading.Thread(target=_synth, daemon=True),
            threading.Thread(target=_play, daemon=True),
        ]
        for worker in workers:
            worker.start()

    def _emit(chunk: str) -> None:
        if backend is not None and chunk:
            text_queue.put(chunk)

    received: list[str] = []
    pending = ""
    sent_any = False
    try:
        for delta in deltas:
            received.append(delta)
            console.print(delta, end="", markup=False, highlight=False)
            pending += delta
            splitter = _SENTENCE_SPLIT if sent_any else _CLAUSE_SPLIT
            parts = splitter.split(pending)
            if len(parts) > 1:
                # All but the last part end at a sentence boundary; merge
                # them to the same floors as _split_sentences (small first
                # chunk for fast time-to-first-audio, larger afterwards).
                buf = ""
                for part in (p.strip() for p in parts[:-1] if p.strip()):
                    buf = f"{buf} {part}".strip() if buf else part
                    floor = 20 if not sent_any else 60
                    if len(buf) >= floor:
                        _emit(_strip_markdown(buf).strip())
                        sent_any = True
                        buf = ""
                # No strip(): the tail may end in the whitespace that
                # separates it from the next delta's first word.
                pending = f"{buf} {parts[-1]}" if buf else parts[-1]
        _emit(_strip_markdown(pending).strip())
    except KeyboardInterrupt:
        # Cut speech immediately; workers are daemons and the queues die
        # with them. Re-raise so the chat loop reports the interrupt.
        stop.set()
        if player is not None:
            try:
                player.abort()
            except Exception:
                pass
        raise
    finally:
        text_queue.put(done)
        console.print()

    # Let queued speech finish before handing the prompt back (matches
    # the blocking behavior of non-streaming speak()).
    for worker in workers:
        worker.join()
    return "".join(received)


def speak(text: str, console: Any, session: VoiceSession | None = None) -> None:
    """Synthesize and play text, reusing a healthy backend for the session.

    The text is spoken in sentence chunks, pipelined so the first
    sentence plays while the rest is still synthesizing.
    """
    active_session = session or VoiceSession()

    # Resolved before the loop: a bad config value must surface as a config
    # error, not be swallowed by the per-backend fallback handler below.
    try:
        active_session.get_voice_preferences()
    except Exception as exc:
        console.print(f"[red]Invalid speech config: {_terminal_safe_text(exc)}[/red]")
        return

    chunks = _split_sentences(_strip_markdown(text))
    if not chunks:
        return

    while (backend := active_session.get_tts_backend()) is not None:
        try:
            voice_id, speed = active_session.voice_for_backend(backend, console)
            synth_kwargs: dict[str, Any] = {"output_format": "wav", "speed": speed}
            if voice_id:
                synth_kwargs["voice_id"] = voice_id
            _speak_chunks(chunks, backend, synth_kwargs)
            return
        except Exception as exc:
            console.print(
                f"[dim yellow]Voice backend "
                f"{getattr(backend, 'backend_id', '?')!r} failed: "
                f"{_terminal_safe_text(exc)}[/dim yellow]"
            )
            active_session.discard_tts_backend()

    console.print(
        "[dim yellow]No TTS backend available — install kokoro: "
        "pip install kokoro[/dim yellow]"
    )


__all__ = [
    "VOICE_EXIT",
    "VoiceSession",
    "read_voice_input",
    "record_voice",
    "speak",
    "speak_stream",
]
