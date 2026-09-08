"""Sentence-chunked and token-streamed speech for chat TTS.

These tests pin the streaming contract: the full reply text always comes
back to the caller, every word reaches synthesis exactly once and in
order, the first chunk is cut early (at a clause) for fast
time-to-first-audio, and TTS problems never interrupt the chat.
"""

from __future__ import annotations

import pytest

from openjarvis.cli._voice_chat import (
    _split_sentences,
    _strip_markdown,
    speak_stream,
)
from openjarvis.speech.tts import TTSResult


class _Console:
    def __init__(self) -> None:
        self.printed: list[str] = []

    def print(self, *args, **kwargs) -> None:
        self.printed.append("".join(str(a) for a in args))


class _Backend:
    backend_id = "fake"

    def __init__(self, fail_on: str | None = None) -> None:
        self.synthesized: list[str] = []
        self._fail_on = fail_on

    def synthesize(self, text: str, **kwargs) -> TTSResult:
        if self._fail_on is not None and self._fail_on in text:
            raise RuntimeError("synth failed")
        self.synthesized.append(text)
        return TTSResult(audio=text.encode(), format="wav", sample_rate=24000)


class _Session:
    def __init__(self, backend: _Backend | None) -> None:
        self._backend = backend

    def get_voice_preferences(self):
        return ("fake", "voice-1", 1.0)

    def get_tts_backend(self):
        return self._backend

    def voice_for_backend(self, backend, console=None):
        return ("voice-1", 1.0)


@pytest.fixture
def played(monkeypatch) -> list[bytes]:
    calls: list[bytes] = []

    def _fake_play_wav(audio: bytes, sample_rate: int = 24000) -> None:
        calls.append(audio)

    monkeypatch.setattr("openjarvis.speech.voice_io.play_wav", _fake_play_wav)
    return calls


def _words(text: str) -> list[str]:
    return text.split()


# ---------------------------------------------------------------------------
# _split_sentences / _strip_markdown
# ---------------------------------------------------------------------------


def test_split_sentences_first_chunk_uses_lower_floor():
    text = "Bonjour Denis, ça va. " + "Ceci est une phrase plus longue. " * 4
    chunks = _split_sentences(text)
    assert chunks[0] == "Bonjour Denis, ça va."
    assert all(len(c) >= 60 for c in chunks[1:-1])
    assert _words(" ".join(chunks)) == _words(text)


def test_split_sentences_merges_short_fragments():
    chunks = _split_sentences("Oui. Non. Peut-être. D'accord.", first_chunk_chars=20)
    assert chunks == ["Oui. Non. Peut-être.", "D'accord."]


def test_split_sentences_empty_text():
    assert _split_sentences("   ") == []


def test_strip_markdown_removes_spoken_noise():
    md = "# Titre\n**gras** et `code` et [lien](http://x)\n- puce\n```py\nx=1\n```"
    stripped = _strip_markdown(md)
    for noise in ("#", "**", "`", "](", "http://x", "- puce", "x=1"):
        assert noise not in stripped
    for kept in ("Titre", "gras", "code", "lien", "puce"):
        assert kept in stripped


# ---------------------------------------------------------------------------
# speak_stream
# ---------------------------------------------------------------------------


def test_returns_full_text_and_speaks_every_word_in_order(played):
    deltas = ["Le ciel est bleu", ". La lumière ", "bleue est diffusée", " davantage."]
    backend = _Backend()
    text = speak_stream(iter(deltas), _Console(), _Session(backend))

    assert text == "".join(deltas)
    assert _words(" ".join(backend.synthesized)) == _words(text)
    assert played == [chunk.encode() for chunk in backend.synthesized]


def test_first_chunk_is_cut_at_a_clause_boundary(played):
    deltas = list(
        "Le ciel apparaît bleu, à cause de la diffusion Rayleigh qui touche "
        "surtout les courtes longueurs d'onde. Fin."
    )
    backend = _Backend()
    speak_stream(iter(deltas), _Console(), _Session(backend))
    assert backend.synthesized[0] == "Le ciel apparaît bleu,"


def test_markdown_is_stripped_before_synthesis(played):
    backend = _Backend()
    speak_stream(
        iter(["Voici **un point important** pour toi."]), _Console(), _Session(backend)
    )
    assert backend.synthesized == ["Voici un point important pour toi."]


def test_deltas_are_echoed_to_console(played):
    console = _Console()
    speak_stream(iter(["Salut", " Denis."]), console, _Session(_Backend()))
    assert "Salut" in console.printed and " Denis." in console.printed


def test_without_tts_backend_text_is_still_returned(played):
    text = speak_stream(iter(["Pas de voix", " ici."]), _Console(), _Session(None))
    assert text == "Pas de voix ici."
    assert played == []


def test_failed_chunk_is_skipped_and_the_rest_is_spoken(played):
    deltas = [
        "Première phrase assez longue pour partir. ",
        "Deuxième phrase BOOM, elle aussi assez longue pour partir toute seule. ",
        "Troisième phrase finale qui doit encore être prononcée.",
    ]
    backend = _Backend(fail_on="BOOM")
    text = speak_stream(iter(deltas), _Console(), _Session(backend))
    assert text == "".join(deltas)
    assert backend.synthesized[0].startswith("Première phrase")
    assert backend.synthesized[-1].startswith("Troisième phrase")
    assert not any("BOOM" in chunk for chunk in backend.synthesized)


def test_words_split_across_deltas_are_not_merged(played):
    # A short first sentence is held back below the chunk floor; the
    # whitespace ending one delta must survive into the next chunk.
    deltas = ["Il fait beau. La ", "lumière ", "bleue domine."]
    backend = _Backend()
    speak_stream(iter(deltas), _Console(), _Session(backend))
    spoken = " ".join(backend.synthesized)
    assert "lumière bleue" in spoken
    assert _words(spoken) == _words("".join(deltas))


def test_engine_error_propagates_without_hanging(played):
    def _deltas():
        yield "Début de réponse. "
        raise RuntimeError("engine down")

    with pytest.raises(RuntimeError, match="engine down"):
        speak_stream(_deltas(), _Console(), _Session(_Backend()))
