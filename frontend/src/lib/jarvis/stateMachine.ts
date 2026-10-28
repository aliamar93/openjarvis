export type JarvisState =
  | 'idle'
  | 'listening'
  | 'hearing'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'paused'
  | 'error';

export type JarvisEvent =
  | { type: 'START_LISTENING' }
  | { type: 'AUDIO_DETECTED' }
  | { type: 'STOP_LISTENING' }
  | { type: 'TRANSCRIPTION_STARTED' }
  | { type: 'TRANSCRIPTION_COMPLETED' }
  | { type: 'RESPONSE_STARTED' }
  | { type: 'RESPONSE_COMPLETED' }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'FAIL' }
  | { type: 'RESET' };

export type JarvisEventType = JarvisEvent['type'];

export const VALID_TRANSITIONS: Record<
  JarvisState,
  Partial<Record<JarvisEventType, JarvisState>>
> = {
  idle: {
    START_LISTENING: 'listening',
    AUDIO_DETECTED: 'hearing',
    TRANSCRIPTION_STARTED: 'transcribing',
    PAUSE: 'paused',
    FAIL: 'error',
  },
  listening: {
    AUDIO_DETECTED: 'hearing',
    RESPONSE_STARTED: 'speaking',
    STOP_LISTENING: 'idle',
    TRANSCRIPTION_STARTED: 'transcribing',
    PAUSE: 'paused',
    FAIL: 'error',
  },
  hearing: {
    RESPONSE_STARTED: 'speaking',
    STOP_LISTENING: 'idle',
    TRANSCRIPTION_STARTED: 'transcribing',
    PAUSE: 'paused',
    FAIL: 'error',
  },
  transcribing: {
    TRANSCRIPTION_COMPLETED: 'thinking',
    PAUSE: 'paused',
    STOP_LISTENING: 'idle',
    FAIL: 'error',
  },
  thinking: {
    RESPONSE_STARTED: 'speaking',
    RESPONSE_COMPLETED: 'idle',
    PAUSE: 'paused',
    STOP_LISTENING: 'idle',
    FAIL: 'error',
  },
  speaking: {
    AUDIO_DETECTED: 'hearing',
    RESPONSE_COMPLETED: 'idle',
    PAUSE: 'paused',
    STOP_LISTENING: 'idle',
    FAIL: 'error',
  },
  paused: {
    RESUME: 'idle',
    STOP_LISTENING: 'idle',
    FAIL: 'error',
  },
  error: {
    RESET: 'idle',
    STOP_LISTENING: 'idle',
  },
};

export function transition(state: JarvisState, event: JarvisEvent): JarvisState {
  return VALID_TRANSITIONS[state][event.type] ?? state;
}
