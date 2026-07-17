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

export function sfx(name: SfxName, volume = 0.5, cat: SfxCategory = 'alert'): void {
  try {
    const level = mixed(volume, cat);
    if (level <= 0) return;
    let a = cache.get(name);
    if (!a) {
      a = new Audio(`${import.meta.env.BASE_URL}sfx/${name}.ogg`);
      a.preload = 'auto';
      cache.set(name, a);
    }
    // reuse the cached element when idle, otherwise overlap with a clone
    const inst = a.paused ? a : (a.cloneNode() as HTMLAudioElement);
    inst.volume = level;
    inst.currentTime = 0;
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
    sfx('applause', 0.4, 'clear'); // the pack's allclear cue is short — layer the crowd
    return;
  }
  if (tspin) sfx(b2bChain > 1 ? 'clearbtb' : 'clearspin', 0.55, 'clear');
  else if (lines >= 4) sfx(b2bChain > 1 ? 'clearbtb' : 'clearquad', 0.55, 'clear');
  else sfx('clearline', 0.5, 'clear');
  // tetr.io layers a rising B2B jingle as the chain grows
  if (b2bChain === 4) sfx('btb_1', 0.5, 'clear');
  else if (b2bChain === 8) sfx('btb_2', 0.5, 'clear');
  else if (b2bChain === 12) sfx('btb_3', 0.5, 'clear');
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

/** Quick play run over — the full game-over jingle, not just the topout hit. */
export function gameOverSound(): void {
  sfx('gameover', 0.55);
}
