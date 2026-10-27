export const TRANSCRIPTION_TIMEOUT_MS = 5 * 60 * 1000;

export class TranscriptionTimeoutError extends Error {
  constructor() {
    super('Speech transcription timed out.');
    this.name = 'TranscriptionTimeoutError';
  }
}

export function isUsableTranscription(text: string): boolean {
  return text.trim().length >= 2;
}

export function withTranscriptionTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TranscriptionTimeoutError());
      onTimeout();
    }, timeoutMs);
  });

  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}
