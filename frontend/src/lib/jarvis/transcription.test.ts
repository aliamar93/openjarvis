import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isUsableTranscription,
  TranscriptionTimeoutError,
  withTranscriptionTimeout,
} from './transcription';

afterEach(() => {
  vi.useRealTimers();
});

describe('withTranscriptionTimeout', () => {
  it('discards empty and single-character transcripts', () => {
    expect(isUsableTranscription('')).toBe(false);
    expect(isUsableTranscription('  ')).toBe(false);
    expect(isUsableTranscription('a')).toBe(false);
    expect(isUsableTranscription(' Olá ')).toBe(true);
  });

  it('resolves successful transcriptions and clears its timer', async () => {
    vi.useFakeTimers();
    const operation = Promise.resolve({ text: 'Olá' });

    await expect(withTranscriptionTimeout(operation, 300_000, vi.fn()))
      .resolves.toEqual({ text: 'Olá' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('surfaces backend and network errors without masking them', async () => {
    const failure = new Error('backend unavailable');

    await expect(withTranscriptionTimeout(
      Promise.reject(failure),
      300_000,
      vi.fn(),
    )).rejects.toBe(failure);
  });

  it('aborts and rejects when transcription exceeds its deadline', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const operation = new Promise<string>((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
    const request = withTranscriptionTimeout(
      operation,
      300_000,
      () => controller.abort(),
    );
    const rejection = expect(request).rejects.toBeInstanceOf(TranscriptionTimeoutError);

    await vi.advanceTimersByTimeAsync(300_000);
    await rejection;

    expect(controller.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its timer when the request is cancelled', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const operation = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
    const request = withTranscriptionTimeout(operation, 300_000, vi.fn());
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' });

    controller.abort();
    await rejection;

    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows another transcription after a failed attempt', async () => {
    await expect(withTranscriptionTimeout(
      Promise.reject(new Error('transcription failed')),
      300_000,
      vi.fn(),
    )).rejects.toThrow('transcription failed');

    await expect(withTranscriptionTimeout(
      Promise.resolve({ text: 'nova tentativa' }),
      300_000,
      vi.fn(),
    )).resolves.toEqual({ text: 'nova tentativa' });
  });
});
