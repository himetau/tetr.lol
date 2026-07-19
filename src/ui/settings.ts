import { DEFAULT_HANDLING, DEFAULT_KEYBINDS, type HandlingSettings, type Keybinds } from '../core/handling';
import { DEFAULT_RULES, type AttackRules, type Pressure } from '../core/versus';

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

export interface PaletteSettings {
  /** built-in theme key, 'auto' (follow light/dark), or 'custom' */
  preset: string;
  /** per-variable colour overrides for the custom theme (CSS var → hex) */
  custom: Record<string, string>;
}

/** What applies pressure in a drill: nothing, quickplay-style scheduled
 * garbage, or a real Cold Clear bot playing its own hidden board. */
export type OpponentKind = 'off' | 'garbage' | 'bot';
export type BotLevel = 'easy' | 'normal' | 'hard' | 'elite' | 'custom';

/** CC2 node budget per move — the bot's strength presets. */
export const BOT_NODES: Record<Exclude<BotLevel, 'custom'>, number> = { easy: 1200, normal: 6000, hard: 20000, elite: 60000 };

/** Resolve the bot's node budget: preset level, or the custom slider. */
export function botNodesOf(v: VersusSettings): number {
  return v.botLevel === 'custom' ? v.botNodes : BOT_NODES[v.botLevel];
}

export interface VersusSettings {
  botPps: number;         // bot pieces per second (0.5..4)
  botLevel: BotLevel;
  botNodes: number;       // CC2 nodes per move when botLevel = 'custom'
  garbageDelayMs: number; // telegraph before an attack can rise
  messiness: number;      // percent 0..100 — within-attack hole re-rolls (tetr.io: 0)
  garbageCap: number;     // max rows rising on one non-clearing lock
  pressure: Pressure;     // scheduled-garbage intensity ('garbage' opponents)
  attackScale: number;    // percent — scales the player's outgoing attack
  botAttackScale: number; // percent — scales the bot's outgoing attack (handicap)
  firstTo: number;        // 1v1: rounds needed to take the match
  gravity: number;        // 1v1: player gravity in G (0 = off, 1G = 60 cells/s)
  rules: AttackRules;     // the damage table itself
  /** per-drill opponent (the 1v1 mode always uses the bot) */
  drill: { fourwide: OpponentKind; free: OpponentKind; allspin: OpponentKind };
}

/** The modes whose placements get engine/book evaluation. */
export type GradedMode = 'lst' | 'fourwide' | 'free' | 'allspin';

export interface AppSettings {
  handling: HandlingSettings;
  binds: Keybinds;
  theme: 'light' | 'dark';
  palette: PaletteSettings;
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
  /** per-mode master switch for placement evaluation (grades, paths, chips) */
  evalDrill: Record<GradedMode, boolean>;
  /** which engine drives the LST drill's "watch book" once off the book:
   * the built-in heuristic loop player, or Cold Clear 2 (loop-tuned) */
  lstAssist: 'engine' | 'cc2';
  versus: VersusSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  handling: { ...DEFAULT_HANDLING },
  binds: structuredClone(DEFAULT_KEYBINDS),
  theme: 'dark',
  palette: { preset: 'rose-pine', custom: {} },
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
  evalDrill: { lst: true, fourwide: true, free: true, allspin: true },
  lstAssist: 'engine',
  versus: {
    botPps: 1.5,
    botLevel: 'normal',
    botNodes: 10000,
    garbageDelayMs: 2000,
    messiness: 0,
    garbageCap: 8,
    pressure: 'normal',
    attackScale: 100,
    botAttackScale: 100,
    firstTo: 3,
    gravity: 0,
    rules: { ...DEFAULT_RULES },
    // 4-wide defaults to scheduled garbage — a bot's normal stacking reads
    // oddly against a combo drill; the other drills get the real bot
    drill: { fourwide: 'garbage', free: 'bot', allspin: 'bot' },
  },
};

// predates the app's renames (→tetr.ai→tetr.lol) — kept so existing settings survive
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
      palette: { ...def.palette, ...parsed.palette, custom: { ...parsed.palette?.custom } },
      background: { ...def.background, ...parsed.background },
      evalDrill: { ...def.evalDrill, ...parsed.evalDrill },
      versus: {
        ...def.versus,
        ...parsed.versus,
        drill: { ...def.versus.drill, ...parsed.versus?.drill },
        rules: { ...def.versus.rules, ...parsed.versus?.rules },
      },
    };
    // migrations: undo moved to Ctrl+Z, ControlLeft freed from rotateCCW
    if (merged.binds.undo.length === 1 && merged.binds.undo[0] === 'Backspace') {
      merged.binds.undo = ['Ctrl+KeyZ'];
    }
    merged.binds.rotateCCW = merged.binds.rotateCCW.filter((c) => c !== 'ControlLeft');
    if (merged.binds.rotateCCW.length === 0) merged.binds.rotateCCW = ['KeyZ'];
    // migration: autoRestartTki never shipped a UI and was never read
    delete (merged as unknown as Record<string, unknown>).autoRestartTki;
    // migration: cancelDasOnDirChange inverted into dasCarry (default off, no bounce)
    delete (merged.handling as unknown as Record<string, unknown>).cancelDasOnDirChange;
    // migration: the 'auto' theme was removed — keep the user's light/dark look
    if (merged.palette.preset === 'auto') {
      merged.palette.preset = merged.theme === 'light' ? 'latte' : 'mocha';
    }
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
