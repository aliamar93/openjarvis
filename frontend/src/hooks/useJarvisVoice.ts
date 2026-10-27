import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { transcribeAudio } from '../lib/api';
import { streamChat } from '../lib/sse';
import { useAppStore } from '../lib/store';
import { useTtsStore } from '../lib/tts';
import type { ChatMessage } from '../types';
import { jarvisStrings } from '../lib/jarvis/strings';
import { EnergyVad, frameRms, pcmToWav } from '../lib/jarvis/vad';
import { removeActivationWord, takeCompleteSentences, toSpeechText } from '../lib/jarvis/speechText';
import {
  isUsableTranscription,
  TRANSCRIPTION_TIMEOUT_MS,
  TranscriptionTimeoutError,
  withTranscriptionTimeout,
} from '../lib/jarvis/transcription';
import {
  getFinalResponseSpeech,
  getRepetitionCount,
  JarvisResponseSpeaker,
} from '../lib/jarvis/responseSpeech';
import {
  createTtsAdapter,
  SpeechQueue,
  type TtsAdapter,
  type TtsAdapterKind,
} from '../lib/jarvis/ttsAdapters';
import { transition, type JarvisEvent, type JarvisState } from '../lib/jarvis/stateMachine';

export const JARVIS_VOICE_KEY = 'openjarvis-jarvis-voice';

export interface JarvisVoicePreferences {
  adapter: TtsAdapterKind;
  voiceId: string;
  speed: number;
  sensitivity: number;
  captions: boolean;
  wakeWord: boolean;
  autoStart: boolean;
  pauseWhenHidden: boolean;
  thinkingTimeoutSec: number;
}

interface LoadedVoicePreferences {
  preferences: JarvisVoicePreferences;
  error: string | null;
}

const DEFAULT_PREFERENCES: JarvisVoicePreferences = {
  adapter: 'browser',
  voiceId: '',
  speed: 1,
  sensitivity: 0.5,
  captions: false,
  wakeWord: false,
  autoStart: false,
  pauseWhenHidden: true,
  thinkingTimeoutSec: 120,
};

interface CaptureResources {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: AudioWorkletNode | ScriptProcessorNode;
  silentGain: GainNode;
}

function loadPreferences(): LoadedVoicePreferences {
  if (typeof window === 'undefined') return { preferences: DEFAULT_PREFERENCES, error: null };
  try {
    const raw = window.localStorage.getItem(JARVIS_VOICE_KEY);
    if (!raw) return { preferences: DEFAULT_PREFERENCES, error: null };
    const parsed = JSON.parse(raw) as Partial<JarvisVoicePreferences>;
    return {
      preferences: {
        ...DEFAULT_PREFERENCES,
        ...parsed,
        adapter: parsed.adapter === 'server' ? 'server' : 'browser',
        speed: Math.min(2, Math.max(0.5, Number(parsed.speed) || 1)),
        sensitivity: Number.isFinite(Number(parsed.sensitivity))
          ? Math.min(1, Math.max(0, Number(parsed.sensitivity)))
          : 0.5,
        thinkingTimeoutSec: Math.min(900, Math.max(10, Number(parsed.thinkingTimeoutSec) || 120)),
      },
      error: null,
    };
  } catch {
    return {
      preferences: DEFAULT_PREFERENCES,
      error: 'Não foi possível carregar as preferências de voz; os valores padrão serão usados.',
    };
  }
}

function createId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function concatenate(chunks: Float32Array[]): Float32Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function makeAudioProcessor(context: AudioContext): Promise<AudioWorkletNode | ScriptProcessorNode> {
  const worklet = context.audioWorklet;
  if (worklet && typeof AudioWorkletNode !== 'undefined') {
    return Promise.resolve()
      .then(() => worklet.addModule(new URL('/jarvis-capture-worklet.js', window.location.href)))
      .then(() => new AudioWorkletNode(context, 'jarvis-capture'))
      .catch(() => context.createScriptProcessor(2048, 1, 1));
  }
  return Promise.resolve(context.createScriptProcessor(2048, 1, 1));
}

function releaseCaptureResources(capture: CaptureResources): void {
  if ('port' in capture.processor) {
    capture.processor.port.onmessage = null;
  } else {
    capture.processor.onaudioprocess = null;
  }
  capture.processor.disconnect();
  capture.source.disconnect();
  capture.silentGain.disconnect();
  capture.stream.getTracks().forEach((track) => track.stop());
  if (capture.context.state !== 'closed') void capture.context.close();
}

