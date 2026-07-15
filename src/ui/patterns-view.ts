// Browse the four.lol LST / TKI pattern library as rendered mini-boards.

import patterns from '../data/lst-patterns.json';
import { PIECE_COLORS, type PieceType } from '../core/pieces';

interface PatternPage { rows: string[] }
interface Pattern { fumen: string; pages: PatternPage[] }
interface Section { heading: string; patterns: Pattern[] }

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function renderPatternCanvas(rows: string[], cell = 14): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  const h = rows.length;
  const w = 10;
  canvas.width = w * cell * dpr;
  canvas.height = h * cell * dpr;
  canvas.style.width = `${w * cell}px`;
  canvas.style.height = `${h * cell}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = css('--field-bg');
  ctx.fillRect(0, 0, w * cell, h * cell);
  for (let r = 0; r < h; r++) {
    for (let x = 0; x < Math.min(10, rows[r].length); x++) {
      const ch = rows[r][x];
      if (ch === '_' || ch === ' ') continue;
      ctx.fillStyle = ch === 'X' ? css('--text-dim') : (PIECE_COLORS[ch as PieceType] ?? css('--text-dim'));
      ctx.globalAlpha = ch === 'X' ? 0.65 : 1;
      ctx.beginPath();
      ctx.roundRect(x * cell + 0.5, r * cell + 0.5, cell - 1, cell - 1, 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  return canvas;
}

export function patternsView(): HTMLElement {
  const page = document.createElement('div');
  page.className = 'page';
  page.innerHTML = `<h1>Pattern library</h1>
    <p class="sub">every diagram from <a href="https://four.lol/stacking/lst/" target="_blank">four.lol/stacking/lst</a>
    and <a href="https://four.lol/openers/tki/" target="_blank">four.lol/openers/tki</a> — click a diagram to open it in the fumen viewer</p>`;

  const data = patterns as unknown as { tki: Section[]; lst: Section[] };
  for (const [title, sections] of [['LST Stacking', data.lst], ['TKI Opener', data.tki]] as [string, Section[]][]) {
    const h = document.createElement('h1');
    h.textContent = title;
    h.style.fontSize = '20px';
    h.style.marginTop = '26px';
    page.appendChild(h);
    for (const sec of sections) {
      const c = document.createElement('div');
      c.className = 'card';
      const hh = document.createElement('h2');
      hh.textContent = sec.heading;
      c.appendChild(hh);
      const grid = document.createElement('div');
      grid.className = 'alt-grid';
      for (const p of sec.patterns) {
        const cardEl = document.createElement('a');
        cardEl.className = 'alt-card';
        cardEl.href = `https://knewjade.github.io/fumen-for-mobile/#?d=${encodeURIComponent(p.fumen)}`;
        cardEl.target = '_blank';
        cardEl.style.textDecoration = 'none';
        cardEl.appendChild(renderPatternCanvas(p.pages[0].rows));
        if (p.pages.length > 1) {
          const meta = document.createElement('div');
          meta.className = 'meta';
          meta.innerHTML = `<span>${p.pages.length} steps</span>`;
          cardEl.appendChild(meta);
        }
        grid.appendChild(cardEl);
      }
      c.appendChild(grid);
      page.appendChild(c);
    }
  }
  return page;
}
