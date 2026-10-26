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
    expect(markup).toContain('aria-label="Campo de texto de demonstração, sem envio"');
    expect(markup).not.toContain('listitem');
  });
});
