import { applyTheme, settings, saveSettings } from './settings';
import { GameView } from './game-view';
import { ZenithView } from './zenith-view';
import { settingsView } from './settings-view';
import { patternsView } from './patterns-view';
import { statsView } from './stats-view';
import { sfx } from './sound';
import { initBackground } from './background';
import type { Mode } from './stats';

type ViewName = 'lst' | 'fourwide' | 'free' | 'quick' | 'allspin' | 'patterns' | 'stats' | 'settings';

const NAV: { name: ViewName; label: string; ico: string; tag: string }[] = [
  { name: 'lst', label: 'LST drill', ico: '◆', tag: 'opener → loop' },
  { name: 'fourwide', label: '4-wide', ico: '▯', tag: 'combo drill' },
  { name: 'free', label: '40 lines', ico: '●', tag: 'sprint' },
  { name: 'quick', label: 'Quick play', ico: '▲', tag: 'zenith climb' },
  { name: 'allspin', label: 'All-Spin', ico: '✦', tag: 'vs cold clear' },
  { name: 'patterns', label: 'Patterns', ico: '▦', tag: 'four.lol library' },
  { name: 'stats', label: 'Stats', ico: '∿', tag: 'progress' },
  { name: 'settings', label: 'Settings', ico: '⚙', tag: 'handling · keys' },
];

export function startApp(root: HTMLElement): void {
  applyTheme();
  initBackground();

  const sidebar = document.createElement('nav');
  sidebar.className = 'sidebar';
  const brand = document.createElement('div');
  brand.className = 'brand';
  brand.innerHTML = `<span class="logo">tetr<em>.ai</em></span><span class="tagline">stacking practice</span>`;
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

    let mounted: HTMLElement;
    if (name === 'lst' || name === 'fourwide' || name === 'free' || name === 'allspin') {
      currentGame = new GameView(name as Mode);
      mounted = currentGame.root;
    } else if (name === 'quick') {
      currentGame = new ZenithView();
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
    const b = document.createElement('button');
    b.className = 'nav-btn';
    b.innerHTML = `<span class="ico">${item.ico}</span><span class="txt">${item.label}<small>${item.tag}</small></span>`;
    b.addEventListener('click', () => {
      if (b !== activeBtn && settings.soundFx) sfx('move', 0.2, 'master');
      show(item.name);
    });
    if (item.name === 'stats') {
      const spacer = document.createElement('div');
      spacer.className = 'spacer';
      sidebar.appendChild(spacer);
    }
    sidebar.appendChild(b);
    buttons.set(item.name, b);
  }

  // footer: quick theme flip without a trip to settings
  const foot = document.createElement('div');
  foot.className = 'side-foot';
  const themeBtn = document.createElement('button');
  themeBtn.className = 'foot-btn';
  const themeLabel = () => (settings.theme === 'dark' ? '◐ dark' : '◑ light');
  themeBtn.textContent = themeLabel();
  themeBtn.title = 'Toggle theme';
  themeBtn.addEventListener('click', () => {
    settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    saveSettings();
    themeBtn.textContent = themeLabel();
  });
  foot.appendChild(themeBtn);
  sidebar.appendChild(foot);

  root.append(sidebar, viewEl);
  show('lst');
}
