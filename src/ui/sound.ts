let ctx: AudioContext | null = null;

function ac(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

function tone(freq: number, dur: number, gain: number, type: OscillatorType, delay = 0, glideTo?: number): void {
  try {
    const a = ac();
    const t = a.currentTime + delay;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + dur * 0.7);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  } catch {
    // audio unavailable; ignore
  }
}

/** Short low "thud" for mistakes. */
export function mistakeSound(): void {
  tone(220, 0.18, 0.12, 'triangle', 0, 110);
}

/** Soft tick when a piece locks without clearing. */
export function lockSound(): void {
  tone(1400, 0.035, 0.045, 'square');
}

/** Chime on line clears; spins get a brighter two-note rise. */
export function clearSound(lines: number, tspin: boolean): void {
  if (tspin) {
    tone(660, 0.09, 0.07, 'triangle');
    tone(lines >= 2 ? 1046 : 880, 0.14, 0.08, 'triangle', 0.07);
  } else {
    tone(lines >= 4 ? 784 : 523 + lines * 60, 0.1, 0.06, 'triangle');
  }
}

/** Rising rumble when garbage rows enter the field. */
export function garbageSound(rows: number): void {
  tone(90, 0.16 + Math.min(rows, 6) * 0.02, 0.1, 'sawtooth', 0, 60);
}
