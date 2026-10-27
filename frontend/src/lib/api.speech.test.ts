import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('transcribeAudio', () => {
  it('posts the WAV file, Portuguese language, and abort signal to the API', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      text: 'Olá Jarvis',
      language: 'pt',
      confidence: 0.9,
      duration_seconds: 1.2,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const { transcribeAudio } = await import('./api');
    const signal = new AbortController().signal;
    const audio = new Blob(['wav bytes'], { type: 'audio/wav' });

    await expect(transcribeAudio(audio, 'speech.wav', 'pt', signal)).resolves.toMatchObject({
      text: 'Olá Jarvis',
      language: 'pt',
      duration_seconds: 1.2,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/v1/speech/transcribe');
    expect(init?.method).toBe('POST');
    expect(init?.signal).toBe(signal);
    expect(init?.body).toBeInstanceOf(FormData);
    const body = init?.body as FormData;
    expect(body.get('language')).toBe('pt');
    expect(body.get('file')).toMatchObject({
      name: 'speech.wav',
      type: 'audio/wav',
    });
  });

  it('surfaces backend HTTP errors', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      detail: 'STT backend failed',
    }), { status: 500 }));
    const { transcribeAudio } = await import('./api');

    await expect(transcribeAudio(new Blob(['audio']), 'speech.wav', 'pt'))
      .rejects.toThrow('STT backend failed');
  });

  it('surfaces network failures', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { transcribeAudio } = await import('./api');

    await expect(transcribeAudio(new Blob(['audio']), 'speech.wav', 'pt'))
      .rejects.toThrow('Failed to fetch');
  });
});
