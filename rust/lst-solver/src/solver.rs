//! Perfect-fill LST loop solver. Faithful port of src/engine/lst-solver.ts.
//!
//! Limited-discrepancy search over TSD cycles. Every candidate score and cycle
//! cost is integer-valued, so with a node budget (not a wall-clock deadline)
//! the search is fully deterministic and reproduces the TS solver's exact line
//! and node count. The SOLVE_CACHE / debug logging of the TS version are
//! omitted (pure memoization / diagnostics; they do not change results).

use crate::board::{Board, BOARD_W};
use crate::enumerate::{enumerate_placements, Placement};
use crate::eval::{
    find_lst_site, mirror_board, mirror_piece, quad_well_depth, stack_side_imbalance, LST_SPIN_COL,
};
use crate::masks::{drop_y, shape};
use crate::pieces::{cells_at, Cell, PieceType};
use crate::spin::SpinKind;
use instant::Instant;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

const HEIGHT_CAP: i32 = 18;
const MAX_PIECES_PER_CYCLE: i32 = 16;
const MAX_NOTCH_HOLES: i32 = 4;
const DIAG_OVERHANG_COST: i64 = 30;
const O_NOTCH_COST: i64 = 60;

const WELL_BIT: u32 = 1 << LST_SPIN_COL;
const SLOT_BITS: u32 = 0b111 << (LST_SPIN_COL - 1);

// RANK_WEIGHTS (kept identical to lst-solver.ts — ranking quality = node count).
struct RankWeights {
    bump: i64,
    max: i64,
    notch: i64,
    missing_hi: i64,
    missing_lo: i64,
    missing_cyc: i64,
    misfit: i64,
    canyon: i64,
    roof: i64,
    lag: i64,
}
const W: RankWeights = RankWeights {
    bump: 3,
    max: 5,
    notch: 4,
    missing_hi: 110,
    missing_lo: 25,
    missing_cyc: 6,
    misfit: 500,
    canyon: 70,
    roof: 12,
    lag: 1500,
};

#[derive(Clone)]
pub struct Opts {
    pub budget_ms: u64,
    pub node_budget: i64,
    pub max_branch: usize,
    pub cycle_solutions: i64,
    pub cycle_node_cap: i64,
    pub tail_free: i32,
    pub max_disc: i32,
    pub frontier_band: i32,
    pub allow_quad: bool,
    /// S/Z reserve toll (0 = off); see TS SolveOptions.szReserve.
    pub sz_reserve: i64,
    /// Prefer the healthiest equal-depth partial line (fewest pieces consumed,
    /// then lowest stack-side imbalance); see TS SolveOptions.partialHealth.
    /// Changes only which line is remembered, never the search itself.
    pub partial_health: bool,
}

impl Default for Opts {
    fn default() -> Self {
        Opts {
            budget_ms: 8000,
            node_budget: 4_000_000,
            max_branch: 12,
            cycle_solutions: 24,
            cycle_node_cap: 5000,
            tail_free: 2,
            max_disc: 64,
            frontier_band: 4,
            allow_quad: false,
            sz_reserve: 0,
            partial_health: false,
        }
    }
}

pub struct SolvedMove {
    pub piece: PieceType,
    pub cells: Vec<Cell>,
    pub spin: SpinKind,
    pub lines_cleared: i32,
    pub before_key: String,
    pub is_tsd: bool,
}

pub struct SolveResult {
    pub moves: Vec<SolvedMove>,
    pub tsds: i32,
    pub solved: bool,
    pub mirrored: bool,
    pub nodes: i64,
}

fn is_tsd(p: &Placement) -> bool {
    p.piece == PieceType::T && p.spin == SpinKind::Full && p.lines_cleared >= 2
}
fn is_quad(p: &Placement) -> bool {
    p.piece == PieceType::I && p.lines_cleared == 4
}
fn is_clear(p: &Placement, allow_quad: bool) -> bool {
    is_tsd(p) || (allow_quad && is_quad(p))
}

