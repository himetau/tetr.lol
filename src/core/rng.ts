import { PIECE_TYPES, type PieceType } from './pieces';

/** mulberry32 - small seedable PRNG, good enough for bag shuffling. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Full bag state - PRNG word + undrawn pieces. Restorable so undo can rewind draws. */
export interface BagState {
  a: number;
  queue: PieceType[];
}

export class SevenBag {
  private a: number;
  private queue: PieceType[] = [];

  constructor(seed?: number) {
    this.a = (seed ?? Math.random() * 2 ** 32) >>> 0;
  }

  private rand(): number {
    this.a = (this.a + 0x6d2b79f5) | 0;
    let t = Math.imul(this.a ^ (this.a >>> 15), 1 | this.a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private refill(): void {
    const bag = [...PIECE_TYPES];
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    this.queue.push(...bag);
  }

  next(): PieceType {
    if (this.queue.length === 0) this.refill();
    return this.queue.shift()!;
  }

  peek(n: number): PieceType[] {
    while (this.queue.length < n) this.refill();
    return this.queue.slice(0, n);
  }

  getState(): BagState {
    return { a: this.a, queue: [...this.queue] };
  }

  setState(s: BagState): void {
    this.a = s.a;
    this.queue = [...s.queue];
  }
}
