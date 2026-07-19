// Sample-backed SFX from a Tetris Friends soundpack (public/sfx/*.ogg,
// extracted by tools/extract-tpse-sfx.mjs from a .tpse). HTMLAudio (not
// fetch/WebAudio) so the packaged Electron build can play them from file://.
// Every sound plays on a mixer channel (move / clear / alert) scaled by the
// volume sliders in settings.

import { settings } from './settings';

export type SfxName =
  | 'move' | 'rotate' | 'harddrop' | 'softdrop' | 'hold' | 'floor' | 'spin'
  | 'clearline' | 'clearquad' | 'clearspin' | 'clearbtb' | 'allclear'
  | 'btb_1' | 'btb_2' | 'btb_3' | 'btb_break' | 'combobreak'
  | 'garbage_in_small' | 'garbage_in_medium' | 'garbage_in_large'
  | 'garbagerise' | 'garbagesmash' | 'damage_alert'
  | 'topout' | 'go'
  | 'no' | 'failure'
  | 'personalbest' | 'levelup' | 'gameover' | 'clutch' | 'applause' | 'hyperalert'
  | 'countdown1' | 'countdown2' | 'countdown3'
  | `combo_${number}` | `combo_${number}_power`;

const cache = new Map<SfxName, HTMLAudioElement>();

/** Mixer channel a sound plays on; 'master' skips the category slider. */
export type SfxCategory = 'move' | 'clear' | 'alert' | 'master';

/** Base volume × master slider × the sound's category slider. */
function mixed(base: number, cat: SfxCategory): number {
  const v = settings.volume;
  const catGain = cat === 'master' ? 1 : v[cat] / 100;
  return Math.max(0, Math.min(1, base * (v.master / 100) * catGain));
}

export function sfx(name: SfxName, volume = 0.5, cat: SfxCategory = 'alert', rate = 1): void {
  try {
    const level = mixed(volume, cat);
    if (!(level > 0)) return; // also guards NaN volumes
    const url = `${import.meta.env.BASE_URL}sfx/${name}.ogg`;
    let a = cache.get(name);
    if (!a) {
      a = new Audio(url);
      a.preload = 'auto';
      cache.set(name, a);
    }
    // reuse the cached element when idle; for an overlap use a FRESH element
    // (loads from the browser cache) - cloneNode()+currentTime on an unloaded
    // node throws in real browsers and silently drops the sound
    const fresh = !a.paused;
    const inst = fresh ? new Audio(url) : a;
    inst.volume = level;
    // let playbackRate shift pitch (default preservesPitch keeps it flat) - the
    // B2B jingle rides this to climb a little higher with every back-to-back
    inst.preservesPitch = false;
    inst.playbackRate = rate;
    // a fresh element already starts at 0; only rewind the reused (loaded) one
    if (!fresh) { try { inst.currentTime = 0; } catch { /* not seekable yet */ } }
    void inst.play().catch(() => { /* autoplay not unlocked yet */ });
  } catch {
    // audio unavailable; ignore
  }
}

/** Sound for a keyboard game action (call from InputHandler.onAction). */
export function actionSound(action: string): void {
  switch (action) {
    case 'left':
    case 'right': sfx('move', 0.35, 'move'); break;
    case 'rotateCW':
    case 'rotateCCW':
    case 'rotate180': sfx('rotate', 0.4, 'move'); break;
    case 'softDrop': sfx('softdrop', 0.35, 'move'); break;
    case 'hardDrop': sfx('harddrop', 0.5, 'move'); break;
    case 'hold': sfx('hold', 0.45, 'move'); break;
  }
}

/** Clear sound: spin/quad/line, B2B and all-clear aware. */
export function clearSound(lines: number, tspin: boolean, b2bChain = 0, allClear = false): void {
  if (allClear) {
    sfx('allclear', 0.6, 'clear');
    sfx('applause', 0.4, 'clear'); // the pack's allclear cue is short - layer the crowd
    return;
  }
  if (tspin) sfx(b2bChain > 1 ? 'clearbtb' : 'clearspin', 0.55, 'clear');
  else if (lines >= 4) sfx(b2bChain > 1 ? 'clearbtb' : 'clearquad', 0.55, 'clear');
  else sfx('clearline', 0.5, 'clear');
  // the rising B2B jingle (b2bSound) is layered by the caller, which knows
  // whether this clear actually kept the back-to-back chain going
}

/**
 * The sample + pitch for a back-to-back at `chain` (pure, so it can be tested).
 * Steps up through the three sampled tiers (btb_1 → btb_2 → btb_3) as the chain
 * grows and pitches ~a semitone higher within each tier, so the top tier keeps
 * rising indefinitely instead of the sound only firing at a few fixed
 * milestones. Returns null below the first audible back-to-back.
 */
export function b2bCue(chain: number): { name: SfxName; rate: number } | null {
  if (chain < 2) return null; // back-to-back begins at the second consecutive special
  const n = chain - 1;        // audible level: B2B ×1, ×2, ×3, …
  // the three distinct samples climb one per level (so btb_3 - the "high" one -
  // is heard by B2B ×3), then the top tier keeps pitching up a semitone/level
  if (n <= 3) return { name: `btb_${n}` as SfxName, rate: 1 };
  return { name: 'btb_3', rate: Math.min(2, 2 ** ((n - 3) / 12)) };
}

/** Progressive back-to-back jingle, tetr.io style: climbs with the chain. */
export function b2bSound(chain: number): void {
  const cue = b2bCue(chain);
  if (cue) sfx(cue.name, 0.5, 'clear', cue.rate);
}