const INF_Y: i32 = i32::MAX;

struct Audit {
    bad: i32,
    notch: i32,
    notch_min_y: i32,
}

fn audit_holes(board: &Board) -> Audit {
    let mut bad = 0;
    let mut notch = 0;
    let mut notch_min_y = INF_Y;
    for x in 0..BOARD_W {
        if x == LST_SPIN_COL {
            continue;
        }
        let h = board.column_height(x);
        for y in 0..h {
            if (board.rows[y as usize] >> x) & 1 == 0 {
                if x == LST_SPIN_COL - 1 || x == LST_SPIN_COL + 1 {
                    notch += 1;
                    if y < notch_min_y {
                        notch_min_y = y;
                    }
                } else {
                    bad += 1;
                }
            }
        }
    }
    Audit {
        bad,
        notch,
        notch_min_y,
    }
}

fn diagonal_overhangs(board: &Board, site_y: i32) -> i64 {
    let mut extra = 0i64;
    for c in [LST_SPIN_COL - 1, LST_SPIN_COL + 1] {
        let h = board.column_height(c);
        let mut covered = 0i64;
        for y in site_y..h {
            if (board.rows[y as usize] >> c) & 1 == 0 {
                covered += 1;
            }
        }
        if covered > 1 {
            extra += covered - 1;
        }
    }
    extra
}

// Exact transposition key. The TS solver keys on `String.fromCharCode(rows)` +
// qi + hold; keying on the raw rows array is the *same* equality partition
// (rows above maxHeight are always 0) with no string allocation, so dedup — and
// therefore the node count — is byte-for-byte unchanged. Verified against the
// parity fixtures (identical node counts).
type StateKey = ([u32; 26], usize, u8);

#[inline]
/// Exit quality of a partial line (lower better): pieces consumed dominate,
/// stack-side parity breaks ties. Mirrors healthOf in lst-solver.ts.
fn health_of(qi: usize, b: &Board) -> i64 {
    qi as i64 * 64 + stack_side_imbalance(b).abs() as i64
}

fn state_key(board: &Board, qi: usize, h: Option<PieceType>) -> StateKey {
    (board.rows, qi, h.map(|p| p.idx() as u8 + 1).unwrap_or(0))
}

fn surface_cost(board: &Board, notch_holes: i64) -> i64 {
    let mut hh = [0i32; BOARD_W as usize];
    for x in 0..BOARD_W {
        hh[x as usize] = board.column_height(x);
    }
    let mut bump = 0i64;
    for x in (LST_SPIN_COL + 2)..(BOARD_W - 1) {
        bump += (hh[x as usize] - hh[(x + 1) as usize]).abs() as i64;
    }
    let mut max = 0i64;
    for x in 0..BOARD_W {
        if x != LST_SPIN_COL {
            max = max.max(hh[x as usize] as i64);
        }
    }
    let site = find_lst_site(board);
    let missing = site.map(|s| s.missing as i64).unwrap_or(20);
    let roof = if site.map(|s| s.roof_ready).unwrap_or(false) {
        W.roof
    } else {
        0
    };
    let diag = site
        .map(|s| diagonal_overhangs(board, s.y) * DIAG_OVERHANG_COST)
        .unwrap_or(0);
    bump * W.bump + max * W.max + notch_holes * W.notch + missing * W.missing_lo - roof + diag
}

