import { useState } from 'react';
import { JarvisHud } from '../components/Jarvis/JarvisHud';
import {
  transition,
  type JarvisEvent,
  type JarvisState,
} from '../lib/jarvis/stateMachine';
import { jarvisStrings } from '../lib/jarvis/strings';

const states: JarvisState[] = [
  'idle',
  'listening',
  'hearing',
  'transcribing',
  'thinking',
  'speaking',
  'paused',
  'error',
];

const demoEventPaths: Record<JarvisState, JarvisEvent[]> = {
  idle: [],
  listening: [{ type: 'START_LISTENING' }],
  hearing: [{ type: 'START_LISTENING' }, { type: 'AUDIO_DETECTED' }],
  transcribing: [
    { type: 'START_LISTENING' },
    { type: 'AUDIO_DETECTED' },
    { type: 'TRANSCRIPTION_STARTED' },
  ],
  thinking: [
    { type: 'START_LISTENING' },
    { type: 'AUDIO_DETECTED' },
    { type: 'TRANSCRIPTION_STARTED' },
    { type: 'TRANSCRIPTION_COMPLETED' },
  ],
  speaking: [
    { type: 'START_LISTENING' },
    { type: 'AUDIO_DETECTED' },
    { type: 'TRANSCRIPTION_STARTED' },
    { type: 'TRANSCRIPTION_COMPLETED' },
    { type: 'RESPONSE_STARTED' },
  ],
  paused: [{ type: 'PAUSE' }],
  error: [{ type: 'FAIL' }],
};

export function JarvisPage() {
  const [state, setState] = useState<JarvisState>('idle');
  const [level, setLevel] = useState(0.5);

  const simulateState = (target: JarvisState) => {
    let next: JarvisState = state === 'error' ? transition(state, { type: 'RESET' }) : 'idle';
    for (const event of demoEventPaths[target]) {
      next = transition(next, event);
    }
    setState(next);
  };

  return (
    <section className="relative flex h-full min-h-0 w-full flex-col overflow-auto">
      <div className="jarvis-blueprint pointer-events-none absolute inset-0" aria-hidden="true" />

      <div className="relative z-[1] flex min-h-0 flex-1 flex-col items-center justify-center px-5 py-3">
        <JarvisHud state={state} level={level} reducedMotion={false} />
        <p
          className="mt-2 min-h-6 text-center text-sm tracking-wide"
          style={{ color: 'var(--color-text-secondary)' }}
          aria-live="polite"
          aria-atomic="true"
        >
          {jarvisStrings.status[state]}
        </p>
      </div>

      <footer className="relative z-[1] mx-auto flex w-full max-w-3xl flex-col gap-3 px-5 pb-4">
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="jarvis-fallback-input">
            {jarvisStrings.fallbackLabel}
          </label>
          <input
            id="jarvis-fallback-input"
            type="text"
            placeholder={jarvisStrings.fallbackPlaceholder}
            aria-label={jarvisStrings.fallbackLabel}
            className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-xs outline-none"
            style={{
              background: 'var(--color-bg-secondary)',
              borderColor: 'var(--color-border)',
              color: 'var(--color-text-secondary)',
            }}
          />
          <button
            type="button"
            disabled
            aria-label={state === 'paused' ? jarvisStrings.resume : jarvisStrings.pause}
            title={jarvisStrings.todoPause}
            className="rounded-lg border px-3 py-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
          >
            {state === 'paused' ? jarvisStrings.resume : jarvisStrings.pause}
          </button>
          <button
            type="button"
            disabled
            aria-label={jarvisStrings.settings}
            title={jarvisStrings.todoSettings}
            className="rounded-lg border px-3 py-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-secondary)' }}
          >
            {jarvisStrings.settings}
          </button>
        </div>

        <details className="jarvis-demo rounded-lg border" style={{ borderColor: 'var(--color-border)' }}>
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
            {jarvisStrings.demoTitle}
          </summary>
          <div className="flex flex-col gap-3 border-t px-3 py-3" style={{ borderColor: 'var(--color-border)' }}>
            <div className="flex flex-wrap gap-2">
              {states.map((demoState) => (
                <button
                  key={demoState}
                  type="button"
                  onClick={() => simulateState(demoState)}
                  aria-label={jarvisStrings.demoStateNames[demoState]}
                  aria-pressed={state === demoState}
                  className="rounded-md border px-2 py-1 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                  style={{
                    borderColor: state === demoState ? 'var(--color-accent)' : 'var(--color-border)',
                    color: state === demoState ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                    background: state === demoState ? 'var(--color-accent-subtle)' : 'transparent',
                  }}
                >
                  {jarvisStrings.states[demoState]}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-3 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              <span>{jarvisStrings.levelLabel}</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={level}
                onChange={(event) => setLevel(Number(event.currentTarget.value))}
                aria-label={jarvisStrings.levelLabel}
                className="min-w-0 flex-1 accent-[var(--color-accent)]"
              />
              <output className="w-16 text-right tabular-nums">
                {jarvisStrings.levelValue(level)}
              </output>
            </label>
          </div>
        </details>
      </footer>
    </section>
  );
}
