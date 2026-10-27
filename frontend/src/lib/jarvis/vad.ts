export type VadEvent = 'speech-start' | 'speech-end' | 'speech-discard' | 'max-duration';

export interface VadOptions {
  sensitivity?: number;
  startMs?: number;
  silenceMs?: number;
  minimumSpeechMs?: number;
  maximumSpeechMs?: number;
}

export class EnergyVad {
  private noiseFloor = 0.004;
  private active = false;
  private aboveThresholdMs = 0;
  private silenceMs = 0;
  private speechDurationMs = 0;

  process(rms: number, frameMs: number, options: VadOptions = {}): VadEvent | null {
    const sensitivity = Math.min(1, Math.max(0, options.sensitivity ?? 0.5));
    const threshold = Math.max(0.002 + (1 - sensitivity) * 0.008, this.noiseFloor * (3.2 - sensitivity * 1.2));
    const voiced = Number.isFinite(rms) && rms >= threshold;

    if (!this.active) {
      this.noiseFloor = voiced
        ? this.noiseFloor * 0.995 + Math.min(rms, threshold) * 0.005
        : this.noiseFloor * 0.94 + rms * 0.06;
      this.aboveThresholdMs = voiced ? this.aboveThresholdMs + frameMs : 0;
      if (this.aboveThresholdMs >= (options.startMs ?? 150)) {
        this.active = true;
        this.speechDurationMs = this.aboveThresholdMs;
        this.silenceMs = 0;
        this.aboveThresholdMs = 0;
        return 'speech-start';
      }
      return null;
    }

    this.speechDurationMs += frameMs;
    this.silenceMs = voiced ? 0 : this.silenceMs + frameMs;
    if (this.speechDurationMs >= (options.maximumSpeechMs ?? 30_000)) {
      this.resetActivity();
      return 'max-duration';
    }
    if (this.silenceMs >= (options.silenceMs ?? 900)) {
      const duration = this.speechDurationMs - this.silenceMs;
      this.resetActivity();
      return duration >= (options.minimumSpeechMs ?? 300) ? 'speech-end' : 'speech-discard';
    }
    return null;
  }

  reset(): void {
    this.noiseFloor = 0.004;
    this.resetActivity();
  }

  private resetActivity(): void {
    this.active = false;
    this.aboveThresholdMs = 0;
    this.silenceMs = 0;
    this.speechDurationMs = 0;
  }
}

export function frameRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

export function pcmToWav(samples: Float32Array, sampleRate: number): Blob {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError('A taxa de amostragem do áudio precisa ser positiva.');
  }
  const targetRate = 16_000;
  const outputLength = samples.length === 0 ? 0 : Math.max(1, Math.round((samples.length * targetRate) / sampleRate));
  const buffer = new ArrayBuffer(44 + outputLength * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + outputLength * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, outputLength * 2, true);

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = (index * sampleRate) / targetRate;
    const left = Math.floor(sourceIndex);
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = sourceIndex - left;
    const sample = samples.length === 0 ? 0 : samples[left] * (1 - fraction) + samples[right] * fraction;
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