/// overlaySite: findLstSite on (parent rows + a small placement overlay).
/// `ov` is the placement's per-row bit contributions (one entry per span,
/// distinct rows, at most 4) — a linear scan beats a HashMap for this size.
fn overlay_site(
    rows: &[u32; 26],
    ov: &[(i32, u32)],
    heights: &[i32; BOARD_W as usize],
    max_h: i32,
) -> Option<(i32, i32, bool)> {
    let row = |y: i32| -> u32 {
        let base = if y >= 0 && y < 26 { rows[y as usize] } else { 0 };
        let extra = ov
            .iter()
            .find_map(|&(ry, b)| if ry == y { Some(b) } else { None })
            .unwrap_or(0);
        base | extra
    };
    for y in 0..=max_h {
        let r0 = row(y);
        if (r0 & WELL_BIT) != 0 {
            return None;
        }
        let r1 = row(y + 1);
        if (r1 & SLOT_BITS) != 0 {
            continue;
        }
        let mut missing = 0;
        let mut reachable = true;
        let mut x = 0;
        while x < BOARD_W && reachable {
            if x != LST_SPIN_COL && (r0 >> x) & 1 == 0 {
                missing += 1;
                if heights[x as usize] > y + 1 {
                    reachable = false;
                }
            }
            if x != 1 && x != LST_SPIN_COL && x != 3 && (r1 >> x) & 1 == 0 {
                missing += 1;
                if heights[x as usize] > y + 2 {
                    reachable = false;
                }
            }
            x += 1;
        }
        if !reachable {
            continue;
        }
        let r2 = row(y + 2);
        let roof_ready = (r2 >> 1) & 1 == 1 || (r2 >> 3) & 1 == 1;
        return Some((y, missing, roof_ready));
    }
    None
}

fn rots_for(piece: PieceType) -> &'static [usize] {
    match piece {
        PieceType::O => &[0],
        PieceType::I | PieceType::S | PieceType::Z => &[0, 1],
        _ => &[0, 1, 2, 3],
    }
}

fn fits_somewhere(hh: &[i32; BOARD_W as usize], frontier: i32, piece: PieceType, opts: &Opts) -> bool {
    for &rot in rots_for(piece) {
        let s = shape(piece, rot);
        let mut max_dy = 0;
        for sp in &s.spans {
            if sp.dy > max_dy {
                max_dy = sp.dy;
            }
        }
        let mut x = -s.min_dx;
        while x < BOARD_W - s.max_dx {
            if x + s.min_dx <= LST_SPIN_COL && x + s.max_dx >= LST_SPIN_COL {
                x += 1;
                continue;
            }
            let mut y = 0;
            for &(dx, dy) in &s.bottom {
                let rest = hh[(x + dx) as usize] - dy;
                if rest > y {
                    y = rest;
                }
            }
            if y + max_dy > frontier + opts.frontier_band || y + max_dy >= HEIGHT_CAP {
                x += 1;
                continue;
            }
            let mut ok = true;
            for &(dx, dy) in &s.bottom {
                let col = x + dx;
                if y + dy > hh[col as usize] && col != LST_SPIN_COL - 1 && col != LST_SPIN_COL + 1 {
                    ok = false;
                    break;
                }
            }
            if ok {
                return true;
            }
            x += 1;
        }
    }
    false
}

struct Candidate {
    p: Option<Placement>,
    piece: PieceType,
    rot: usize,
    x: i32,
    y: i32,
    uses_hold: bool,
    next_hold: Option<PieceType>,
    next_qi: usize,
    score: i64,
}

