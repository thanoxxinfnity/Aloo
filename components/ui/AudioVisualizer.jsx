/**
 * ALOO — Real-time voice spectrum visualiser.
 * ===========================================================================
 * Reads the shared audio graph every animation frame and paints a mirrored bar
 * spectrum onto a 2D canvas.
 *
 * WHY CANVAS, NOT DOM: 64 bars × 60fps = 3840 style mutations a second. On the
 * DOM that is a guaranteed jank source; on a canvas it is one draw call's worth
 * of work and never touches React at all.
 *
 * The bars are logarithmically binned — human hearing is logarithmic, so a
 * linear FFT read-out wastes 80% of its width on inaudible high frequencies and
 * makes speech look like a flat wall.
 */

import { useEffect, useRef } from 'react';
import { getSpectrum, getLevel, AUDIO_BINS } from '@/lib/audioGraph';

export default function AudioVisualizer({
  bars = 48,
  height = 44,
  active = true,
  mode = 'idle', // 'idle' | 'listening' | 'speaking' | 'thinking'
  className = '',
}) {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const smoothed = useRef(new Float32Array(bars));
  const modeRef = useRef(mode);
  const activeRef = useRef(active);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    smoothed.current = new Float32Array(bars);
  }, [bars]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');

    // Precompute logarithmic bin edges once — cheap, and keeps the draw loop tight.
    const edges = new Uint16Array(bars + 1);
    for (let i = 0; i <= bars; i++) {
      const frac = i / bars;
      // Bias toward the bottom third of the spectrum where speech lives.
      edges[i] = Math.min(AUDIO_BINS - 1, Math.round((Math.pow(frac, 2.1) * 0.62) * AUDIO_BINS));
    }

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const palette = {
      idle: ['rgba(56,189,248,0.35)', 'rgba(129,140,248,0.2)'],
      listening: ['rgba(52,211,153,0.95)', 'rgba(56,189,248,0.55)'],
      speaking: ['rgba(56,189,248,0.98)', 'rgba(129,140,248,0.62)'],
      thinking: ['rgba(129,140,248,0.9)', 'rgba(244,114,182,0.45)'],
    };

    const draw = () => {
      rafRef.current = requestAnimationFrame(draw);

      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      if (!w || !h) return;

      ctx.clearRect(0, 0, w, h);

      const currentMode = modeRef.current;
      const [c1, c2] = palette[currentMode] || palette.idle;
      const spec = activeRef.current ? getSpectrum() : null;
      const level = activeRef.current ? getLevel() : 0;
      const t = performance.now() / 1000;

      const gap = 2;
      const barW = Math.max(1.5, w / bars - gap);
      const mid = h / 2;

      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, c2);
      grad.addColorStop(0.5, c1);
      grad.addColorStop(1, c2);
      ctx.fillStyle = grad;
      ctx.shadowColor = c1;
      ctx.shadowBlur = 8;

      for (let i = 0; i < bars; i++) {
        let target;
        if (spec && level > 0.008) {
          // Average the bins that fall inside this bar's logarithmic slice.
          let sum = 0;
          let n = 0;
          for (let b = edges[i]; b <= edges[i + 1]; b++) {
            sum += spec[b];
            n++;
          }
          target = n ? sum / n / 255 : 0;
          // Perceptual curve + a slight lift at the edges so the shape reads
          // as a voice rather than a single central spike.
          target = Math.pow(target, 0.72);
        } else {
          // Idle: a slow breathing sine so the HUD never looks dead.
          const phase = t * 1.15 + i * 0.34;
          target = (0.06 + Math.sin(phase) * 0.035 + Math.sin(phase * 0.37) * 0.02) *
            (currentMode === 'thinking' ? 2.4 : 1);
        }

        // Asymmetric smoothing: fast attack (0.55) so transients pop, slow
        // release (0.14) so bars fall like real VU meters.
        const prev = smoothed.current[i];
        smoothed.current[i] = target > prev ? prev + (target - prev) * 0.55 : prev + (target - prev) * 0.14;

        const barH = Math.max(1.5, smoothed.current[i] * h * 0.92);
        const x = i * (barW + gap);
        const r = Math.min(barW / 2, 1.5);

        ctx.beginPath();
        // Mirrored around the centre line — the classic spectrum look.
        if (ctx.roundRect) ctx.roundRect(x, mid - barH / 2, barW, barH, r);
        else ctx.rect(x, mid - barH / 2, barW, barH);
        ctx.fill();
      }

      // Centre hairline.
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(56,189,248,0.16)';
      ctx.fillRect(0, mid - 0.5, w, 1);
    };

    rafRef.current = requestAnimationFrame(draw);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
  }, [bars]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: '100%', height, display: 'block' }}
      aria-hidden="true"
    />
  );
}
