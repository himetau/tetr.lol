import { settings, saveSettings } from './settings';
import { applyTheme, THEME_PRESETS } from './themes';
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

// Tab icons: chunky filled silhouettes with hard corners - matches the blocky side design.
const fico = (inner: string) =>
  `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${inner}</svg>`;
// Footer toggle icons stay as light strokes (square joins to match the blocky look).
const sico = (inner: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${inner}</svg>`;

const ICONS: Record<ViewName | 'sun' | 'moon', string> = {
  // T-tetromino - the signature piece of the L/S/T loop (sharp blocks)
  lst: fico('<rect x="2.6" y="4.6" width="6" height="6"/><rect x="9" y="4.6" width="6" height="6"/><rect x="15.4" y="4.6" width="6" height="6"/><rect x="9" y="11" width="6" height="6"/>'),
  // a narrow well - the 4-wide setup you stack combos into (square corners)
  fourwide: fico('<path d="M3 4h3.2v10.4h11.6V4h3.2v16H3z"/>'),
  // stacked cards - a browsable catalog of setups
  patterns: fico('<rect x="3" y="6.6" width="13" height="13" opacity="0.5"/><rect x="8" y="4" width="13" height="13"/>'),
  // stopwatch - sprint against the clock (square clock body)
  free: fico('<rect x="9.4" y="1.5" width="5.2" height="2.7"/><rect x="16.9" y="3.4" width="2.3" height="3.6" transform="rotate(42 18.05 5.2)"/><path fill-rule="evenodd" d="M3.5 5h17v17h-17zm3 3v11h11V8z"/><rect x="11.2" y="8.7" width="1.7" height="5.9" transform="rotate(37 12 13.5)"/><rect x="10.85" y="12.35" width="2.3" height="2.3"/>'),
  // mountain summit - climb to the zenith (back peak dimmed for depth, square sun)
  quick: fico('<path opacity="0.45" d="M8.5 20.5 14.9 9l6.4 11.5z"/><path d="M1.7 20.5 9.4 7l7.7 13.5z"/><rect x="7.32" y="3" width="4.2" height="4.2"/>'),
  // rectangular rotation loop - every spin counts (square loop with a gap, triangle at the top pointing right)
  allspin: fico('<path d="M4 4H13V7H7V17H17V8H20V20H4Z"/><path d="M12 1.5 18 5.5 12 9.5Z"/>'),
  // crossed swords - a 1v1 duel (blocky Minecraft-style pixel swords, back blade dimmed for depth)
  versus: fico('<g transform="translate(12 12) scale(1.15)"><g transform="rotate(-45)" opacity="0.5"><path d="M-1.7 0.5H1.7V-7H-1.7Z M-1 -7H1V-9.4H-1Z M-3 0.5H3V2.4H-3Z M-1.2 2.4H1.2V6.6H-1.2Z"/></g><g transform="rotate(45)"><path d="M-1.7 0.5H1.7V-7H-1.7Z M-1 -7H1V-9.4H-1Z M-3 0.5H3V2.4H-3Z M-1.2 2.4H1.2V6.6H-1.2Z"/></g></g>'),
  // ascending bars - your progress climbing (sharp bars)
  stats: fico('<rect x="2.8" y="12" width="4.4" height="8.6"/><rect x="9.8" y="7.8" width="4.4" height="12.8"/><rect x="16.8" y="3.6" width="4.4" height="17"/>'),
  // gear - handling / keys (square cog with square teeth)
  settings: fico('<path fill-rule="evenodd" d="M10 4h4v2h4v4h2v4h-2v4h-4v2h-4v-2H6v-4H4v-4h2V6h4zM9.5 9.5h5v5h-5z"/>'),
  moon: sico('<path d="M14 3h-2v2h-2v2H8v2H6v6h2v2h2v2h2v2h2v-2h-2v-2h-2v-2H8V9h2V7h2V5h2z"/>'),
  sun: sico('<rect x="8" y="8" width="8" height="8"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>'),
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
  "Thank srabb for the text font",
  "Stole my friends server to run this site btw",
  "No mechanics stolen from tetrio"
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

  // footer: pick the theme without a trip to settings
  const foot = document.createElement('div');
  foot.className = 'side-foot';
  const themeSel = document.createElement('select');
  themeSel.className = 'foot-theme';
  themeSel.title = 'Theme';
  // the collapsed control always reads "Theme", not the active theme's name
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = 'Theme';
  ph.disabled = true;
  ph.selected = true;
  ph.hidden = true;
  themeSel.appendChild(ph);
  for (const [key, label] of THEME_PRESETS) {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = label;
    themeSel.appendChild(o);
  }
  themeSel.addEventListener('change', () => {
    settings.palette.preset = themeSel.value;
    applyTheme();
    saveSettings();
    themeSel.selectedIndex = 0; // snap back so it keeps showing "Theme"
  });
  foot.appendChild(themeSel);
  const cycleHint = document.createElement('span');
  cycleHint.className = 'cycle-hint';
  cycleHint.innerHTML = `<kbd>[</kbd><kbd>]</kbd><span>tabs</span>`;
  cycleHint.title = 'Cycle tabs from anywhere';
  foot.appendChild(cycleHint);
  sidebar.appendChild(foot);

  // Cycle tabs from anywhere with [ and ] - never bound to gameplay, so it
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
