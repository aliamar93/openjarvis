import { describe, expect, it } from 'vitest';
import { EnergyVad, frameRms, pcmToWav } from './vad';

describe('Jarvis voice activity detection', () => {
  it('starts after sustained energy and ends after silence', () => {
    const vad = new EnergyVad();
    const events = [];
    for (let frame = 0; frame < 8; frame += 1) events.push(vad.process(0.08, 20));
    expect(events).toContain('speech-start');
    for (let frame = 0; frame < 10; frame += 1) vad.process(0.08, 20);

    let result = null;
    for (let frame = 0; frame < 45; frame += 1) result = vad.process(0.001, 20);
    expect(result).toBe('speech-end');
  });

  it('discards speech shorter than the minimum and computes frame energy', () => {
    const vad = new EnergyVad();
    for (let frame = 0; frame < 8; frame += 1) vad.process(0.08, 20);
    let result = null;
    for (let frame = 0; frame < 5; frame += 1) vad.process(0.08, 20);
    for (let frame = 0; frame < 45; frame += 1) result = vad.process(0.001, 20);
    expect(result).toBe('speech-discard');
    expect(frameRms(new Float32Array([1, -1]))).toBe(1);
  });

  it('caps one detected utterance at the configured maximum duration', () => {
    const vad = new EnergyVad();
    for (let frame = 0; frame < 8; frame += 1) vad.process(0.08, 20);
    let result = null;
    for (let frame = 0; frame < 1500; frame += 1) {
      const event = vad.process(0.08, 20);
      if (event) {
        result = event;
        break;
      }
    }
    expect(result).toBe('max-duration');
  });

  it('uses a stronger threshold during speaking to suppress acoustic echo', () => {
    const regular = new EnergyVad();
    const guarded = new EnergyVad();
    const regularEvents = [];
    const guardedEvents = [];
    for (let frame = 0; frame < 10; frame += 1) {
      regularEvents.push(regular.process(0.012, 20, { sensitivity: 0.5 }));
      guardedEvents.push(guarded.process(0.012, 20, {
        sensitivity: 0.15,
        startMs: 180,
        thresholdMultiplier: 1.8,
      }));
    }

    expect(regularEvents).toContain('speech-start');
    expect(guardedEvents).not.toContain('speech-start');
  });
});

describe('PCM WAV encoding', () => {
  it('writes mono 16 kHz, 16-bit PCM with consistent RIFF and data sizes', async () => {
    const blob = pcmToWav(new Float32Array([0, 0.5, -0.5, 1]), 16_000);
    const bytes = await blob.arrayBuffer();
    const view = new DataView(bytes);
    expect(blob.type).toBe('audio/wav');
    expect(bytes.byteLength).toBe(52);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe('WAVE');
    expect(view.getUint32(4, true)).toBe(44);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
  });

  it('resamples 48 kHz input to 16 kHz output', async () => {
    const blob = pcmToWav(new Float32Array(48), 48_000);
    const bytes = await blob.arrayBuffer();
    const view = new DataView(bytes);
    expect(bytes.byteLength).toBe(76);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true)).toBe(32);
  });

  it('rejects invalid input sample rates', () => {
    expect(() => pcmToWav(new Float32Array(), 0)).toThrow(RangeError);
  });
});
