import type { Grade } from '../engine/grade';

export type Mode = 'lst' | 'fourwide' | 'free' | 'quick' | 'allspin' | 'versus';

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
  /** 4-wide drill: longest combo */
  maxCombo?: number;
  /** all-spin drill: longest back-to-back chain */
  maxB2b?: number;
  /** 40 lines sprint: clear time — only present when the run reached 40 lines */
  sprintMs?: number;
  /** 1v1 vs Cold Clear: rounds taken by each side */
  wins?: number;
  losses?: number;
  /** pieces per second over the active part of the session (first input → last lock) */
  pps?: number;
}

export interface AllStats {
  modes: Record<Mode, ModeStats>;
  sessions: SessionRecord[];
}

// predates the app's renames (→tetr.ai→tetr.lol) — kept so existing stats survive
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
      for (const m of ['lst', 'fourwide', 'free', 'quick', 'allspin', 'versus'] as Mode[]) {
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
  return { modes: { lst: emptyMode(), fourwide: emptyMode(), free: emptyMode(), quick: emptyMode(), allspin: emptyMode(), versus: emptyMode() }, sessions: [] };
}

export const stats = loadStats();

export function saveStats(): void {
  localStorage.setItem(KEY, JSON.stringify(stats));
}

/** Wipe everything the charts and tables draw from — a fresh start. */
export function resetStats(): void {
  for (const m of Object.keys(stats.modes) as Mode[]) stats.modes[m] = emptyMode();
  stats.sessions.length = 0;
  saveStats();
}

export function recordSession(rec: SessionRecord): void {
  stats.sessions.push(rec);
  if (stats.sessions.length > MAX_SESSIONS) stats.sessions.splice(0, stats.sessions.length - MAX_SESSIONS);
  saveStats();
}

/** "1:23.4" — sprint clock; tenths shown by default, off for axis ticks */
export function fmtSprint(ms: number, tenths = true): string {
  const t = ms / 1000;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return tenths ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.round(s)).padStart(2, '0')}`;
}

export function gradeTotal(g: Record<Grade, number>): number {
  return g.best + g.good + g.inaccuracy + g.mistake + g.killer;
}

export function gradeAccuracy(g: Record<Grade, number>): number {
  const total = gradeTotal(g);
  if (total === 0) return 0;
  return (g.best + 0.7 * g.good + 0.3 * g.inaccuracy) / total;
}

/** Session PPS: recorded live value, else derived from the run duration. */
export function sessionPps(s: SessionRecord): number | null {
  if (s.pps !== undefined && isFinite(s.pps)) return s.pps;
  if (s.durationMs > 0 && s.pieces >= 2) return s.pieces / (s.durationMs / 1000);
  return null;
}

export function accuracy(m: ModeStats): number {
  return gradeAccuracy(m.grades);
}
