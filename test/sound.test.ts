import { describe, it, expect } from 'vitest';
import { b2bCue } from '../src/ui/sound';

describe('progressive B2B jingle', () => {
  it('is silent before the first back-to-back', () => {
    expect(b2bCue(0)).toBeNull();
    expect(b2bCue(1)).toBeNull(); // one special clear isn't back-to-back yet
  });

  it('steps through all three samples one per level (btb_3 by B2B ×3)', () => {
    expect(b2bCue(2)!.name).toBe('btb_1'); // B2B ×1
    expect(b2bCue(3)!.name).toBe('btb_2'); // ×2
    expect(b2bCue(4)!.name).toBe('btb_3'); // ×3 — the "high" sound is heard early
    expect(b2bCue(9)!.name).toBe('btb_3'); // stays on the top tier
    expect(b2bCue(25)!.name).toBe('btb_3');
  });

  it('the first three levels play at base pitch, then the top tier climbs', () => {
    expect(b2bCue(2)!.rate).toBeCloseTo(1, 5); // ×1 btb_1
    expect(b2bCue(3)!.rate).toBeCloseTo(1, 5); // ×2 btb_2
    expect(b2bCue(4)!.rate).toBeCloseTo(1, 5); // ×3 btb_3
    expect(b2bCue(5)!.rate).toBeGreaterThan(1); // ×4 btb_3 pitched up
    expect(b2bCue(20)!.rate).toBeGreaterThan(b2bCue(8)!.rate); // keeps rising
    expect(b2bCue(100)!.rate).toBeLessThanOrEqual(2); // capped
  });
});