#[allow(clippy::too_many_arguments)]
fn candidates(
    b: &Board,
    heights: &[i32; BOARD_W as usize],
    audit0: &Audit,
    piece: PieceType,
    uses_hold: bool,
    next_hold: Option<PieceType>,
    next_qi: usize,
    frontier: i32,
    site_missing: i32,
    t_pressure: bool,
    queue: &[PieceType],
    opts: &Opts,
) -> Vec<Candidate> {
    let mut out: Vec<Candidate> = Vec::new();
    if piece == PieceType::T {
        if site_missing != 0 {
            return out;
        }
        for p in enumerate_placements(b, PieceType::T) {
            if !is_tsd(&p) {
                continue;
            }
            let audit = audit_holes(&p.after);
            if audit.bad > audit0.bad {
                continue;
            }
            let next_site = find_lst_site(&p.after);
            if let Some(ns) = next_site {
                if audit.notch_min_y < ns.y {
                    continue;
                }
            }
            let score = 1_000_000 - surface_cost(&p.after, audit.notch as i64);
            out.push(Candidate {
                p: Some(p.clone()),
                piece,
                rot: p.rot,
                x: p.x,
                y: p.y,
                uses_hold,
                next_hold,
                next_qi,
                score,
            });
        }
        return out;
    }

    // the well quad
    if opts.allow_quad && piece == PieceType::I && quad_well_depth(b) >= 4 {
        for p in enumerate_placements(b, PieceType::I) {
            if !is_quad(&p) || find_lst_site(&p.after).is_none() {
                continue;
            }
            let audit = audit_holes(&p.after);
            if audit.bad > audit0.bad {
                continue;
            }
            let score = 1_000_000 - surface_cost(&p.after, audit.notch as i64);
            out.push(Candidate {
                p: Some(p.clone()),
                piece,
                rot: p.rot,
                x: p.x,
                y: p.y,
                uses_hold,
                next_hold,
                next_qi,
                score,
            });
        }
    }

    // straight hard drops per (rot, x)
    for &rot in rots_for(piece) {
        let s = shape(piece, rot);
        let mut x = -s.min_dx;
        while x < BOARD_W - s.max_dx {
            if x + s.min_dx <= LST_SPIN_COL && x + s.max_dx >= LST_SPIN_COL {
                x += 1;
                continue;
            }
            let y = drop_y(b, piece, rot, x);
            let top = y + s.spans.iter().map(|sp| sp.dy).max().unwrap_or(0);
            if top > frontier + opts.frontier_band || top >= HEIGHT_CAP {
                x += 1;
                continue;
            }
            let mut notch = audit0.notch;
            let mut notch_min_y = audit0.notch_min_y;
            let mut bad = false;
            for &(dx, dy) in &s.bottom {
                let col = x + dx;
                let voids = y + dy - heights[col as usize];
                if voids > 0 {
                    if col == LST_SPIN_COL - 1 || col == LST_SPIN_COL + 1 {
                        notch += voids;
                        if heights[col as usize] < notch_min_y {
                            notch_min_y = heights[col as usize];
                        }
                    } else {
                        bad = true;
                        break;
                    }
                }
            }
            if bad || notch > MAX_NOTCH_HOLES {
                x += 1;
                continue;
            }
            // post-placement heights + row overlay
            let mut nh = [0i32; BOARD_W as usize];
            let mut max_h = 0;
            for i in 0..BOARD_W as usize {
                nh[i] = heights[i];
                if heights[i] > max_h {
                    max_h = heights[i];
                }
            }
            // per-row overlay bits: one entry per span (distinct rows, <=4)
            let mut ov: [(i32, u32); 4] = [(0, 0); 4];
            let mut ov_len = 0usize;
            for sp in &s.spans {
                let ry = y + sp.dy;
                ov[ov_len] = (ry, sp.bits << (x + sp.min_dx));
                ov_len += 1;
                let t = ry + 1;
                let mut cx = x + sp.min_dx;
                let hi = x + sp.max_dx;
                while cx <= hi {
                    if (sp.bits >> (cx - x - sp.min_dx)) & 1 == 1 && t > nh[cx as usize] {
                        nh[cx as usize] = t;
                        if t > max_h {
                            max_h = t;
                        }
                    }
                    cx += 1;
                }
            }
            let site = overlay_site(&b.rows, &ov[..ov_len], &nh, max_h);
            let (sy, s_missing, s_roof) = match site {
                Some(v) => v,
                None => {
                    x += 1;
                    continue;
                }
            };
            if notch_min_y < sy {
                x += 1;
                continue;
            }
            let mut bump = 0i64;
            let mut max = 0i64;
            for i in (LST_SPIN_COL + 2)..(BOARD_W - 1) {
                bump += (nh[i as usize] - nh[(i + 1) as usize]).abs() as i64;
            }
            for i in 0..BOARD_W {
                if i != LST_SPIN_COL && (nh[i as usize] as i64) > max {
                    max = nh[i as usize] as i64;
                }
            }
            let mut misfit = 0i64;
            for k in 0..3 {
                if let Some(&np) = queue.get(next_qi + k) {
                    if np != PieceType::T && !fits_somewhere(&nh, sy, np, opts) {
                        misfit += 1;
                    }
                }
            }
            let mut canyons = 0i64;
            for i in 0..BOARD_W {
                if i == LST_SPIN_COL {
                    continue;
                }
                let l = if i == 0 || i - 1 == LST_SPIN_COL {
                    99
                } else {
                    nh[(i - 1) as usize]
                };
                let r = if i == BOARD_W - 1 || i + 1 == LST_SPIN_COL {
                    99
                } else {
                    nh[(i + 1) as usize]
                };
                let depth = l.min(r) - nh[i as usize];
                if depth >= 2 {
                    canyons += (depth - 1) as i64;
                }
            }
            let missing_w = if t_pressure { W.missing_hi } else { W.missing_lo };
            let o_notch = if piece == PieceType::O
                && (x == LST_SPIN_COL - 2 || x == LST_SPIN_COL + 1)
            {
                O_NOTCH_COST
            } else {
                0
            };
            // S/Z reserve: an S/Z adding no notch void beside the well is stack-
            // side fill (a burned builder); toll it so the search reserves the
            // S/Z for the well-side overhang. See TS SolveOptions.szReserve.
            let sz_fill = if opts.sz_reserve != 0
                && (piece == PieceType::S || piece == PieceType::Z)
                && notch <= audit0.notch
            {
                opts.sz_reserve
            } else {
                0
            };
            let cost = bump * W.bump
                + max * W.max
                + (notch as i64) * W.notch
                + (s_missing as i64) * missing_w
                + misfit * W.misfit
                + canyons * W.canyon
                + o_notch
                + sz_fill
                - if s_roof { W.roof } else { 0 };
            out.push(Candidate {
                p: None,
                piece,
                rot,
                x,
                y,
                uses_hold,
                next_hold,
                next_qi,
                score: -cost - if uses_hold { 2 } else { 0 },
            });
            x += 1;
        }
    }
    out
}

