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

// Tab icons: chunky filled silhouettes — friendlier than thin corporate strokes.
const fico = (inner: string) =>
  `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${inner}</svg>`;
// Footer toggle icons stay as light strokes.
const sico = (inner: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const ICONS: Record<ViewName | 'sun' | 'moon', string> = {
  // T-tetromino — the signature piece of the L/S/T loop
  lst: fico('<rect x="2.6" y="4.6" width="6" height="6" rx="1.5"/><rect x="9" y="4.6" width="6" height="6" rx="1.5"/><rect x="15.4" y="4.6" width="6" height="6" rx="1.5"/><rect x="9" y="11" width="6" height="6" rx="1.5"/>'),
  // a narrow well — the 4-wide setup you stack combos into
  fourwide: fico('<path d="M3 5a1.6 1.6 0 0 1 3.2 0v9.5h11.6V5a1.6 1.6 0 0 1 3.2 0v13.4A1.6 1.6 0 0 1 19.4 20H4.6A1.6 1.6 0 0 1 3 18.4z"/>'),
  // stacked cards — a browsable catalog of setups
  patterns: fico('<rect x="3" y="6.6" width="13" height="13" rx="2.6" opacity="0.5"/><rect x="8" y="4" width="13" height="13" rx="2.6"/>'),
  // stopwatch — sprint against the clock
  free: fico('<rect x="9.4" y="1.5" width="5.2" height="2.7" rx="1.35"/><rect x="17.4" y="3.9" width="2.3" height="3.6" rx="1.15" transform="rotate(42 18.55 5.7)"/><path fill-rule="evenodd" d="M12 5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zm0 3a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11z"/><rect x="11.2" y="8.7" width="1.7" height="5.9" rx="0.85" transform="rotate(37 12 13.5)"/><circle cx="12" cy="13.5" r="1.15"/>'),
  // mountain summit — climb to the zenith (back peak dimmed for depth)
  quick: fico('<path opacity="0.45" d="M8.5 20.5 14 11a1 1 0 0 1 1.73 0l5.2 9.4a1 1 0 0 1-.87 1.5H8.5z"/><path d="M1.7 20.5 8.5 8.3a1.05 1.05 0 0 1 1.83 0l6.87 12.2a1 1 0 0 1-.87 1.5H2.57A1 1 0 0 1 1.7 20.5z"/><circle cx="9.42" cy="5.1" r="2.1"/>'),
  // rotation arrow — every spin counts
  allspin: fico('<path d="M17.65 6.35A8 8 0 1 0 19.73 14h-2.3A5.8 5.8 0 1 1 12 6.2c1.6 0 3.05.66 4.1 1.7L13 11h8V3z"/>'),
  // crossed swords — a 1v1 duel (back blade dimmed for depth)
  versus: fico('<g transform="translate(12 12) scale(1.15)"><g transform="rotate(-45)" opacity="0.5"><path d="M0 -11 1.5 -8 1.5 1 -1.5 1 -1.5 -8Z M-3.4 1H3.4V2.7H-3.4Z M-1.1 2.7H1.1V6.1H-1.1Z"/></g><g transform="rotate(45)"><path d="M0 -11 1.5 -8 1.5 1 -1.5 1 -1.5 -8Z M-3.4 1H3.4V2.7H-3.4Z M-1.1 2.7H1.1V6.1H-1.1Z"/></g></g>'),
  // ascending bars — your progress climbing
  stats: fico('<rect x="2.8" y="12" width="4.4" height="8.6" rx="1.5"/><rect x="9.8" y="7.8" width="4.4" height="12.8" rx="1.5"/><rect x="16.8" y="3.6" width="4.4" height="17" rx="1.5"/>'),
  // gear — handling / keys (symmetric cog)
  settings: fico('<path fill-rule="evenodd" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87a.49.49 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.01-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z"/>'),
  moon: sico('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),
  sun: sico('<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>'),
};

// Order groups drills to build skills first, then full game modes; Stats + Settings pin to the bottom.
const NAV: { name: ViewName; label: string; tag: string; sec?: string }[] = [
  { name: 'lst', label: 'LST drill', tag: 'opener → loop', sec: 'train' },
  { name: 'fourwide', label: '4-wide', tag: 'combo drill' },
  { name: 'patterns', label: 'Patterns', tag: 'four.lol library' },
  { name: 'free', label: '40 lines', tag: 'sprint', sec: 'play' },
  { name: 'quick', label: 'Quick play', tag: 'zenith climb' },
  { name: 'allspin', label: 'All-Spin', tag: 'vs cold clear' },
  { name: 'versus', label: '1v1', tag: 'live vs cold clear' },
  { name: 'stats', label: 'Stats', tag: 'progress' },
  { name: 'settings', label: 'Settings', tag: 'handling · keys' },
];

const TAGLINES = [
  "Don't look at any code", 
  "It's a game!", 
  "Made without labor", 
  "Singleplayer!", 
  "Closed source (Open if you can find it)",
  "4815162342 lines of code!",
  "Splash not stolen",
  "Sugar free",
  "Sodium free",
  "We're working on it",
];

export function startApp(root: HTMLElement): void {
  applyTheme();
  initBackground();

  const sidebar = document.createElement('nav');
  sidebar.className = 'sidebar';
  const brand = document.createElement('div');
  brand.className = 'brand';
  brand.innerHTML = `<span class="logo">tetr<em>.lol</em></span><span class="tagline">${TAGLINES[Math.floor(Math.random()*TAGLINES.length)]}</span>`;
  sidebar.appendChild(brand);

  const viewEl = document.createElement('main');
  viewEl.id = 'view';

  let currentGame: GameView | ZenithView | VersusView | null = null;
  let activeBtn: HTMLElement | null = null;
  let currentName: ViewName = 'lst';
  const buttons = new Map<ViewName, HTMLElement>();

  const show = (name: ViewName) => {
    currentGame?.destroy();
    currentGame = null;
    currentName = name;
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
  const cycleHint = document.createElement('span');
  cycleHint.className = 'cycle-hint';
  cycleHint.innerHTML = `<kbd>[</kbd><kbd>]</kbd><span>tabs</span>`;
  cycleHint.title = 'Cycle tabs from anywhere';
  foot.appendChild(cycleHint);
  sidebar.appendChild(foot);

  // Cycle tabs from anywhere with [ and ] — never bound to gameplay, so it
  // works mid-drill too. Skip while capturing a rebind or typing in a field.
  const order = NAV.map((n) => n.name);
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== '[' && e.key !== ']') return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    const step = e.key === ']' ? 1 : -1;
    const next = order[(order.indexOf(currentName) + step + order.length) % order.length];
    if (settings.soundFx) sfx('move', 0.2, 'master');
    show(next);
  });

  root.append(sidebar, viewEl);
  show('lst');
}
