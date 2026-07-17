import { DEFAULT_HANDLING, DEFAULT_KEYBINDS, type HandlingSettings, type Keybinds } from '../core/handling';
import type { Pressure } from '../core/versus';

export interface VolumeSettings {
  master: number; // percent, 0..100 — scales every category
  move: number;   // movement: move/rotate/drop/hold/gravity lock
  clear: number;  // line clears, spins, B2B and combo jingles
  alert: number;  // garbage, danger, countdowns, mistakes, milestones
}

export interface BackgroundSettings {
  mode: 'aurora' | 'scenes' | 'custom'; // aurora = glow only, no image
  cycleSec: number; // seconds between background changes
  dim: number;      // percent, 0..100 — overlay strength over the image
}

/** What applies pressure in a drill: nothing, quickplay-style scheduled
 * garbage, or a real Cold Clear bot playing its own hidden board. */
export type OpponentKind = 'off' | 'garbage' | 'bot';
export type BotLevel = 'easy' | 'normal' | 'hard' | 'elite';

/** CC2 node budget per move — the bot's strength knob. */
export const BOT_NODES: Record<BotLevel, number> = { easy: 1200, normal: 6000, hard: 20000, elite: 60000 };

export interface VersusSettings {
  botPps: number;         // bot pieces per second (0.5..4)
  botLevel: BotLevel;
  garbageDelayMs: number; // telegraph before an attack can rise
  messiness: number;      // percent 0..100 — hole-column chaos
  garbageCap: number;     // max rows rising on one non-clearing lock
  pressure: Pressure;     // scheduled-garbage intensity ('garbage' opponents)
  /** per-drill opponent (the 1v1 mode always uses the bot) */
  drill: { fourwide: OpponentKind; free: OpponentKind; allspin: OpponentKind };
}

export interface AppSettings {
  handling: HandlingSettings;
  binds: Keybinds;
  theme: 'light' | 'dark';
  background: BackgroundSettings;
  boardZoom: number; // percent, 60..160
  ghost: boolean;
  grid: boolean;
  effects: boolean; // particles, screen shake, action text popups
  stopOnMistake: boolean;
  soundOnMistake: boolean;
  soundFx: boolean;
  volume: VolumeSettings;
  neuralEval: boolean;
  autoRetryTopOut: boolean;
  feedbackLevel: 'all' | 'mistakes' | 'off';
  versus: VersusSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  handling: { ...DEFAULT_HANDLING },
  binds: structuredClone(DEFAULT_KEYBINDS),
  theme: 'dark',
  background: { mode: 'scenes', cycleSec: 120, dim: 70 },
  boardZoom: 100,
  ghost: true,
  grid: true,
  effects: true,
  stopOnMistake: false,
  soundOnMistake: true,
  soundFx: true,
  volume: { master: 100, move: 100, clear: 100, alert: 100 },
  neuralEval: true,
  autoRetryTopOut: false,
  feedbackLevel: 'all',
  versus: {
    botPps: 1.5,
    botLevel: 'normal',
    garbageDelayMs: 2000,
    messiness: 15,
    garbageCap: 8,
    pressure: 'normal',
    // 4-wide defaults to scheduled garbage — a bot's normal stacking reads
    // oddly against a combo drill; the other drills get the real bot
    drill: { fourwide: 'garbage', free: 'bot', allspin: 'bot' },
  },
};

// predates the tetr.ai rename — kept so existing settings survive
const KEY = 'lst-trainer-settings-v1';

type Listener = (s: AppSettings) => void;
const listeners: Listener[] = [];

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const parsed = JSON.parse(raw);
    // deep-merge over defaults so new fields appear after updates
    const def = structuredClone(DEFAULT_SETTINGS);
    const merged: AppSettings = {
      ...def,
      ...parsed,
      handling: { ...def.handling, ...parsed.handling },
      binds: { ...def.binds, ...parsed.binds },
      volume: { ...def.volume, ...parsed.volume },
      background: { ...def.background, ...parsed.background },
      versus: { ...def.versus, ...parsed.versus, drill: { ...def.versus.drill, ...parsed.versus?.drill } },
    };
    // migrations: undo moved to Ctrl+Z, ControlLeft freed from rotateCCW
    if (merged.binds.undo.length === 1 && merged.binds.undo[0] === 'Backspace') {
      merged.binds.undo = ['Ctrl+KeyZ'];
    }
    merged.binds.rotateCCW = merged.binds.rotateCCW.filter((c) => c !== 'ControlLeft');
    if (merged.binds.rotateCCW.length === 0) merged.binds.rotateCCW = ['KeyZ'];
    // migration: autoRestartTki never shipped a UI and was never read
    delete (merged as unknown as Record<string, unknown>).autoRestartTki;
    return merged;
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export const settings: AppSettings = loadSettings();

export function saveSettings(): void {
  localStorage.setItem(KEY, JSON.stringify(settings));
  for (const l of listeners) l(settings);
}

export function onSettingsChange(l: Listener): () => void {
  listeners.push(l);
  return () => {
    const i = listeners.indexOf(l);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function applyTheme(): void {
  document.documentElement.dataset.theme = settings.theme;
}
