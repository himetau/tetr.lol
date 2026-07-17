import { applyTheme, settings, saveSettings } from './settings';
import { GameView } from './game-view';
import { ZenithView } from './zenith-view';
import { VersusView } from './versus-view';
import { settingsView } from './settings-view';
import { patternsView } from './patterns-view';
import { statsView } from './stats-view';
import { sfx } from './sound';
import { initBackground } from './background';
import type { Mode } from './stats';

type ViewName = 'lst' | 'fourwide' | 'free' | 'quick' | 'allspin' | 'versus' | 'patterns' | 'stats' | 'settings';

// nav icons: Feather / Lucide stroke icons (MIT/ISC), inlined as SVG
const svgIcon = (inner: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const ICONS: Record<ViewName | 'sun' | 'moon', string> = {
  // layers — LST is a stacking method
  lst: svgIcon('<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>'),
  // flame — combo chain
  fourwide: svgIcon('<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>'),
  // timer — sprint
  free: svgIcon('<line x1="10" y1="2" x2="14" y2="2"/><line x1="12" y1="14" x2="15" y2="11"/><circle cx="12" cy="14" r="8"/>'),
  // mountain — zenith climb
  quick: svgIcon('<path d="m8 3 4 8 5-5 5 15H2L8 3z"/>'),
  // rotate-cw — spins
  allspin: svgIcon('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>'),
  // swords — versus
  versus: svgIcon('<polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" y1="19" x2="19" y2="13"/><line x1="16" y1="16" x2="20" y2="20"/><line x1="19" y1="21" x2="21" y2="19"/><polyline points="14.5 6.5 18 3 21 3 21 6 17.5 10"/><line x1="5" y1="14" x2="9" y2="18"/><line x1="7" y1="17" x2="4" y2="20"/><line x1="3" y1="19" x2="5" y2="21"/>'),
  // book-open — pattern library
  patterns: svgIcon('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'),
  // bar-chart — progress
  stats: svgIcon('<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>'),
  // sliders — handling / keys
  settings: svgIcon('<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>'),
  moon: svgIcon('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),
  sun: svgIcon('<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>'),
};

const NAV: { name: ViewName; label: string; tag: string; sec?: string }[] = [
  { name: 'lst', label: 'LST drill', tag: 'opener → loop', sec: 'train' },
  { name: 'fourwide', label: '4-wide', tag: 'combo drill' },
  { name: 'free', label: '40 lines', tag: 'sprint' },
  { name: 'quick', label: 'Quick play', tag: 'zenith climb', sec: 'play' },
  { name: 'allspin', label: 'All-Spin', tag: 'vs cold clear' },
  { name: 'versus', label: '1v1', tag: 'live vs cold clear' },
  { name: 'patterns', label: 'Patterns', tag: 'four.lol library', sec: 'library' },
  { name: 'stats', label: 'Stats', tag: 'progress' },
  { name: 'settings', label: 'Settings', tag: 'handling · keys' },
];

export function startApp(root: HTMLElement): void {
  applyTheme();
  initBackground();

  const sidebar = document.createElement('nav');
  sidebar.className = 'sidebar';
  const brand = document.createElement('div');
  brand.className = 'brand';
  brand.innerHTML = `<span class="logo">tetr<em>.lol</em></span><span class="tagline">stacking practice</span>`;
  sidebar.appendChild(brand);

  const viewEl = document.createElement('main');
  viewEl.id = 'view';

  let currentGame: GameView | ZenithView | VersusView | null = null;
  let activeBtn: HTMLElement | null = null;
  const buttons = new Map<ViewName, HTMLElement>();

  const show = (name: ViewName) => {
    currentGame?.destroy();
    currentGame = null;
    viewEl.replaceChildren();
    activeBtn?.classList.remove('active');
    activeBtn = buttons.get(name) ?? null;
    activeBtn?.classList.add('active');

    let mounted: HTMLElement;
    if (name === 'lst' || name === 'fourwide' || name === 'free' || name === 'allspin') {
      currentGame = new GameView(name as Mode);
      mounted = currentGame.root;
    } else if (name === 'quick') {
      currentGame = new ZenithView();
      mounted = currentGame.root;
    } else if (name === 'versus') {
      currentGame = new VersusView();
      mounted = currentGame.root;
    } else if (name === 'patterns') {
      mounted = patternsView();
    } else if (name === 'stats') {
      mounted = statsView();
    } else {
      mounted = settingsView();
    }
    mounted.classList.add('view-in');
    viewEl.appendChild(mounted);
  };

  for (const item of NAV) {
    if (item.name === 'stats') {
      const spacer = document.createElement('div');
      spacer.className = 'spacer';
      sidebar.appendChild(spacer);
    } else if (item.sec) {
      const sec = document.createElement('div');
      sec.className = 'nav-sec';
      sec.textContent = item.sec;
      sidebar.appendChild(sec);
    }
    const b = document.createElement('button');
    b.className = 'nav-btn';
    b.innerHTML = `<span class="ico">${ICONS[item.name]}</span><span class="txt">${item.label}<small>${item.tag}</small></span>`;
    b.addEventListener('click', () => {
      if (b !== activeBtn && settings.soundFx) sfx('move', 0.2, 'master');
      show(item.name);
    });
    sidebar.appendChild(b);
    buttons.set(item.name, b);
  }

  // footer: quick theme flip without a trip to settings
  const foot = document.createElement('div');
  foot.className = 'side-foot';
  const themeBtn = document.createElement('button');
  themeBtn.className = 'foot-btn';
  const themeLabel = () =>
    settings.theme === 'dark' ? `${ICONS.moon}<span>dark</span>` : `${ICONS.sun}<span>light</span>`;
  themeBtn.innerHTML = themeLabel();
  themeBtn.title = 'Toggle theme';
  themeBtn.addEventListener('click', () => {
    settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    saveSettings();
    themeBtn.innerHTML = themeLabel();
  });
  foot.appendChild(themeBtn);
  sidebar.appendChild(foot);

  root.append(sidebar, viewEl);
  show('lst');
}