fn surf_cost_of(b: &Board, qi: usize, queue: &[PieceType], opts: &Opts) -> i64 {
    let audit = audit_holes(b);
    let site = match find_lst_site(b) {
        Some(s) => s,
        None => return 1_000_000_000,
    };
    let mut hh = [0i32; BOARD_W as usize];
    for x in 0..BOARD_W {
        hh[x as usize] = b.column_height(x);
    }
    let mut bump = 0i64;
    let mut max = 0i64;
    for i in (LST_SPIN_COL + 2)..(BOARD_W - 1) {
        bump += (hh[i as usize] - hh[(i + 1) as usize]).abs() as i64;
    }
    for i in 0..BOARD_W {
        if i != LST_SPIN_COL && (hh[i as usize] as i64) > max {
            max = hh[i as usize] as i64;
        }
    }
    let mut canyons = 0i64;
    for i in 0..BOARD_W {
        if i == LST_SPIN_COL {
            continue;
        }
        let l = if i == 0 || i - 1 == LST_SPIN_COL {
            99
        } else {
            hh[(i - 1) as usize]
        };
        let r = if i == BOARD_W - 1 || i + 1 == LST_SPIN_COL {
            99
        } else {
            hh[(i + 1) as usize]
        };
        let depth = l.min(r) - hh[i as usize];
        if depth >= 2 {
            canyons += (depth - 1) as i64;
        }
    }
    let mut misfit = 0i64;
    for k in 0..3 {
        if let Some(&np) = queue.get(qi + k) {
            if np != PieceType::T && !fits_somewhere(&hh, site.y, np, opts) {
                misfit += 1;
            }
        }
    }
    let wall_lag = (site.y - hh[0].min(hh[1])).max(0) as i64;
    let mut lag_cost = wall_lag * 180;
    if wall_lag > 0 {
        let mut o_before_t = false;
        let mut k = 0;
        while k < queue.len() - qi {
            let np = queue[qi + k];
            if np == PieceType::T {
                break;
            }
            if np == PieceType::O {
                o_before_t = true;
                break;
            }
            k += 1;
        }
        if !o_before_t {
            lag_cost += W.lag;
        }
    }
    bump * W.bump
        + max * W.max
        + (audit.notch as i64) * W.notch
        + (site.missing as i64) * W.missing_cyc
        + misfit * W.misfit
        + canyons * W.canyon
        + lag_cost
        + diagonal_overhangs(b, site.y) * DIAG_OVERHANG_COST
}

