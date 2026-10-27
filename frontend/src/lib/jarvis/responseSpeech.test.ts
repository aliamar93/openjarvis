import { describe, expect, it, vi } from 'vitest';
import {
  getFinalResponseSpeech,
  JarvisResponseSpeaker,
  getRepetitionCount,
} from './responseSpeech';
import { SpeechQueue, type TtsAdapter, type TtsEvent } from './ttsAdapters';

function createSpeaker() {
  const spoken: string[] = [];
  const listeners = new Set<(event: TtsEvent) => void>();
  const adapter: TtsAdapter = {
    speak: vi.fn(async (text: string) => {
      spoken.push(text);
    }),
    cancel: vi.fn(),
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  const queue = new SpeechQueue(adapter, () => ({ speed: 1 }));
  return { speaker: new JarvisResponseSpeaker(queue), queue, adapter, spoken };
}

describe('Jarvis response speech', () => {
  it('does not re-enqueue the full response when all sentences streamed already', () => {
    expect(getFinalResponseSpeech('Resposta única.', '')).toBe('');
    expect(getFinalResponseSpeech('Primeira. Segunda.', '')).toBe('');
    expect(getFinalResponseSpeech('Primeira.', 'Segunda sem pontuação'))
      .toBe('Segunda sem pontuação');
    expect(getFinalResponseSpeech('', '')).toBe('Não consegui gerar uma resposta.');
  });

  it('speaks each streamed sentence once and ignores a duplicate utterance id', async () => {
    const { speaker, queue, spoken } = createSpeaker();

    expect(speaker.speakResponse('Primeira frase.', 'response-1', 'response-1:0')).toBe(true);
    expect(speaker.speakResponse('Primeira frase.', 'response-1', 'response-1:0')).toBe(false);
    expect(speaker.speakResponse('Segunda frase.', 'response-1', 'response-1:1')).toBe(true);

    await queue.whenIdle();
    expect(spoken).toEqual(['Primeira frase.', 'Segunda frase.']);
  });

  it('cancels speech from a previous response before starting a new one', async () => {
    const spoken: string[] = [];
    let activeCount = 0;
    let maxActiveCount = 0;
    const controls: {
      cancelActive?: () => void;
      startNewSpeech?: () => void;
      finishNewSpeech?: () => void;
    } = {};
    const adapter: TtsAdapter = {
      speak: vi.fn((text) => new Promise<void>((resolve) => {
        activeCount += 1;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        let cancelled = false;
        const finish = () => {
          activeCount -= 1;
          if (!cancelled) spoken.push(text);
          resolve();
        };
        if (text === 'Resposta anterior.') {
          controls.cancelActive = () => {
            cancelled = true;
            finish();
          };
        } else {
          controls.startNewSpeech?.();
          controls.finishNewSpeech = finish;
        }
      })),
      cancel: vi.fn(() => controls.cancelActive?.()),
      subscribe: vi.fn(() => () => undefined),
    };
    const queue = new SpeechQueue(adapter, () => ({ speed: 1 }));
    const speaker = new JarvisResponseSpeaker(queue);
    const newSpeechStarted = new Promise<void>((resolve) => {
      controls.startNewSpeech = resolve;
    });

    speaker.speakResponse('Resposta anterior.', 'response-1');
    speaker.speakResponse('Nova resposta.', 'response-2');
    await newSpeechStarted;
    controls.finishNewSpeech?.();
    await queue.whenIdle();

    expect(adapter.cancel).toHaveBeenCalledTimes(2);
    expect(maxActiveCount).toBe(1);
    expect(spoken).toEqual(['Nova resposta.']);
  });

  it('replays the last completed response the requested number of times', async () => {
    const { speaker, queue, spoken } = createSpeaker();

    speaker.speakResponse('Resposta original.', 'response-1');
    await queue.whenIdle();
    speaker.completeResponse('response-1', 'Resposta original.');

    expect(speaker.repeatLastResponse('repeat-1', 2)).toBe('Resposta original.');
    await queue.whenIdle();
    speaker.completeResponse('repeat-1', 'Resposta original.');

    expect(spoken).toEqual([
      'Resposta original.',
      'Resposta original.',
      'Resposta original.',
    ]);
  });

  it('speaks three consecutive responses once each', async () => {
    const { speaker, queue, spoken } = createSpeaker();

    for (let index = 1; index <= 3; index += 1) {
      const responseId = `response-${index}`;
      const response = `Resposta ${index}.`;
      speaker.speakResponse(response, responseId);
      await queue.whenIdle();
      speaker.completeResponse(responseId, response);
    }

    expect(spoken).toEqual(['Resposta 1.', 'Resposta 2.', 'Resposta 3.']);
  });

  it('does not replay a response that has not been completed', () => {
    const { speaker } = createSpeaker();

    expect(speaker.repeatLastResponse('repeat-1', 1)).toBeNull();
  });
});

describe('getRepetitionCount', () => {
  it.each([
    ['repita', 1],
    ['repete isso', 1],
    ['fala de novo', 1],
    ['diga novamente', 1],
    ['não entendi, repete', 1],
    ['pode repetir?', 1],
    ['repita 2 vezes', 2],
    ['pode repetir 2 vezes, por favor', 2],
    ['repete três vezes', 3],
    ['repita 20 vezes', 10],
  ])('recognizes %s', (text, expected) => {
    expect(getRepetitionCount(text)).toBe(expected);
  });

  it('does not treat unrelated or negated requests as a replay command', () => {
    expect(getRepetitionCount('O que significa repetir?')).toBeNull();
    expect(getRepetitionCount('Não repita isso')).toBeNull();
  });
});
