import { synthesizeSpeech } from '../api';
import { toSpeechText } from './speechText';

export type TtsEvent =
  | { type: 'start' }
  | { type: 'boundary' }
  | { type: 'end' }
  | { type: 'amplitude'; value: number };

export interface TtsAdapter {
  speak(text: string, options: { voiceId?: string; speed: number }): Promise<void>;
  cancel(): void;
  subscribe(listener: (event: TtsEvent) => void): () => void;
}

export type TtsAdapterKind = 'browser' | 'server';

export function getBrowserVoices(): SpeechSynthesisVoice[] {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
    ? window.speechSynthesis.getVoices().filter((voice) => voice.lang.toLowerCase().startsWith('pt-br'))
    : [];
}

function preferredVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  return (
    voices.find((voice) => /natural|online/i.test(voice.name)) ??
    voices.find((voice) => voice.lang.toLowerCase().startsWith('pt-br'))
  );
}

function createBrowserAdapter(): TtsAdapter {
  const listeners = new Set<(event: TtsEvent) => void>();
  let amplitudeTimer: ReturnType<typeof setInterval> | null = null;
  const emit = (event: TtsEvent) => listeners.forEach((listener) => listener(event));
  const stopAmplitude = () => {
    if (amplitudeTimer !== null) clearInterval(amplitudeTimer);
    amplitudeTimer = null;
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    speak: async (text, options) => {
      if (!('speechSynthesis' in window)) throw new Error('Este navegador não oferece síntese de voz.');
      const content = toSpeechText(text);
      if (!content) return;
      let voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) {
        await new Promise<void>((resolve) => {
          const timeout = window.setTimeout(resolve, 1200);
          const onVoicesChanged = () => {
            window.clearTimeout(timeout);
            window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
            resolve();
          };
          window.speechSynthesis.addEventListener('voiceschanged', onVoicesChanged, { once: true });
        });
        voices = window.speechSynthesis.getVoices();
      }

      const utterance = new SpeechSynthesisUtterance(content);
      const selected = voices.find((voice) => voice.voiceURI === options.voiceId || voice.name === options.voiceId);
      utterance.voice = selected ?? preferredVoice(voices) ?? null;
      utterance.lang = 'pt-BR';
      utterance.rate = Math.min(2, Math.max(0.5, options.speed));
      utterance.onstart = () => {
        emit({ type: 'start' });
        amplitudeTimer = setInterval(() => emit({ type: 'amplitude', value: 0.12 + Math.random() * 0.24 }), 90);
      };
      utterance.onboundary = () => emit({ type: 'boundary' });

      await new Promise<void>((resolve, reject) => {
        utterance.onend = () => {
          stopAmplitude();
          emit({ type: 'amplitude', value: 0 });
          emit({ type: 'end' });
          resolve();
        };
        utterance.onerror = (event) => {
          stopAmplitude();
          emit({ type: 'amplitude', value: 0 });
          if (event.error === 'canceled' || event.error === 'interrupted') resolve();
          else reject(new Error(`Falha na síntese de voz: ${event.error}`));
        };
        window.speechSynthesis.speak(utterance);
      });
    },
    cancel: () => {
      stopAmplitude();
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      emit({ type: 'amplitude', value: 0 });
      emit({ type: 'end' });
    },
  };
}

