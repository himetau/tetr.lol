import type { Grade } from '../engine/grade';

export type Mode = 'lst' | 'free' | 'quick';

export interface ModeStats {
  pieces: number;
  grades: Record<Grade, number>;
  tsds: number;
  tsses: number;
  drills: number;
}

/** One finished drill/run, kept for the progress-over-time charts. */
export interface SessionRecord {
  at: string;                 // ISO time the session ended
  mode: Mode;
  pieces: number;
  tsds: number;
  grades: Record<Grade, number>;
  durationMs: number;
  /** quick play: meters reached */
  altitude?: number;
}

export interface AllStats {
  modes: Record<Mode, ModeStats>;
  sessions: SessionRecord[];
}

const KEY = 'lst-trainer-stats-v1';
const MAX_SESSIONS = 300;

export function emptyGrades(): Record<Grade, number> {
  return { best: 0, good: 0, inaccuracy: 0, mistake: 0, killer: 0 };
}

function emptyMode(): ModeStats {
  return { pieces: 0, grades: emptyGrades(), tsds: 0, tsses: 0, drills: 0 };
}

export function loadStats(): AllStats {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AllStats & { modes: { tki?: ModeStats } };
      for (const m of ['lst', 'free', 'quick'] as Mode[]) {
        parsed.modes[m] = { ...emptyMode(), ...parsed.modes[m], grades: { ...emptyGrades(), ...parsed.modes[m]?.grades } };
      }
      parsed.sessions ??= [];
      // migration: the old separate TKI drill merged into the LST drill
      const tki = parsed.modes.tki;
      if (tki) {
        const lst = parsed.modes.lst;
        lst.pieces += tki.pieces ?? 0;
        lst.tsds += tki.tsds ?? 0;
        lst.tsses += tki.tsses ?? 0;
        lst.drills += tki.drills ?? 0;
        for (const g of Object.keys(lst.grades) as (keyof ModeStats['grades'])[]) {
          lst.grades[g] += tki.grades?.[g] ?? 0;
        }
        delete parsed.modes.tki;
      }
      return parsed;
    }
  } catch { /* fall through */ }
  return { modes: { lst: emptyMode(), free: emptyMode(), quick: emptyMode() }, sessions: [] };
}

export const stats = loadStats();

export function saveStats(): void {
  localStorage.setItem(KEY, JSON.stringify(stats));
}

export function recordSession(rec: SessionRecord): void {
  stats.sessions.push(rec);
  if (stats.sessions.length > MAX_SESSIONS) stats.sessions.splice(0, stats.sessions.length - MAX_SESSIONS);
  saveStats();
}

export function gradeAccuracy(g: Record<Grade, number>): number {
  const total = g.best + g.good + g.inaccuracy + g.mistake + g.killer;
  if (total === 0) return 0;
  return (g.best + 0.7 * g.good + 0.3 * g.inaccuracy) / total;
}

export function accuracy(m: ModeStats): number {
  return gradeAccuracy(m.grades);
}
