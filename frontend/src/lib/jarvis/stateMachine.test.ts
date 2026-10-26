import { describe, expect, it } from 'vitest';
import { transition, VALID_TRANSITIONS, type JarvisEvent, type JarvisState } from './stateMachine';

describe('Jarvis state machine', () => {
  it('applies every declared transition', () => {
    for (const [state, transitions] of Object.entries(VALID_TRANSITIONS) as [
      JarvisState,
      Partial<Record<JarvisEvent['type'], JarvisState>>,
    ][]) {
      for (const [type, nextState] of Object.entries(transitions) as [
        JarvisEvent['type'],
        JarvisState,
      ][]) {
        expect(transition(state, { type } as JarvisEvent)).toBe(nextState);
      }
    }
  });

  it('keeps the current state when an event is not valid there', () => {
    expect(transition('idle', { type: 'RESPONSE_STARTED' })).toBe('idle');
    expect(transition('paused', { type: 'START_LISTENING' })).toBe('paused');
    expect(transition('error', { type: 'RESUME' })).toBe('error');
  });

  it('can reset an error and complete a listening-to-speaking cycle', () => {
    const events: JarvisEvent[] = [
      { type: 'FAIL' },
      { type: 'RESET' },
      { type: 'START_LISTENING' },
      { type: 'AUDIO_DETECTED' },
      { type: 'TRANSCRIPTION_STARTED' },
      { type: 'TRANSCRIPTION_COMPLETED' },
      { type: 'RESPONSE_STARTED' },
      { type: 'RESPONSE_COMPLETED' },
    ];

    const finalState = events.reduce(transition, 'idle' as JarvisState);
    expect(finalState).toBe('idle');
  });
});
