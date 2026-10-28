import { frameRms, type EnergyVad, type VadEvent } from './vad';
import type { JarvisState } from './stateMachine';

export const SPEAKING_ECHO_GUARD_MS = 300;
export const SPEAKING_VAD_START_MS = 180;

export type AudioFrameDisposition =
  | 'sent-to-vad'
  | 'paused'
  | 'error'
  | 'interruption-disabled'
  | 'echo-window';

export interface AudioFrameResult {
  rms: number;
  threshold: number;
  disposition: AudioFrameDisposition;
  event: VadEvent | null;
  aboveThresholdMs: number;
}

export interface AudioFrameOptions {
  state: JarvisState;
  allowVoiceInterruption: boolean;
  sensitivity: number;
  elapsedSinceTtsStartMs: number;
}

export function shouldBlockAudioFrame(state: JarvisState, processing: boolean): boolean {
  return processing && state !== 'speaking' && state !== 'hearing';
}

export class AudioPreRollBuffer {
  private chunks: Float32Array[] = [];
  private samples = 0;

  get sampleCount(): number {
    return this.samples;
  }

  push(chunk: Float32Array, maximumSamples: number): void {
    const copy = chunk.slice();
    this.chunks.push(copy);
    this.samples += copy.length;
    while (this.samples > maximumSamples && this.chunks.length > 0) {
      const removed = this.chunks.shift();
      if (removed) this.samples -= removed.length;
    }
  }

  snapshot(): Float32Array[] {
    return this.chunks.map((chunk) => chunk.slice());
  }

  hasAboveThreshold(threshold: number): boolean {
    return this.chunks.some((chunk) => frameRms(chunk) >= threshold);
  }

  clear(): void {
    this.chunks = [];
    this.samples = 0;
  }
}

export function processAudioFrame(
  vad: EnergyVad,
  samples: Float32Array,
  sampleRate: number,
  options: AudioFrameOptions,
): AudioFrameResult {
  const rms = frameRms(samples);
  const frameMs = (samples.length / sampleRate) * 1000;
  const speaking = options.state === 'speaking';
  const threshold = speaking
    ? vad.speakingThresholdFor(options.sensitivity)
    : vad.thresholdFor(options.sensitivity);
  const result = (
    disposition: AudioFrameDisposition,
    event: VadEvent | null = null,
  ): AudioFrameResult => ({
    rms,
    threshold,
    disposition,
    event,
    aboveThresholdMs: vad.diagnostics.aboveThresholdMs,
  });

  if (options.state === 'paused') return result('paused');
  if (options.state === 'error') return result('error');
  if (speaking && !options.allowVoiceInterruption) return result('interruption-disabled');
  if (speaking && options.elapsedSinceTtsStartMs < SPEAKING_ECHO_GUARD_MS) {
    return result('echo-window');
  }

  const event = vad.process(rms, frameMs, {
    sensitivity: options.sensitivity,
    startMs: speaking ? SPEAKING_VAD_START_MS : undefined,
    thresholdOverride: threshold,
    maximumSpeechMs: 29_700,
  });
  return result('sent-to-vad', event);
}