function createServerAdapter(): TtsAdapter {
  const listeners = new Set<(event: TtsEvent) => void>();
  let audio: HTMLAudioElement | null = null;
  let context: AudioContext | null = null;
  let source: MediaElementAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let objectUrl: string | null = null;
  let frame = 0;
  let synthesisController: AbortController | null = null;
  let rejectCurrent: ((error: Error) => void) | null = null;
  const emit = (event: TtsEvent) => listeners.forEach((listener) => listener(event));
  const cleanup = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.src = '';
      audio = null;
    }
    source?.disconnect();
    analyser?.disconnect();
    source = null;
    analyser = null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    if (context && context.state !== 'closed') void context.close();
    context = null;
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    speak: async (text, options) => {
      const content = toSpeechText(text);
      if (!content) return;
      const controller = new AbortController();
      synthesisController = controller;
      let blob: Blob;
      try {
        blob = await synthesizeSpeech(content, {
          voiceId: options.voiceId || undefined,
          speed: options.speed,
          signal: controller.signal,
        });
      } catch (error) {
        if (synthesisController === controller) synthesisController = null;
        throw error;
      }
      if (controller.signal.aborted) return;
      if (synthesisController === controller) synthesisController = null;
      objectUrl = URL.createObjectURL(blob);
      audio = new Audio(objectUrl);
      context = new AudioContext();
      void context.resume();
      analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source = context.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(context.destination);

      await new Promise<void>((resolve, reject) => {
        if (!audio || !analyser) return reject(new Error('Não foi possível preparar o áudio.'));
        rejectCurrent = reject;
        const data = new Uint8Array(analyser.frequencyBinCount);
        const measure = () => {
          if (!analyser) return;
          analyser.getByteTimeDomainData(data);
          let power = 0;
          for (const sample of data) power += (sample - 128) ** 2;
          emit({ type: 'amplitude', value: Math.min(1, Math.sqrt(power / data.length) / 42) });
          frame = requestAnimationFrame(measure);
        };
        audio.onended = () => {
          rejectCurrent = null;
          cleanup();
          emit({ type: 'amplitude', value: 0 });
          emit({ type: 'end' });
          resolve();
        };
        audio.onerror = () => {
          rejectCurrent = null;
          cleanup();
          emit({ type: 'amplitude', value: 0 });
          emit({ type: 'end' });
          reject(new Error('Falha ao reproduzir a voz do servidor.'));
        };
        void audio.play().then(() => {
          emit({ type: 'start' });
          measure();
        }).catch((error: unknown) => {
          rejectCurrent = null;
          cleanup();
          emit({ type: 'amplitude', value: 0 });
          emit({ type: 'end' });
          reject(error instanceof Error ? error : new Error('Não foi possível iniciar a reprodução.'));
        });
      });
    },
    cancel: () => {
      synthesisController?.abort();
      synthesisController = null;
      const reject = rejectCurrent;
      rejectCurrent = null;
      cleanup();
      emit({ type: 'amplitude', value: 0 });
      emit({ type: 'end' });
      reject?.(new DOMException('Reprodução interrompida.', 'AbortError'));
    },
  };
}

export function createTtsAdapter(kind: TtsAdapterKind): TtsAdapter {
  return kind === 'server' ? createServerAdapter() : createBrowserAdapter();
}

export class SpeechQueue {
  private items: string[] = [];
  private running = false;
  private activeText: string | null = null;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly adapter: TtsAdapter,
    private readonly options: () => { voiceId?: string; speed: number },
    private readonly onError: (error: Error) => void = () => undefined,
  ) {}

  enqueue(text: string): void {
    const normalized = toSpeechText(text);
    if (!normalized) return;
    this.items.push(normalized);
    void this.drain();
  }

  clear(): void {
    this.items = [];
    this.adapter.cancel();
    this.finishIfIdle();
  }

  get currentText(): string | null {
    return this.activeText;
  }

  park(): string[] {
    const pending = [
      ...(this.activeText ? [this.activeText] : []),
      ...this.items,
    ];
    this.items = [];
    this.adapter.cancel();
    this.finishIfIdle();
    return pending;
  }

  whenIdle(): Promise<void> {
    if (!this.running && this.items.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.items.length > 0) {
        const text = this.items.shift();
        if (!text) continue;
        this.activeText = text;
        try {
          await this.adapter.speak(text, this.options());
        } catch (caught) {
          if (caught instanceof DOMException && caught.name === 'AbortError') continue;
          this.onError(caught instanceof Error ? caught : new Error('Falha na síntese de voz.'));
        } finally {
          this.activeText = null;
        }
      }
    } finally {
      this.running = false;
      this.finishIfIdle();
      if (this.items.length > 0) void this.drain();
    }
  }

  private finishIfIdle(): void {
    if (this.running || this.items.length > 0) return;
    this.idleWaiters.splice(0).forEach((resolve) => resolve());
  }
}
