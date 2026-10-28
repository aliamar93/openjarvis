import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { JarvisPage } from './JarvisPage';

describe('JarvisPage', () => {
  it('renders an accessible HUD and a collapsed demo without a message history', () => {
    const markup = renderToStaticMarkup(<JarvisPage />);

    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('<details');
    expect(markup).not.toContain('<details open');
    expect(markup).toContain('aria-label="Mensagem para o J.A.R.V.I.S."');
    expect(markup).toContain('Ativar escuta');
    expect(markup).toContain('Configurações de voz');
    expect(markup).toContain('Permitir interromper o JARVIS falando');
    expect(markup).toContain('Exigir “Jarvis” para interromper');
    expect(markup).not.toContain('listitem');
  });
});
