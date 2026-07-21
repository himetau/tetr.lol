import { describe, it, expect } from "vitest";
import { lstTier } from "../src/engine/lst-tier";
import LST_QUAD_RUNS from "../src/data/lst-quad-runs.json";

describe("lstTier", () => {
  it("buckets by clear count, boundaries inclusive", () => {
    expect(lstTier(14).name).toBe("warmup");
    expect(lstTier(17).name).toBe("warmup");
    expect(lstTier(18).name).toBe("standard");
    expect(lstTier(23).name).toBe("standard");
    expect(lstTier(24).name).toBe("long");
    expect(lstTier(29).name).toBe("long");
    expect(lstTier(30).name).toBe("showcase");
    expect(lstTier(37).name).toBe("showcase");
  });

  it("classifies every pool seed (never throws, always names a tier)", () => {
    const stats = LST_QUAD_RUNS.stats as unknown as Record<string, { clears: number }>;
    for (const seed of Object.keys(stats)) {
      const t = lstTier(stats[seed].clears);
      expect(t.name, `seed ${seed}`).toBeTruthy();
      expect(stats[seed].clears).toBeGreaterThanOrEqual(t.min);
    }
  });
});