#[derive(Clone)]
struct Step {
    p: Placement,
    // carried to mirror TS Step.usesHold; the solver output does not consume it.
    #[allow(dead_code)]
    uses_hold: bool,
}

struct CycleSol {
    steps: Vec<Step>,
    board: Board,
    qi: usize,
    hold: Option<PieceType>,
    cost: i64,
}

struct CycleCtx {
    sols: Vec<CycleSol>,
    seen_after: HashSet<StateKey>,
    seen_state: HashSet<StateKey>,
    steps: Vec<Step>,
    cycle_nodes: i64,
    sol_cap: usize,
    node_cap: i64,
    branch_cap: usize,
}

struct Search<'a> {
    queue: &'a [PieceType],
    target: i32,
    opts: &'a Opts,
    deadline: Instant,
    nodes: i64,
    aborted: bool,
    failed_at: HashMap<StateKey, i32>,
    line: Vec<Step>,
    best_line: Vec<Step>,
    best_tsds: i32,
    best_health: i64,
}

impl<'a> Search<'a> {
    fn dfs(&mut self, ctx: &mut CycleCtx, b: &Board, qi: usize, h: Option<PieceType>, depth: i32) {
        if ctx.sols.len() >= ctx.sol_cap || ctx.cycle_nodes > ctx.node_cap || self.aborted {
            return;
        }
        if qi >= self.queue.len() || depth > MAX_PIECES_PER_CYCLE {
            return;
        }
        if (self.nodes & 511) == 0 && Instant::now() > self.deadline {
            self.aborted = true;
            return;
        }
        if self.nodes > self.opts.node_budget {
            self.aborted = true;
            return;
        }
        let sk = state_key(b, qi, h);
        if ctx.seen_state.contains(&sk) {
            return;
        }
        ctx.seen_state.insert(sk);

        let audit0 = audit_holes(b);
        let site = find_lst_site(b);
        let frontier = site.map(|s| s.y).unwrap_or(0);
        let missing = site.map(|s| s.missing).unwrap_or(99);
        let mut heights = [0i32; BOARD_W as usize];
        for x in 0..BOARD_W {
            heights[x as usize] = b.column_height(x);
        }
        let cur = self.queue[qi];
        let t_pressure = cur == PieceType::T || h == Some(PieceType::T);
        let mut cands = candidates(
            b, &heights, &audit0, cur, false, h, qi + 1, frontier, missing, t_pressure, self.queue,
            self.opts,
        );
        if let Some(hh) = h {
            if hh != cur {
                cands.extend(candidates(
                    b, &heights, &audit0, hh, true, Some(cur), qi + 1, frontier, missing,
                    t_pressure, self.queue, self.opts,
                ));
            }
        } else if qi + 1 < self.queue.len() && self.queue[qi + 1] != cur {
            cands.extend(candidates(
                b, &heights, &audit0, self.queue[qi + 1], true, Some(cur), qi + 2, frontier,
                missing, t_pressure, self.queue, self.opts,
            ));
        }
        // stable sort by score descending
        cands.sort_by(|a, c| c.score.cmp(&a.score));
        if cands.len() > ctx.branch_cap {
            cands.truncate(ctx.branch_cap);
        }

        for c in cands {
            if ctx.sols.len() >= ctx.sol_cap {
                return;
            }
            ctx.cycle_nodes += 1;
            if ctx.cycle_nodes > ctx.node_cap {
                return;
            }
            if self.aborted {
                return;
            }
            self.nodes += 1;
            let p = match c.p {
                Some(p) => p,
                None => {
                    let cells = cells_at(c.piece, c.rot, c.x, c.y);
                    let mut after = *b;
                    after.place(&cells);
                    Placement {
                        piece: c.piece,
                        rot: c.rot,
                        x: c.x,
                        y: c.y,
                        cells,
                        spin: SpinKind::None,
                        lines_cleared: 0,
                        after,
                        path: Vec::new(),
                    }
                }
            };
            ctx.steps.push(Step {
                p: p.clone(),
                uses_hold: c.uses_hold,
            });
            if is_clear(&p, self.opts.allow_quad) {
                let k = state_key(&p.after, c.next_qi, c.next_hold);
                if !ctx.seen_after.contains(&k) {
                    ctx.seen_after.insert(k);
                    let cost = surf_cost_of(&p.after, c.next_qi, self.queue, self.opts);
                    ctx.sols.push(CycleSol {
                        steps: ctx.steps.clone(),
                        board: p.after,
                        qi: c.next_qi,
                        hold: c.next_hold,
                        cost,
                    });
                }
            } else {
                self.dfs(ctx, &p.after, c.next_qi, c.next_hold, depth + 1);
            }
            ctx.steps.pop();
        }
    }

