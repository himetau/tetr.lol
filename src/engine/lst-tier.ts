// Difficulty tier for a verified LST(+quad) run, from its clear count. The quad
// pool spreads 14..37+ clears; a fixed 20-TSD framing hides that a dealt seed
// might be a quick 14 or a 31-TSD showcase. Tiers let the drill say what you're
// getting and (later) pick by difficulty. Pure + data-driven so it's testable
// and has no DOM deps.

export interface LstTier {
  /** short label shown to the player */
  name: string;
  /** inclusive lower bound on clears for this tier */
  min: number;
}

// Ordered high -> low; first whose `min` is met wins. Thresholds picked from the
// pool distribution (most seeds 14-18, showcase seeds 30+).
const TIERS: LstTier[] = [
  { name: "showcase", min: 30 },
  { name: "long", min: 24 },
  { name: "standard", min: 18 },
  { name: "warmup", min: 0 },
];

/** Difficulty tier for a run of `clears` total clears (TSDs + quads). */
export function lstTier(clears: number): LstTier {
  return TIERS.find((t) => clears >= t.min) ?? TIERS[TIERS.length - 1];
}
