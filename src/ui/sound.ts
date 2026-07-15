// Sample-backed SFX from a tetr.io soundpack (public/sfx/*.ogg, extracted
// by tools/extract-tpse-sfx.mjs from a .tpse). HTMLAudio (not fetch/WebAudio)
// so the packaged Electron build can play them from file://.
// The mistake thud stays synthesized — it is the trainer's own cue, not a
// game sound.

export type SfxName =
  | 'move' | 'rotate' | 'harddrop' | 'softdrop' | 'hold' | 'floor' | 'spin'
  | 'clearline' | 'clearquad' | 'clearspin' | 'clearbtb' | 'allclear'
  | 'btb_1' | 'btb_2' | 'btb_3' | 'btb_break' | 'combobreak'
  | 'garbage_in_small' | 'garbage_in_medium' | 'garbage_in_large'
  | 'garbagerise' | 'garbagesmash' | 'damage_alert'
  | 'topout' | 'go';

const cache = new Map<SfxName, HTMLAudioElement>();

export function sfx(name: SfxName, volume = 0.5): void {
  try {
    let a = cache.get(name);
    if (!a) {
      a = new Audio(`${import.meta.env.BASE_URL}sfx/${name}.ogg`);
      a.preload = 'auto';
      cache.set(name, a);
    }
    // reuse the cached element when idle, otherwise overlap with a clone
    const inst = a.paused ? a : (a.cloneNode() as HTMLAudioElement);
    inst.volume = volume;
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
    case 'right': sfx('move', 0.35); break;
    case 'rotateCW':
    case 'rotateCCW':
    case 'rotate180': sfx('rotate', 0.4); break;
    case 'softDrop': sfx('softdrop', 0.35); break;
    case 'hardDrop': sfx('harddrop', 0.5); break;
    case 'hold': sfx('hold', 0.45); break;
  }
}

/** Clear sound: spin/quad/line, B2B and all-clear aware. */
export function clearSound(lines: number, tspin: boolean, b2bChain = 0, allClear = false): void {
  if (allClear) {
    sfx('allclear', 0.6);
    return;
  }
  if (tspin) sfx(b2bChain > 1 ? 'clearbtb' : 'clearspin', 0.55);
  else if (lines >= 4) sfx(b2bChain > 1 ? 'clearbtb' : 'clearquad', 0.55);
  else sfx('clearline', 0.5);
  // tetr.io layers a rising B2B jingle as the chain grows
  if (b2bChain === 4) sfx('btb_1', 0.5);
  else if (b2bChain === 8) sfx('btb_2', 0.5);
  else if (b2bChain === 12) sfx('btb_3', 0.5);
}

export function b2bBreakSound(): void {
  sfx('btb_break', 0.55);
}

/** Piece settled without player hard-dropping (gravity lock). */
export function lockSound(): void {
  sfx('floor', 0.45);
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

let ctx: AudioContext | null = null;

function ac(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

/** Short low "thud" for mistakes (synth — trainer cue, not a game sound). */
export function mistakeSound(): void {
  try {
    const a = ac();
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(220, a.currentTime);
    o.frequency.exponentialRampToValueAtTime(110, a.currentTime + 0.12);
    g.gain.setValueAtTime(0.12, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.18);
    o.connect(g).connect(a.destination);
    o.start();
    o.stop(a.currentTime + 0.2);
  } catch {
    // audio unavailable; ignore
  }
}
