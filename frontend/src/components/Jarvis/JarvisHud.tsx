import { useEffect, useRef, type MutableRefObject } from 'react';
import type { JarvisState } from '../../lib/jarvis/stateMachine';
import { jarvisStrings } from '../../lib/jarvis/strings';
import './JarvisHud.css';

interface JarvisHudProps {
  state: JarvisState;
  amplitude: MutableRefObject<number>;
  reducedMotion: boolean;
}

const ticks = Array.from({ length: 64 }, (_, index) => {
  const angle = (index / 64) * Math.PI * 2;
  const innerRadius = index % 4 === 0 ? 129 : 133;
  const outerRadius = 141;
  return {
    x1: 160 + Math.cos(angle) * innerRadius,
    y1: 160 + Math.sin(angle) * innerRadius,
    x2: 160 + Math.cos(angle) * outerRadius,
    y2: 160 + Math.sin(angle) * outerRadius,
    major: index % 4 === 0,
  };
});

export function JarvisHud({ state, amplitude: amplitudeRef, reducedMotion }: JarvisHudProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let amplitude = 0;

    const updateAmplitude = () => {
      const value = amplitudeRef.current;
      const target = reducedMotion || motionPreference.matches || !Number.isFinite(value)
        ? 0
        : Math.min(1, Math.max(0, value));
      amplitude += (target - amplitude) * 0.16;
      if (Math.abs(target - amplitude) < 0.004) amplitude = target;

      svg.style.setProperty('--amp', amplitude.toFixed(3));
      svg.style.setProperty('--glow-size', `${(5 + amplitude * 7).toFixed(2)}px`);
      svg.style.setProperty('--pulse-low-glow', `${(3 + amplitude * 7).toFixed(2)}px`);
      svg.style.setProperty('--pulse-high-glow', `${(7 + amplitude * 12).toFixed(2)}px`);
      svg.style.setProperty('--pulse-low-scale', (1 + amplitude * 0.018).toFixed(3));
      svg.style.setProperty('--pulse-high-scale', (1.012 + amplitude * 0.025).toFixed(3));

      if (amplitude !== target || (!reducedMotion && !motionPreference.matches)) {
        frame = window.requestAnimationFrame(updateAmplitude);
      }
    };

    frame = window.requestAnimationFrame(updateAmplitude);
    const onMotionPreferenceChange = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateAmplitude);
    };
    motionPreference.addEventListener('change', onMotionPreferenceChange);
    return () => {
      window.cancelAnimationFrame(frame);
      motionPreference.removeEventListener('change', onMotionPreferenceChange);
    };
  }, [amplitudeRef, reducedMotion]);

  return (
    <svg
      ref={svgRef}
      className={`jarvis-hud jarvis-hud--${state}${reducedMotion ? ' jarvis-hud--reduced' : ''}`}
      viewBox="0 0 320 320"
      role="img"
      aria-label={jarvisStrings.hudAccessibleName}
    >
      <title>{jarvisStrings.hudAccessibleName}</title>
      <defs>
        <radialGradient id="jarvis-core">
          <stop offset="0%" stopColor="var(--color-bg-secondary)" />
          <stop offset="82%" stopColor="var(--color-bg)" />
          <stop offset="100%" stopColor="var(--color-bg-tertiary)" />
        </radialGradient>
        <filter id="jarvis-glow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="2.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <g className="jarvis-hud__outer-spin">
        <circle className="jarvis-hud__ring jarvis-hud__ring--outer" cx="160" cy="160" r="151" />
        <circle className="jarvis-hud__ring jarvis-hud__ring--dots" cx="160" cy="160" r="147" />
      </g>

      <g className="jarvis-hud__ticks" filter="url(#jarvis-glow)">
        {ticks.map((tick, index) => (
          <line
            key={index}
            className={tick.major ? 'jarvis-hud__tick jarvis-hud__tick--major' : 'jarvis-hud__tick'}
            x1={tick.x1}
            y1={tick.y1}
            x2={tick.x2}
            y2={tick.y2}
          />
        ))}
      </g>

      <g className="jarvis-hud__inner-spin">
        <circle className="jarvis-hud__ring jarvis-hud__ring--fine" cx="160" cy="160" r="119" />
        <circle className="jarvis-hud__ring jarvis-hud__ring--segments" cx="160" cy="160" r="110" />
        <circle className="jarvis-hud__state-arc" cx="160" cy="160" r="110" />
      </g>

      <circle className="jarvis-hud__core-outline" cx="160" cy="160" r="96" />
      <circle className="jarvis-hud__core" cx="160" cy="160" r="91" fill="url(#jarvis-core)" />
      <circle className="jarvis-hud__core-detail" cx="160" cy="160" r="82" />
      <text className="jarvis-hud__wordmark" x="160" y="166" textAnchor="middle">
        {jarvisStrings.pageTitle}
      </text>
      <text className="jarvis-hud__caption" x="160" y="184" textAnchor="middle">
        {jarvisStrings.states[state].toLocaleUpperCase('pt-BR')}
      </text>
    </svg>
  );
}
