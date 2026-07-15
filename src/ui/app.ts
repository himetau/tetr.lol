import { applyTheme } from './settings';
import { GameView } from './game-view';
import { ZenithView } from './zenith-view';
import { settingsView } from './settings-view';
import { patternsView } from './patterns-view';
import { statsView } from './stats-view';
import type { Mode } from './stats';

type ViewName = 'lst' | 'free' | 'quick' | 'patterns' | 'stats' | 'settings';

const NAV: { name: ViewName; label: string; ico: string }[] = [
  { name: 'lst', label: 'LST drill', ico: '◆' },
  { name: 'free', label: 'Freeplay', ico: '●' },
  { name: 'quick', label: 'Quick play', ico: '▲' },
  { name: 'patterns', label: 'Patterns', ico: '▦' },
  { name: 'stats', label: 'Stats', ico: '∿' },
  { name: 'settings', label: 'Settings', ico: '⚙' },
];

export function startApp(root: HTMLElement): void {
  applyTheme();

  const sidebar = document.createElement('nav');
  sidebar.className = 'sidebar';
  const brand = document.createElement('div');
  brand.className = 'brand';
  brand.innerHTML = 'lst<em>.</em>trainer';
  sidebar.appendChild(brand);

  const viewEl = document.createElement('main');
  viewEl.id = 'view';

  let currentGame: GameView | ZenithView | null = null;
  let activeBtn: HTMLElement | null = null;
  const buttons = new Map<ViewName, HTMLElement>();

  const show = (name: ViewName) => {
    currentGame?.destroy();
    currentGame = null;
    viewEl.replaceChildren();
    activeBtn?.classList.remove('active');
    activeBtn = buttons.get(name) ?? null;
    activeBtn?.classList.add('active');

    if (name === 'lst' || name === 'free') {
      currentGame = new GameView(name as Mode);
      viewEl.appendChild(currentGame.root);
    } else if (name === 'quick') {
      currentGame = new ZenithView();
      viewEl.appendChild(currentGame.root);
    } else if (name === 'patterns') {
      viewEl.appendChild(patternsView());
    } else if (name === 'stats') {
      viewEl.appendChild(statsView());
    } else {
      viewEl.appendChild(settingsView());
    }
  };

  for (const item of NAV) {
    const b = document.createElement('button');
    b.className = 'nav-btn';
    b.innerHTML = `<span class="ico">${item.ico}</span>${item.label}`;
    b.addEventListener('click', () => show(item.name));
    if (item.name === 'stats') {
      const spacer = document.createElement('div');
      spacer.className = 'spacer';
      sidebar.appendChild(spacer);
    }
    sidebar.appendChild(b);
    buttons.set(item.name, b);
  }

  root.append(sidebar, viewEl);
  show('lst');
}
