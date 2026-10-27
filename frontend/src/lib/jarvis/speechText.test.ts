import { describe, expect, it } from 'vitest';
import { removeActivationWord, splitSentences, takeCompleteSentences, toSpeechText } from './speechText';

describe('Jarvis speech text helpers', () => {
  it('removes markdown, URLs, emoji, symbols, and never reads code blocks', () => {
    expect(toSpeechText('**Olá!** [documentação](https://example.com) [referência][docs] 😊 `x+y`\n[docs]: https://example.com\n```ts\nconst x = 1;\n```'))
      .toBe('Olá! documentação referência x y O código está na tela de chat.');
  });

  it('splits complete sentences while keeping an unfinished stream remainder', () => {
    expect(splitSentences('Olá. Tudo bem?')).toEqual(['Olá.', 'Tudo bem?']);
    expect(takeCompleteSentences('Uma frase. Ainda incompleta')).toEqual({
      sentences: ['Uma frase.'],
      remainder: 'Ainda incompleta',
    });
  });

  it('does not queue a partial fenced code block while streaming', () => {
    expect(takeCompleteSentences('Uma frase. ```ts\nconst text = "não ler."')).toEqual({
      sentences: ['Uma frase.'],
      remainder: '```ts\nconst text = "não ler."',
    });
    expect(toSpeechText('```ts\nconst x = 1;')).toBe('O código está na tela de chat.');
  });

  it('detects accented and prefixed activation words and strips the prefix', () => {
    expect(removeActivationWord('Járvis, abra a tela.')).toBe('abra a tela.');
    expect(removeActivationWord('Ei Jarvis, como vai?')).toBe('como vai?');
    expect(removeActivationWord('Abra a tela.')).toBeNull();
    expect(removeActivationWord('J\u0061\u0301rvis: fale.')).toBe('fale.');
  });
});
