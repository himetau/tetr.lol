// Cold Clear 2 evaluation profiles. The wasm `ColdClear` constructor takes a
// `BotConfig` JSON override (see build/cold-clear-2/src/api.rs); these are the
// profiles we hand it. Tuning lives here in TS - no wasm rebuild needed to
// adjust a weight, only to add a brand-new field.

export interface CC2Weights {
  cell_coveredness: number;
  max_cell_covered_height: number;
  holes: number;
  row_transitions: number;
  height: number;
  height_upper_half: number;
  height_upper_quarter: number;
  tetris_well_depth: number;
  tslot: [number, number, number, number];
  has_back_to_back: number;
  wasted_t: number;
  softdrop: number;
  normal_clears: [number, number, number, number, number];
  mini_spin_clears: [number, number, number];
  spin_clears: [number, number, number, number];
  back_to_back_clear: number;
  combo_attack: number;
  perfect_clear: number;
  perfect_clear_override: boolean;
}

export interface CC2Config {
  freestyle_weights: CC2Weights;
  freestyle_exploitation: number;
}

/** Stock Cold Clear 2 weights (build/cold-clear-2/src/default.json). */
export const CC2_DEFAULT: CC2Config = {
  freestyle_weights: {
    cell_coveredness: -0.2,
    max_cell_covered_height: 6,
    holes: -1.5,
    row_transitions: -0.2,
    height: -0.4,
    height_upper_half: -1.5,
    height_upper_quarter: -5.0,
    tetris_well_depth: 0.3,
    tslot: [0.1, 1.5, 2.0, 4.0],
    has_back_to_back: 0.5,
    wasted_t: -1.5,
    softdrop: -0.2,
    normal_clears: [0.0, -2.0, -1.5, -1.0, 3.5],
    mini_spin_clears: [0.0, -1.5, -1.0],
    spin_clears: [0.0, 1.0, 4.0, 6.0],
    back_to_back_clear: 1.0,
    combo_attack: 1.5,
    perfect_clear: 15.0,
    perfect_clear_override: true,
  },
  freestyle_exploitation: 0.6931471805599453,
};

/**
 * LST-loop profile: bias hard toward a perpetual clean TSD loop.
 *  - never waste a T: both a flat T (wasted_t) and a T-spin *single* are
 *    punished, because the drill goal counts anything but a full TSD as a
 *    wasted T - hold the T for a double instead
 *  - always keep a T-slot standing (boosted tslot ladder)
 *  - reward the TSD above all else
 *  - punish every non-spin clear, the quad included (off the plan)
 *  - value keeping back-to-back; keep the stack low and hole-free
 *  - stop chasing perfect clears (a PC would just end the loop board)
 */
export const CC2_LST_LOOP: CC2Config = {
  freestyle_weights: {
    ...CC2_DEFAULT.freestyle_weights,
    holes: -3.0,
    tslot: [0.5, 3.0, 4.5, 6.0],
    has_back_to_back: 1.5,
    wasted_t: -8.0,
    normal_clears: [0.0, -6.0, -6.0, -6.0, -4.0],
    mini_spin_clears: [0.0, -3.0, -3.0],
    // index 1 = T-spin single: negative so the bot saves the T for a double
    spin_clears: [0.0, -3.0, 9.0, 9.0],
    back_to_back_clear: 2.0,
    perfect_clear: 4.0,
    perfect_clear_override: false,
  },
  freestyle_exploitation: CC2_DEFAULT.freestyle_exploitation,
};

export const CC2_LST_LOOP_JSON = JSON.stringify(CC2_LST_LOOP);