export interface JarvisVoiceController {
  state: JarvisState;
  level: number;
  amplitude: MutableRefObject<number>;
  start: () => Promise<void>;
  pause: () => void;
  resume: () => Promise<void>;
  stop: () => void;
  sendText: (text: string) => Promise<void>;
  interrupt: () => void;
  error: string | null;
  preferences: JarvisVoicePreferences;
  updatePreferences: (updates: Partial<JarvisVoicePreferences>) => void;
  lastTranscript: string;
  microphoneActive: boolean;
  activated: boolean;
}

export function useJarvisVoice(): JarvisVoiceController {
  const [state, setState] = useState<JarvisState>('idle');
  const stateRef = useRef<JarvisState>('idle');
  const [level, setLevel] = useState(0);
  const lastLevelUpdateRef = useRef(0);
  const amplitude = useRef(0);
  const [loadedPreferences] = useState(loadPreferences);
  const [error, setError] = useState<string | null>(loadedPreferences.error);
  const [preferences, setPreferences] = useState(loadedPreferences.preferences);
  const preferencesRef = useRef(preferences);
  const [microphoneActive, setMicrophoneActive] = useState(false);
  const [activated, setActivated] = useState(false);
  const [lastTranscript, setLastTranscript] = useState('');

  const captureRef = useRef<CaptureResources | null>(null);
  const preRollRef = useRef<Float32Array[]>([]);
  const preRollSamplesRef = useRef(0);
  const segmentRef = useRef<Float32Array[] | null>(null);
  const vadRef = useRef(new EnergyVad());
  const processingRef = useRef(false);
  const failuresRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);
  const activeTranscriptionRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const adapterRef = useRef<TtsAdapter | null>(null);
  const queueRef = useRef<SpeechQueue | null>(null);
  const responseSpeakerRef = useRef<JarvisResponseSpeaker | null>(null);
  const conversationRef = useRef<string | null>(null);
  const processChunkRef = useRef<(chunk: Float32Array) => void>(() => undefined);
  const startRef = useRef<() => Promise<void>>(async () => undefined);
  const startTokenRef = useRef(0);
  const startPendingRef = useRef(false);
  const pauseWhenHiddenRef = useRef(false);
  const hiddenPauseRef = useRef(false);

  preferencesRef.current = preferences;

  const move = useCallback((event: JarvisEvent) => {
    const next = transition(stateRef.current, event);
    stateRef.current = next;
    setState(next);
  }, []);

  const setAmplitude = useCallback((value: number) => {
    const safe = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    amplitude.current = safe;
    const now = Date.now();
    if (now - lastLevelUpdateRef.current >= 150) {
      lastLevelUpdateRef.current = now;
      setLevel(safe);
    }
  }, []);

  const setFailure = useCallback((message: string) => {
    setError(message);
    responseSpeakerRef.current?.cancel();
    processingRef.current = false;
    move({ type: 'FAIL' });
    failuresRef.current += 1;
    if (errorTimerRef.current !== null) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => {
      if (stateRef.current !== 'error') return;
      move({ type: 'RESET' });
      if (failuresRef.current < 3) {
        if (captureRef.current) move({ type: 'START_LISTENING' });
      } else {
        const capture = captureRef.current;
        captureRef.current = null;
        setMicrophoneActive(false);
        if (capture) releaseCaptureResources(capture);
        move({ type: 'PAUSE' });
      }
    }, 1400);
  }, [move]);

  const updatePreferences = useCallback((updates: Partial<JarvisVoicePreferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...updates };
      preferencesRef.current = next;
      try {
        localStorage.setItem(JARVIS_VOICE_KEY, JSON.stringify(next));
        setError(null);
      } catch {
        setError('Não foi possível salvar as preferências de voz neste navegador.');
      }
      return next;
    });
  }, []);

  const teardownCapture = useCallback(() => {
    const capture = captureRef.current;
    captureRef.current = null;
    setMicrophoneActive(false);
    if (!capture) return;
    releaseCaptureResources(capture);
  }, []);

  const finishListeningDelay = useCallback(() => {
    if (resumeTimerRef.current !== null) clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = setTimeout(() => {
      if (stateRef.current === 'speaking') move({ type: 'RESPONSE_COMPLETED' });
      if (stateRef.current === 'thinking') move({ type: 'RESPONSE_COMPLETED' });
      if (stateRef.current === 'idle' && captureRef.current) move({ type: 'START_LISTENING' });
      processingRef.current = false;
      vadRef.current.reset();
      segmentRef.current = null;
      preRollRef.current = [];
      preRollSamplesRef.current = 0;
    }, 300);
  }, [move]);

  const runChat = useCallback(async (text: string, requestId: number) => {
    const model = useAppStore.getState().selectedModel;
    if (!model) throw new Error('Escolha um modelo na tela de chat antes de conversar por voz.');

    const store = useAppStore.getState();
    let conversationId = conversationRef.current;
    if (!conversationId || !store.conversations.some((conversation) => conversation.id === conversationId)) {
      conversationId = store.createConversation(model, 'J.A.R.V.I.S (voz)');
    }
    conversationRef.current = conversationId;
    const userMessage: ChatMessage = {
      id: createId(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    store.addMessage(conversationId, userMessage);
    const history = useAppStore.getState().conversations
      .find((conversation) => conversation.id === conversationId)?.messages.slice(-12).map((message) => ({
        role: message.role,
        content: message.content,
      })) ?? [];
    const assistant: ChatMessage = {
      id: createId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };
    useAppStore.getState().addMessage(conversationId, assistant);

    const current = useAppStore.getState();
    const controller = new AbortController();
    activeControllerRef.current = controller;
    let timedOut = false;
    timeoutRef.current = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, preferencesRef.current.thinkingTimeoutSec * 1000);

    processingRef.current = true;
    move({ type: 'TRANSCRIPTION_COMPLETED' });
    setError(null);
    const messages = [
      { role: 'system', content: jarvisStrings.systemPrompt },
      ...history,
    ];
    const temperature = current.settings.temperature;
    const maxTokens = Math.min(current.settings.maxTokens, 512);
    let response = '';
    let pendingSpeech = '';
    const responseId = createId();
    let utteranceIndex = 0;
    let queuedSpeech = false;
    const speakResponse = (text: string) => {
      const utteranceId = `${responseId}:${utteranceIndex}`;
      utteranceIndex += 1;
      if (responseSpeakerRef.current?.speakResponse(text, responseId, utteranceId)) {
        queuedSpeech = true;
      }
    };

    try {
      for await (const event of streamChat({
        model,
        messages,
        stream: true,
        temperature,
        max_tokens: maxTokens,
      }, controller.signal)) {
        if (requestId !== requestIdRef.current) return;
        if (event.event === 'error') throw new Error('O chat não conseguiu responder.');
        const payload = JSON.parse(event.data) as {
          choices?: Array<{ delta?: { content?: string | Array<{ text?: string }> } }>;
        };
        const content = payload.choices?.[0]?.delta?.content;
        const delta = typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map((part) => part.text ?? '').join('')
            : '';
        if (!delta) continue;
        response += delta;
        pendingSpeech += delta;
        const complete = takeCompleteSentences(pendingSpeech);
        pendingSpeech = complete.remainder;
        for (const sentence of complete.sentences) speakResponse(sentence);
        useAppStore.getState().updateLastAssistant(conversationId, response);
      }

      if (requestId !== requestIdRef.current) return;
      const finalContent = response || 'Não consegui gerar uma resposta.';
      const finalSpeech = getFinalResponseSpeech(response, pendingSpeech);
      if (finalSpeech) speakResponse(toSpeechText(finalSpeech));
      useAppStore.getState().updateLastAssistant(conversationId, finalContent);
      await queueRef.current?.whenIdle();
      if (queuedSpeech) responseSpeakerRef.current?.completeResponse(responseId, finalContent);
      failuresRef.current = 0;
      setError(null);
      finishListeningDelay();
    } catch (caught) {
      if (requestId !== requestIdRef.current) return;
      if (controller.signal.aborted && !timedOut) {
        finishListeningDelay();
        return;
      }
      throw new Error(timedOut
        ? 'O modelo demorou demais para responder. Tente novamente.'
        : caught instanceof Error && /failed to fetch|fetch failed|networkerror|network request failed|(?:502|503|504)/i.test(caught.message)
          ? 'Não foi possível conectar ao servidor. Verifique se o backend está ativo.'
          : 'Falha ao conversar com o modelo. Tente novamente.');
    } finally {
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      if (activeControllerRef.current === controller) activeControllerRef.current = null;
    }
  }, [finishListeningDelay, move]);

  const processTranscript = useCallback(async (transcript: string, fromSpeech = true) => {
    let text = transcript.trim();
    if (fromSpeech && preferencesRef.current.wakeWord) {
      const activatedText = removeActivationWord(text);
      if (activatedText === null) {
        processingRef.current = false;
        move({ type: 'STOP_LISTENING' });
        finishListeningDelay();
        return;
      }
      text = activatedText;
    }
    if (text.length < 2) {
      processingRef.current = false;
      move({ type: 'STOP_LISTENING' });
      finishListeningDelay();
      return;
    }
    if (fromSpeech && preferencesRef.current.captions) setLastTranscript(transcript);
    const repetitionCount = getRepetitionCount(text);
    if (repetitionCount !== null) {
      const speaker = responseSpeakerRef.current;
      if (!speaker) {
        setFailure('Ainda não há uma resposta para repetir.');
        return;
      }
      move({ type: 'TRANSCRIPTION_COMPLETED' });
      const responseId = createId();
      const repeatedText = speaker.repeatLastResponse(responseId, repetitionCount);
      if (!repeatedText) {
        setFailure('Ainda não há uma resposta para repetir.');
        return;
      }
      await queueRef.current?.whenIdle();
      speaker.completeResponse(responseId, repeatedText);
      failuresRef.current = 0;
      setError(null);
      finishListeningDelay();
      return;
    }
    const requestId = ++requestIdRef.current;
    try {
      await runChat(text, requestId);
    } catch (caught) {
      if (requestId !== requestIdRef.current) return;
      setFailure(caught instanceof Error ? caught.message : 'Falha no processamento da fala.');
    }
  }, [finishListeningDelay, move, runChat, setFailure]);

  const processAudioChunk = useCallback((chunk: Float32Array) => {
    if (!captureRef.current) {
      setAmplitude(0);
      return;
    }
    if (processingRef.current || stateRef.current === 'paused' || stateRef.current === 'error') return;
    const sampleRate = captureRef.current.context.sampleRate;
    const frameMs = (chunk.length / sampleRate) * 1000;
    const rms = frameRms(chunk);
    setAmplitude(rms * 5);

    if (!segmentRef.current) {
      const copy = chunk.slice();
      preRollRef.current.push(copy);
      preRollSamplesRef.current += copy.length;
      const maxSamples = Math.round(sampleRate * 0.3);
      while (preRollSamplesRef.current > maxSamples && preRollRef.current.length > 0) {
        const removed = preRollRef.current.shift();
        if (removed) preRollSamplesRef.current -= removed.length;
      }
    } else {
      segmentRef.current.push(chunk.slice());
    }

    const event = vadRef.current.process(rms, frameMs, {
      sensitivity: preferencesRef.current.sensitivity,
      maximumSpeechMs: 29_700,
    });
    if (event === 'speech-start') {
      segmentRef.current = preRollRef.current.map((buffer) => buffer.slice());
      preRollRef.current = [];
      preRollSamplesRef.current = 0;
      move({ type: 'AUDIO_DETECTED' });
    } else if (event === 'speech-end' || event === 'max-duration') {
      const recorded = segmentRef.current;
      segmentRef.current = null;
      if (!recorded?.length) {
        move({ type: 'STOP_LISTENING' });
        move({ type: 'START_LISTENING' });
        return;
      }
      move({ type: 'TRANSCRIPTION_STARTED' });
      processingRef.current = true;
      setAmplitude(0);
      const wav = pcmToWav(concatenate(recorded), sampleRate);
      const transcriptionId = ++requestIdRef.current;
      const transcriptionController = new AbortController();
      activeTranscriptionRef.current = transcriptionController;
      const transcription = withTranscriptionTimeout(
        transcribeAudio(wav, 'speech.wav', 'pt', transcriptionController.signal),
        TRANSCRIPTION_TIMEOUT_MS,
        () => transcriptionController.abort(),
      );
      void transcription
        .then((result) => {
          if (requestIdRef.current === transcriptionId && stateRef.current === 'transcribing') {
            const transcript = result.text;
            if (!isUsableTranscription(transcript)) {
              processingRef.current = false;
              move({ type: 'STOP_LISTENING' });
              finishListeningDelay();
              return;
            }
            void processTranscript(transcript.trim());
          }
        })
        .catch((caught: unknown) => {
          if (requestIdRef.current !== transcriptionId) return;
          setFailure(caught instanceof TranscriptionTimeoutError
            ? 'A transcrição demorou mais que o esperado. Tente novamente.'
            : caught instanceof Error && /failed to fetch|fetch failed|networkerror|network request failed|(?:502|503|504)/i.test(caught.message)
              ? 'Não foi possível conectar ao serviço de transcrição.'
              : 'Não consegui transcrever o áudio. Tente falar novamente.');
        })
        .finally(() => {
          if (activeTranscriptionRef.current === transcriptionController) {
            activeTranscriptionRef.current = null;
          }
        });
    } else if (event === 'speech-discard') {
      segmentRef.current = null;
      if (stateRef.current === 'hearing') move({ type: 'STOP_LISTENING' });
      if (stateRef.current === 'idle' && captureRef.current) move({ type: 'START_LISTENING' });
    }
  }, [finishListeningDelay, move, processTranscript, setAmplitude, setFailure]);

  processChunkRef.current = processAudioChunk;

  const start = useCallback(async () => {
    if (captureRef.current || startPendingRef.current) return;
    if (errorTimerRef.current !== null) clearTimeout(errorTimerRef.current);
    setError(null);
    const startToken = ++startTokenRef.current;
    startPendingRef.current = true;
    let pendingStream: MediaStream | null = null;
    let pendingContext: AudioContext | null = null;
    let pendingSource: MediaStreamAudioSourceNode | null = null;
    let pendingProcessor: AudioWorkletNode | ScriptProcessorNode | null = null;
    let pendingGain: GainNode | null = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Este navegador não oferece captura de microfone.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      pendingStream = stream;
      if (startToken !== startTokenRef.current) return;
      const context = new AudioContext();
      pendingContext = context;
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      pendingSource = source;
      const processor = await makeAudioProcessor(context);
      pendingProcessor = processor;
      const silentGain = context.createGain();
      pendingGain = silentGain;
      silentGain.gain.value = 0;
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(context.destination);

      if ('port' in processor) {
        processor.port.onmessage = (event: MessageEvent<Float32Array>) => processChunkRef.current(event.data);
      } else {
        processor.onaudioprocess = (event: AudioProcessingEvent) => {
          processChunkRef.current(event.inputBuffer.getChannelData(0));
        };
      }
      captureRef.current = { stream, context, source, processor, silentGain };
      pendingStream = null;
      pendingContext = null;
      pendingSource = null;
      pendingProcessor = null;
      pendingGain = null;
      setMicrophoneActive(true);
      setActivated(true);
      failuresRef.current = 0;
      vadRef.current.reset();
      if (stateRef.current === 'error') move({ type: 'RESET' });
      if (stateRef.current === 'paused') move({ type: 'RESUME' });
      move({ type: 'START_LISTENING' });
    } catch (caught) {
      if (startToken !== startTokenRef.current) return;
      const permissionError = caught instanceof Error && caught.name === 'NotAllowedError';
      setFailure(permissionError
        ? 'Permita o acesso ao microfone e toque em Ativar escuta para iniciar.'
        : caught instanceof Error && /network|load|csp|security/i.test(caught.message)
          ? 'Não foi possível iniciar o áudio. Verifique as permissões do navegador.'
          : 'Não foi possível ativar o microfone. Verifique as permissões do navegador.');
    } finally {
      if (pendingProcessor) pendingProcessor.disconnect();
      if (pendingSource) pendingSource.disconnect();
      if (pendingGain) pendingGain.disconnect();
      pendingStream?.getTracks().forEach((track) => track.stop());
      if (pendingContext && pendingContext.state !== 'closed') void pendingContext.close();
      if (startToken === startTokenRef.current) startPendingRef.current = false;
    }
  }, [move, setFailure]);

  startRef.current = start;

  const pause = useCallback(() => {
    startTokenRef.current += 1;
    startPendingRef.current = false;
    requestIdRef.current += 1;
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
    activeTranscriptionRef.current?.abort();
    activeTranscriptionRef.current = null;
    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    responseSpeakerRef.current?.cancel();
    processingRef.current = false;
    segmentRef.current = null;
    teardownCapture();
    move({ type: 'PAUSE' });
  }, [move, teardownCapture]);

  const resume = useCallback(async () => {
    if (stateRef.current === 'paused' || stateRef.current === 'idle') {
      if (stateRef.current === 'paused') move({ type: 'RESUME' });
      await start();
    }
  }, [move, start]);

  const stop = useCallback(() => {
    startTokenRef.current += 1;
    startPendingRef.current = false;
    requestIdRef.current += 1;
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
    activeTranscriptionRef.current?.abort();
    activeTranscriptionRef.current = null;
    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    responseSpeakerRef.current?.cancel();
    processingRef.current = false;
    segmentRef.current = null;
    teardownCapture();
    setActivated(false);
    if (errorTimerRef.current !== null) clearTimeout(errorTimerRef.current);
    move({ type: 'STOP_LISTENING' });
    setAmplitude(0);
  }, [move, setAmplitude, teardownCapture]);

  const interrupt = useCallback(() => {
    startTokenRef.current += 1;
    startPendingRef.current = false;
    requestIdRef.current += 1;
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
    activeTranscriptionRef.current?.abort();
    activeTranscriptionRef.current = null;
    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    responseSpeakerRef.current?.cancel();
    segmentRef.current = null;
    setAmplitude(0);
    if (stateRef.current === 'speaking') move({ type: 'RESPONSE_COMPLETED' });
    if (stateRef.current === 'thinking' || stateRef.current === 'hearing' || stateRef.current === 'transcribing') {
      move({ type: 'STOP_LISTENING' });
    }
    if (captureRef.current) {
      processingRef.current = true;
      finishListeningDelay();
    } else {
      processingRef.current = false;
    }
  }, [finishListeningDelay, move, setAmplitude]);

  const sendText = useCallback(async (text: string) => {
    const content = text.trim();
    if (!content || processingRef.current) return;
    processingRef.current = true;
    if (stateRef.current === 'error') move({ type: 'RESET' });
    if (stateRef.current === 'paused') move({ type: 'RESUME' });
    if (stateRef.current === 'idle') move({ type: 'START_LISTENING' });
    if (stateRef.current === 'hearing') move({ type: 'TRANSCRIPTION_STARTED' });
    if (stateRef.current === 'listening') move({ type: 'TRANSCRIPTION_STARTED' });
    try {
      await processTranscript(content, false);
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : 'Falha no envio da mensagem.');
    }
  }, [move, processTranscript, setFailure]);

  useEffect(() => {
    const adapter = createTtsAdapter(preferences.adapter);
    adapterRef.current = adapter;
    const queue = new SpeechQueue(
      adapter,
      () => ({
        voiceId: preferencesRef.current.voiceId || undefined,
        speed: preferencesRef.current.speed,
      }),
      () => setError('Não foi possível gerar a fala. Verifique a configuração de voz selecionada.'),
    );
    queueRef.current = queue;
    const responseSpeaker = new JarvisResponseSpeaker(queue);
    responseSpeakerRef.current = responseSpeaker;
    const unsubscribe = adapter.subscribe((event) => {
      if (event.type === 'amplitude') setAmplitude(event.value);
      if (event.type === 'start') move({ type: 'RESPONSE_STARTED' });
    });
    if (preferences.autoStart) void startRef.current();

    return () => {
      unsubscribe();
      responseSpeaker.cancel();
      if (adapterRef.current === adapter) adapterRef.current = null;
      if (responseSpeakerRef.current === responseSpeaker) responseSpeakerRef.current = null;
      if (queueRef.current === queue) queueRef.current = null;
    };
  }, [move, preferences.adapter, preferences.autoStart, setAmplitude]);

  useEffect(() => {
    useTtsStore.getState().stop();
  }, []);

  useEffect(() => {
    pauseWhenHiddenRef.current = preferences.pauseWhenHidden;
  }, [preferences.pauseWhenHidden]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (!pauseWhenHiddenRef.current) return;
      if (document.hidden && captureRef.current && stateRef.current !== 'paused') {
        hiddenPauseRef.current = true;
        pause();
      } else if (!document.hidden && hiddenPauseRef.current) {
        hiddenPauseRef.current = false;
        void resume();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') interrupt();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('keydown', onKeyDown);
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
      if (resumeTimerRef.current !== null) clearTimeout(resumeTimerRef.current);
      if (errorTimerRef.current !== null) clearTimeout(errorTimerRef.current);
      startTokenRef.current += 1;
      startPendingRef.current = false;
      requestIdRef.current += 1;
      activeControllerRef.current?.abort();
      activeTranscriptionRef.current?.abort();
      activeTranscriptionRef.current = null;
      responseSpeakerRef.current?.cancel();
      teardownCapture();
      setAmplitude(0);
    };
  }, [interrupt, pause, resume, setAmplitude, teardownCapture]);

  return {
    state,
    level,
    amplitude,
    start,
    pause,
    resume,
    stop,
    sendText,
    interrupt,
    error,
    preferences,
    updatePreferences,
    lastTranscript,
    microphoneActive,
    activated,
  };
}
