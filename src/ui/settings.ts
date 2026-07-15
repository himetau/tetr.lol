import { DEFAULT_HANDLING, DEFAULT_KEYBINDS, type HandlingSettings, type Keybinds } from '../core/handling';

export interface AppSettings {
  handling: HandlingSettings;
  binds: Keybinds;
  theme: 'light' | 'dark';
  boardZoom: number; // percent, 60..160
  ghost: boolean;
  grid: boolean;
  stopOnMistake: boolean;
  soundOnMistake: boolean;
  soundFx: boolean;
  autoRetryTopOut: boolean;
  feedbackLevel: 'all' | 'mistakes' | 'off';
}

export const DEFAULT_SETTINGS: AppSettings = {
  handling: { ...DEFAULT_HANDLING },
  binds: structuredClone(DEFAULT_KEYBINDS),
  theme: 'dark',
  boardZoom: 100,
  ghost: true,
  grid: true,
  stopOnMistake: false,
  soundOnMistake: true,
  soundFx: true,
  autoRetryTopOut: false,
  feedbackLevel: 'all',
};

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
