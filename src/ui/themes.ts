// Selectable colour themes + a custom-palette editor. A theme is just 8 base
// colours; applyTheme() writes them onto the document root and derives the
// rest of the app's CSS custom properties from them (panel/deep/inset are the
// background at different lightness, muted text is text faded toward bg, etc.)
// so a preset or custom theme is a small, easy set to define. Add a theme by
// dropping 8 colours in THEMES and a row in THEME_PRESETS - the editor and the
// dropdown pick it up. Be liberal with colours here: more presets are coming.

import { settings } from './settings';

/** The editable base colours: CSS custom-property name → editor label. */
export const THEME_VARS: [string, string][] = [
  ['bg', 'Background'],
  ['text', 'Text'],
  ['accent', 'Accent'],
  ['accent2', 'Accent 2'],
  ['good', 'Good'],
  ['warn', 'Warn'],
  ['bad', 'Bad'],
  ['line', 'Border'],
];

/** Derived variables built from the base via color-mix (name → CSS value).
 * `on-accent` is contrast-computed separately (color-mix can't pick contrast). */
const DERIVED: [string, string][] = [
  ['bg-deep', 'color-mix(in srgb, var(--bg), #000 13%)'],
  ['bg-raised', 'color-mix(in srgb, var(--bg), #fff 6%)'],
  ['bg-inset', 'color-mix(in srgb, var(--bg), #000 22%)'],
  ['text-dim', 'color-mix(in srgb, var(--text), var(--bg) 45%)'],
  ['accent-soft', 'color-mix(in srgb, var(--accent), var(--bg) 80%)'],
  ['field-bg', 'color-mix(in srgb, var(--bg), #000 34%)'],
  ['field-grid', 'color-mix(in srgb, var(--bg), var(--text) 9%)'],
];

export type Palette = Record<string, string>;

export const THEMES: Record<string, Palette> = {
  mocha: { bg: '#1e1e2e', text: '#cdd6f4', accent: '#cba6f7', accent2: '#89dceb', good: '#a6e3a1', warn: '#f9e2af', bad: '#f38ba8', line: '#363652' },
  // monochrome amber-on-charcoal HUD, after the Departure Mono specimen
  ember: { bg: '#222222', text: '#ebe6dd', accent: '#ffa232', accent2: '#ffc46e', good: '#98c379', warn: '#ffd35c', bad: '#ff5c47', line: '#3a3a3a' },
  dracula: { bg: '#282a36', text: '#f8f8f2', accent: '#bd93f9', accent2: '#8be9fd', good: '#50fa7b', warn: '#f1fa8c', bad: '#ff5555', line: '#44475a' },
  nord: { bg: '#2e3440', text: '#eceff4', accent: '#88c0d0', accent2: '#b48ead', good: '#a3be8c', warn: '#ebcb8b', bad: '#bf616a', line: '#434c5e' },
  gruvbox: { bg: '#282828', text: '#ebdbb2', accent: '#fabd2f', accent2: '#8ec07c', good: '#b8bb26', warn: '#fe8019', bad: '#fb4934', line: '#504945' },
  'rose-pine': { bg: '#191724', text: '#e0def4', accent: '#c4a7e7', accent2: '#9ccfd8', good: '#9ccfd8', warn: '#f6c177', bad: '#eb6f92', line: '#403d52' },
};

/** preset key → dropdown label, in display order. */
export const THEME_PRESETS: [string, string][] = [
  ['rose-pine', 'Rosé Pine'],
  ['mocha', 'Catppuccin Mocha'],
  ['ember', 'Ember'],
  ['dracula', 'Dracula'],
  ['nord', 'Nord'],
  ['gruvbox', 'Gruvbox'],
  ['custom', 'Custom'],
];

/** presets that should render on a light stylesheet base (shadows, series).
 * Currently empty - every preset is dark - but the mechanism stays for
 * future light presets. */
const LIGHT = new Set<string>([]);

/** relative luminance (0..1) of a #rrggbb colour */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** The base palette currently in effect - seeds the custom editor's swatches. */
export function activePalette(): Palette {
  const p = settings.palette;
  if (p.preset === 'custom') return { ...THEMES['rose-pine'], ...p.custom };
  return THEMES[p.preset] ?? THEMES['rose-pine'];
}

/** Apply the selected theme to the document root. */
export function applyTheme(): void {
  const root = document.documentElement;
  const p = settings.palette;
  // data-theme keeps the stylesheet's non-palette bits (shadow depth, chart
  // series, radius) matched to the theme's overall lightness
  root.dataset.theme = LIGHT.has(p.preset) ? 'light' : 'dark';
  const pal = p.preset === 'custom' ? { ...THEMES['rose-pine'], ...p.custom } : (THEMES[p.preset] ?? THEMES['rose-pine']);
  for (const [v] of THEME_VARS) {
    if (pal[v]) root.style.setProperty('--' + v, pal[v]);
  }
  for (const [v, expr] of DERIVED) root.style.setProperty('--' + v, expr);
  // text on the accent colour: contrast against the accent's brightness
  root.style.setProperty('--on-accent', luminance(pal.accent ?? '#000000') > 0.55 ? '#15141c' : '#ffffff');
}