    fn cycle_solutions(
        &mut self,
        b0: &Board,
        qi0: usize,
        h0: Option<PieceType>,
        widen: bool,
        disc: i32,
    ) -> Vec<CycleSol> {
        let grow = 1.0 + disc as f64 * 0.5;
        let sol_mult = if widen { 4.0 } else { 1.0 };
        let node_mult = if widen { 6.0 } else { 1.0 };
        let sol_cap = (self.opts.cycle_solutions as f64 * sol_mult * grow).ceil() as usize;
        let node_cap = (self.opts.cycle_node_cap as f64 * node_mult * grow).ceil() as i64;
        let mut ctx = CycleCtx {
            sols: Vec::new(),
            seen_after: HashSet::new(),
            seen_state: HashSet::new(),
            steps: Vec::new(),
            cycle_nodes: 0,
            sol_cap,
            node_cap,
            branch_cap: if widen { 32 } else { self.opts.max_branch },
        };
        self.dfs(&mut ctx, b0, qi0, h0, 0);
        // stable sort ascending by cost
        ctx.sols.sort_by(|a, c| a.cost.cmp(&c.cost));
        ctx.sols
    }

    fn run(&mut self, b: &Board, qi: usize, h: Option<PieceType>, tsds: i32, disc: i32) -> bool {
        if tsds >= self.target {
            return true;
        }
        if self.aborted {
            return false;
        }
        let key = state_key(b, qi, h);
        if let Some(&fd) = self.failed_at.get(&key) {
            if fd >= disc {
                return false;
            }
        }
        let in_tail = self.target - tsds <= self.opts.tail_free;
        let sols = self.cycle_solutions(b, qi, h, in_tail, disc);
        for i in 0..sols.len() {
            let cost = if in_tail || i == 0 { 0 } else { 1 };
            if cost > disc {
                break;
            }
            let steps = sols[i].steps.clone();
            let n = steps.len();
            self.line.extend(steps);
            if tsds + 1 > self.best_tsds {
                self.best_tsds = tsds + 1;
                self.best_line = self.line.clone();
                if self.opts.partial_health {
                    self.best_health = health_of(sols[i].qi, &sols[i].board);
                }
            } else if self.opts.partial_health && tsds + 1 == self.best_tsds {
                let hlth = health_of(sols[i].qi, &sols[i].board);
                if hlth < self.best_health {
                    self.best_health = hlth;
                    self.best_line = self.line.clone();
                }
            }
            if self.run(&sols[i].board, sols[i].qi, sols[i].hold, tsds + 1, disc - cost) {
                return true;
            }
            let new_len = self.line.len() - n;
            self.line.truncate(new_len);
            if self.aborted {
                return false;
            }
        }
        let fd = self.failed_at.get(&key).copied();
        if fd.is_none() || disc > fd.unwrap() {
            self.failed_at.insert(key, disc);
        }
        false
    }
}

