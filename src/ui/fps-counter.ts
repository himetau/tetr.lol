// Optional live FPS readout pinned to the right edge of the screen. A single
// fixed pill appended to <body>; it runs its own light rAF loop only while
// enabled (settings.fpsCounter) and averages frame times over a short window
// so the number is steady, colour-coded green/amber/red by smoothness.

import { settings, onSettingsChange } from './settings';

let el: HTMLElement | null = null;
let rafId = 0;
let last = 0;
let frames = 0;
let acc = 0;

function tick(t: number): void {
  rafId = requestAnimationFrame(tick);
  if (last) {
    acc += t - last;
    frames++;
  }
  last = t;
  if (acc >= 250 && el) {
    const fps = Math.round(frames / (acc / 1000));
    el.textContent = `${fps} FPS`;
    el.style.color = fps >= 55 ? 'var(--good)' : fps >= 30 ? 'var(--warn)' : 'var(--bad)';
    frames = 0;
    acc = 0;
  }
}

function start(): void {
  if (rafId) return;
  last = 0;
  frames = 0;
  acc = 0;
  rafId = requestAnimationFrame(tick);
}

function stop(): void {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

/** Create the readout and wire it to the setting; call once at app startup. */
export function initFpsCounter(): void {
  if (el) return;
  el = document.createElement('div');
  el.className = 'fps-counter';
  el.textContent = '– FPS';
  document.body.appendChild(el);
  const apply = () => {
    const on = settings.fpsCounter;
    el!.classList.toggle('show', on);
    if (on) start();
    else stop();
  };
  apply();
  onSettingsChange(apply);
}
