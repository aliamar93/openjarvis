import { toSpeechText } from './speechText';
import type { SpeechQueue } from './ttsAdapters';

export function getFinalResponseSpeech(response: string, pendingSpeech: string): string {
  return pendingSpeech || (!response ? 'Não consegui gerar uma resposta.' : '');
}

const NUMBER_WORDS: Record<string, number> = {
  uma: 1,
  duas: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
};

export function getRepetitionCount(text: string): number | null {
  const normalized = text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (/\bnao\s+(?:precisa|quero|va|deve)\s+repet\w*/u.test(normalized)) return null;

  const request = normalized
    .replace(/^(?:(?:por favor|pode|poderia|voce pode|voce poderia)(?: por favor)?|quero que voce|nao entendi)\s+/u, '')
    .replace(/\s+por favor$/u, '')
    .replace(/\s+(?:\d+|uma|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)\s+vez(?:es)?$/u, '');
  const isRepeatRequest =
    /^(?:repita|repete|repetir)(?:\s+(?:isso|a resposta|a ultima resposta))?$/u.test(request) ||
    /^(?:fala|fale|diga)\s+(?:isso\s+)?(?:de novo|novamente)$/u.test(request);

  if (!isRepeatRequest) return null;

  const countMatch = normalized.match(/\b(\d+|uma|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)\s+vez(?:es)?\b/u);
  if (!countMatch) return 1;

  const requested = Number(countMatch[1]) || NUMBER_WORDS[countMatch[1]] || 1;
  return Math.min(10, Math.max(1, requested));
}

export class JarvisResponseSpeaker {
  private activeResponseId: string | null = null;
  private completedResponseId: string | null = null;
  private spokenUtteranceIds = new Set<string>();
  private lastSpokenResponse: string | null = null;

  constructor(private readonly queue: SpeechQueue) {}

  speakResponse(text: string, responseId: string, utteranceId = responseId): boolean {
    if (responseId === this.completedResponseId) return false;
    if (responseId === this.activeResponseId && this.spokenUtteranceIds.has(utteranceId)) {
      return false;
    }

    if (responseId !== this.activeResponseId) {
      this.queue.clear();
      this.activeResponseId = responseId;
      this.spokenUtteranceIds.clear();
    }

    this.spokenUtteranceIds.add(utteranceId);
    this.queue.enqueue(text);
    return true;
  }

  completeResponse(responseId: string, text: string): void {
    if (this.activeResponseId !== responseId) return;
    this.lastSpokenResponse = toSpeechText(text) || null;
    this.completedResponseId = responseId;
    this.activeResponseId = null;
    this.spokenUtteranceIds.clear();
  }

  repeatLastResponse(responseId: string, count: number): string | null {
    const text = this.lastSpokenResponse;
    if (!text) return null;

    for (let index = 0; index < count; index += 1) {
      this.speakResponse(text, responseId, `${responseId}:repeat:${index}`);
    }
    return text;
  }

  cancel(): void {
    this.queue.clear();
    this.activeResponseId = null;
    this.spokenUtteranceIds.clear();
  }
}