/// Solve for `target` TSDs in canonical (left-well) space.
fn solve_canonical(
    board: &Board,
    queue: &[PieceType],
    hold: Option<PieceType>,
    target: i32,
    opts: &Opts,
) -> (Vec<Step>, i32, bool, i64) {
    let mut search = Search {
        queue,
        target,
        opts,
        deadline: Instant::now() + Duration::from_millis(opts.budget_ms),
        nodes: 0,
        aborted: false,
        failed_at: HashMap::new(),
        line: Vec::new(),
        best_line: Vec::new(),
        best_tsds: 0,
        best_health: 0,
    };
    let mut solved = false;
    let mut disc = 0;
    while !solved && !search.aborted && disc <= opts.max_disc {
        solved = search.run(board, 0, hold, 0, disc);
        disc += 1;
    }
    let moves = if solved {
        std::mem::take(&mut search.line)
    } else {
        std::mem::take(&mut search.best_line)
    };
    let tsds = if solved { target } else { search.best_tsds };
    (moves, tsds, solved, search.nodes)
}

/// Solve for `target` more TSDs. `queue` is the full lookahead [active, ...upcoming].
pub fn solve_lst_run(
    board: &Board,
    queue: &[PieceType],
    hold: Option<PieceType>,
    target: i32,
    opts: &Opts,
) -> Option<SolveResult> {
    let mut mirrored = false;
    let mut b = *board;
    let mut q: Vec<PieceType> = queue.to_vec();
    let mut h = hold;
    if find_lst_site(board).is_none() {
        let m = mirror_board(board);
        if find_lst_site(&m).is_none() {
            return None;
        }
        mirrored = true;
        b = m;
        q = queue.iter().map(|&p| mirror_piece(p)).collect();
        h = hold.map(mirror_piece);
    }

    let (moves, tsds, solved, nodes) = solve_canonical(&b, &q, h, target, opts);
    if moves.is_empty() {
        return Some(SolveResult {
            moves: Vec::new(),
            tsds: 0,
            solved,
            mirrored,
            nodes,
        });
    }

    // replay in real space to stamp per-move expectation keys for playback
    let mut out: Vec<SolvedMove> = Vec::new();
    let mut scratch = *board;
    for st in &moves {
        let p = &st.p;
        let cells: Vec<Cell> = if mirrored {
            p.cells.iter().map(|&(x, y)| (BOARD_W - 1 - x, y)).collect()
        } else {
            p.cells.clone()
        };
        out.push(SolvedMove {
            piece: if mirrored { mirror_piece(p.piece) } else { p.piece },
            cells: cells.clone(),
            spin: p.spin,
            lines_cleared: p.lines_cleared,
            before_key: scratch.key(),
            is_tsd: is_tsd(p),
        });
        scratch.place(&cells);
        scratch.clear_lines();
    }
    Some(SolveResult {
        moves: out,
        tsds,
        solved,
        mirrored,
        nodes,
    })
}