/** Escalating combo jingle; "power" clears (spin/quad) get the loud variant. */
export function comboSound(combo: number, power = false): void {
  const n = Math.max(1, Math.min(16, combo));
  sfx(power ? `combo_${n}_power` : `combo_${n}`, 0.45, 'clear');
}

/** Mistake cue for a graded piece (gate on soundOnMistake at the call site). */
export function gradeSound(grade: 'mistake' | 'killer'): void {
  sfx(grade === 'killer' ? 'failure' : 'no', grade === 'killer' ? 0.5 : 0.55);
}

export function b2bBreakSound(): void {
  sfx('btb_break', 0.55, 'clear');
}

/** The offensive burst when a big back-to-back is cashed out as a surge - a
 * heavy slam plus a bright rising tone, layered on the break sound; a crowd
 * roars in for the huge ones. `lines` is the surge size. */
export function surgeSound(lines: number): void {
  const big = Math.min(1, lines / 12);
  sfx('garbagesmash', 0.55 + 0.15 * big, 'clear');
  sfx('btb_3', 0.5, 'clear', 1.25); // bright surge tone on top
  if (lines >= 8) sfx('applause', 0.4, 'clear');
}

/** A big attack was sent - an escalating slam that hits harder and pitches up
 * the more lines went out (`lines`), for the "spike" feel. */
export function bigSendSound(lines: number): void {
  const t = Math.min(1, (lines - BIG_SEND_MIN) / 12); // 0 at threshold → 1 at +12
  sfx('garbagesmash', 0.4 + 0.25 * t, 'clear', 1 + 0.18 * t);
  if (lines >= 12) sfx('applause', 0.35, 'clear');
}

/** Attack size at which the "big send" sound + shaking number kick in (a full
 * clear's worth). Tune to taste to match tetr.io's spike feel. */
export const BIG_SEND_MIN = 4;

/** A piece was spun into place (T-spin or all-spin), clear or not. */
export function spinSound(): void {
  sfx('spin', 0.5, 'clear');
}

/** A running combo just ended without a clear. */
export function comboBreakSound(): void {
  sfx('combobreak', 0.5, 'clear');
}

/** Countdown beeps (3, 2, 1) before a run. */
export function countdownSound(n: 1 | 2 | 3): void {
  sfx(`countdown${n}` as SfxName, 0.5);
}

/** Countdown "go" at the start of a run. */
export function goSound(): void {
  sfx('go', 0.55);
}

/** Warning klaxon when a big wave of garbage is queued against you. */
export function damageAlertSound(): void {
  sfx('damage_alert', 0.55);
}

// ---- escalating incoming-garbage warnings -------------------------------
// three rising tiers off the pack's two alert samples: a klaxon when the
// incoming wave is high, a piercing alert when it is very high, and a
// panicked (pitched-up) alarm when letting it all through would top you out.

/** tier 1 - a high wave of garbage is incoming */
export function garbageHighSound(): void {
  sfx('damage_alert', 0.55);
}
/** tier 2 - the queued wave is very high */
export function garbageVeryHighSound(): void {
  sfx('hyperalert', 0.55);
}
/** tier 3 - letting the whole queue through would kill you */
export function garbageLethalSound(): void {
  sfx('hyperalert', 0.6, 'alert', 1.4); // pitched up into a panic
  sfx('damage_alert', 0.45);            // layered klaxon underneath
}

/**
 * Rising-edge tracker for the three incoming-garbage warnings, so each klaxon
 * fires once when its threshold is first crossed (not every frame). Feed it the
 * current queued line count and whether letting the whole queue through tops
 * you out; it plays the right escalating alarm and reports the lethal state
 * (for the on-screen "!" warning).
 */
export class GarbageWarner {
  private high = false;
  private veryHigh = false;
  private lethal = false;

  /** thresholds: "high" and "very high" queued line counts */
  constructor(private highAt = 8, private veryHighAt = 16) {}

  update(queued: number, willTopOut: boolean, soundOn: boolean): boolean {
    if (willTopOut) {
      if (!this.lethal && soundOn) garbageLethalSound();
    } else if (queued >= this.veryHighAt) {
      if (!this.veryHigh && soundOn) garbageVeryHighSound();
    } else if (queued >= this.highAt) {
      if (!this.high && soundOn) garbageHighSound();
    }
    this.high = queued >= this.highAt;
    this.veryHigh = queued >= this.veryHighAt;
    this.lethal = willTopOut;
    return willTopOut;
  }

  reset(): void {
    this.high = this.veryHigh = this.lethal = false;
  }
}

/** The stack has climbed into the danger zone. */
export function dangerSound(): void {
  sfx('hyperalert', 0.5);
}

/** A clear blocked a big wave of incoming garbage just in time. */
export function clutchSound(): void {
  sfx('clutch', 0.55);
}

/** Quick play: climbed into a new floor. */
export function levelUpSound(): void {
  sfx('levelup', 0.55);
}

/** Beat your own record (altitude, combo, …). */
export function personalBestSound(): void {
  sfx('personalbest', 0.5);
}

/** Piece settled without player hard-dropping (gravity lock). */
export function lockSound(): void {
  sfx('floor', 0.45, 'move');
}

/** Garbage got queued against you (telegraph). */
export function garbageQueuedSound(lines: number): void {
  sfx(lines <= 2 ? 'garbage_in_small' : lines <= 5 ? 'garbage_in_medium' : 'garbage_in_large', 0.5);
}

/** Garbage rows entering the field. */
export function garbageSound(rows: number): void {
  sfx(rows >= 4 ? 'garbagesmash' : 'garbagerise', 0.55);
}

export function topoutSound(): void {
  sfx('topout', 0.55);
}

/** Quick play run over - the full game-over jingle, not just the topout hit. */
export function gameOverSound(): void {
  sfx('gameover', 0.55);
}
