"""Kyutai Pocket TTS backend — 100M-param streaming TTS, real-time on CPU.

Requires the pocket-tts package: pip install pocket-tts
Falls back gracefully if not installed.
"""

from __future__ import annotations

import io
from typing import List

from openjarvis.core.registry import TTSRegistry
from openjarvis.speech.tts import TTSBackend, TTSResult

# Pocket TTS loads one model per language; voice ids imply their language.
_VOICE_LANGUAGES = {
    "alba": "english",
    "marius": "english",
    "estelle": "french_24l",
}

# Frames are ~12.5 Hz; the library default (max_tokens=50, ~4 s) truncates
# anything longer than a short sentence.
_MAX_TOKENS = 2500


@TTSRegistry.register("pocket")
class PocketTTSBackend(TTSBackend):
    """Kyutai Pocket TTS — local streaming voice synthesis."""

    backend_id = "pocket"

    def __init__(self, *, language: str = "", device: str = "auto") -> None:
        self._language_override = language
        self._device = device
        self._models: dict = {}
        self._voice_states: dict = {}

    def _ensure_model(self, language: str):
        if language not in self._models:
            try:
                from pocket_tts import TTSModel
            except ImportError:
                raise RuntimeError(
                    "pocket-tts package not installed. "
                    "Install with: pip install pocket-tts"
                )
            import torch

            # Quantization cuts CPU RTF from ~1.2 to ~0.8 on the 24l
            # variants; on GPU it is unnecessary.
            quantize = not torch.cuda.is_available()
            self._models[language] = TTSModel.load_model(
                language=language, quantize=quantize
            )
        return self._models[language]

    def _ensure_voice_state(self, model, language: str, voice_id: str):
        key = (language, voice_id)
        if key not in self._voice_states:
            self._voice_states[key] = model.get_state_for_audio_prompt(voice_id)
        return self._voice_states[key]

    def synthesize(
        self,
        text: str,
        *,
        voice_id: str = "alba",
        speed: float = 1.0,  # pocket-tts has no speed control; interface parity
        output_format: str = "wav",
    ) -> TTSResult:
        language = self._language_override or _VOICE_LANGUAGES.get(voice_id, "english")
        model = self._ensure_model(language)
        state = self._ensure_voice_state(model, language, voice_id)

        import soundfile as sf

        audio = model.generate_audio(state, text, max_tokens=_MAX_TOKENS)

        samples = audio.detach().cpu().numpy()
        if samples.ndim > 1:
            samples = samples.squeeze()
        if samples.size == 0:
            return TTSResult(audio=b"", format=output_format, voice_id=voice_id)

        sample_rate = int(model.sample_rate)
        buf = io.BytesIO()
        sf.write(buf, samples, sample_rate, format=output_format.upper())
        buf.seek(0)

        return TTSResult(
            audio=buf.read(),
            format=output_format,
            voice_id=voice_id,
            sample_rate=sample_rate,
            duration_seconds=len(samples) / sample_rate,
            metadata={"backend": "pocket", "language": language},
        )

    def available_voices(self) -> List[str]:
        return list(_VOICE_LANGUAGES)

    def health(self) -> bool:
        try:
            import pocket_tts  # noqa: F401

            return True
        except ImportError:
            return False
