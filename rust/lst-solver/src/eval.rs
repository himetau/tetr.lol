//! LST predicates used by the solver. Port of the relevant parts of
//! src/engine/eval.ts (findLstSite, LST_SPIN_COL, quadWellDepth) plus the
//! board/piece mirroring the solver canonicalises with.

use crate::board::{Board, BOARD_H, BOARD_W};
use crate::pieces::PieceType;

pub const LST_SPIN_COL: i32 = 2;

const FULL: u32 = (1 << BOARD_W) - 1;
const BASE_MASK: u32 = FULL & !(1 << LST_SPIN_COL); // full except col 2
const SLOT_MASK: u32 = FULL & !(0b111 << (LST_SPIN_COL - 1)); // full except cols 1,2,3

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct LstSite {
    pub y: i32,       // base row of the next TSD (stem row); slot row is y+1
    pub missing: i32, // empty completion cells left in rows y and y+1
    pub roof_ready: bool,
}

/// Row value with JS out-of-range semantics: rows past the top read as 0.
#[inline]
fn row_at(board: &Board, y: i32) -> u32 {
    if y >= 0 && y < BOARD_H {
        board.rows[y as usize]
    } else {
        0
    }
}

/// The LST loop is alive iff a col-2 TSD is still buildable somewhere.
pub fn find_lst_site(board: &Board) -> Option<LstSite> {
    let max_y = board.max_height(0);
    for y in 0..=max_y {
        // all rows strictly below must fit the base shape
        let mut ok = true;
        for yy in 0..y {
            if (row_at(board, yy) & !BASE_MASK) != 0 {
                ok = false;
                break;
            }
        }
        if !ok {
            continue;
        }
        if (row_at(board, y) & !BASE_MASK) != 0 {
            continue;
        }
        if (row_at(board, y + 1) & !SLOT_MASK) != 0 {
            continue;
        }

        // completion cells still empty must be open to the sky
        let mut missing = 0;
        let mut reachable = true;
        for x in 0..BOARD_W {
            if x != LST_SPIN_COL && !board.filled(x, y) {
                missing += 1;
                if !open_to_sky(board, x, y, max_y) {
                    reachable = false;
                    break;
                }
            }
            if x != 1 && x != LST_SPIN_COL && x != 3 && !board.filled(x, y + 1) {
                missing += 1;
                if !open_to_sky(board, x, y + 1, max_y) {
                    reachable = false;
                    break;
                }
            }
        }
        if !reachable {
            continue;
        }

        let roof_ready = board.filled(1, y + 2) || board.filled(3, y + 2);
        return Some(LstSite {
            y,
            missing,
            roof_ready,
        });
    }
    None
}

#[inline]
fn open_to_sky(board: &Board, x: i32, from_y: i32, max_y: i32) -> bool {
    let mut yy = from_y + 1;
    while yy <= max_y {
        if board.filled(x, yy) {
            return false;
        }
        yy += 1;
    }
    true
}

/// Checkerboard imbalance of the STACK SIDE only (cols LST_SPIN_COL+2..9).
/// Port of eval.ts stackSideImbalance (Feltheshovel parity: a perfect loop
/// keeps this in 0,+1,0,-1 by TSDs mod 4, never +-2).
pub fn stack_side_imbalance(board: &Board) -> i32 {
    let mut ci = 0;
    let h = board.max_height(0);
    for y in 0..h {
        let r = board.rows[y as usize];
        for x in (LST_SPIN_COL + 2)..BOARD_W {
            if (r >> x) & 1 == 1 {
                ci += if (x + y) & 1 == 0 { 1 } else { -1 };
            }
        }
    }
    ci
}

/// Depth of a clean quad well: rows complete-except-the-well from the bottom.
pub fn quad_well_depth(board: &Board) -> i32 {
    let mut depth = 0;
    for y in 0..BOARD_H {
        if board.filled(LST_SPIN_COL, y) {
            break; // well plugged here
        }
        if (board.rows[y as usize] | (1 << LST_SPIN_COL)) != FULL {
            break; // this row isn't complete-except-the-well
        }
        depth += 1;
    }
    depth
}

/// Mirror a piece type left<->right (S<->Z, J<->L; I/O/T fixed).
pub fn mirror_piece(t: PieceType) -> PieceType {
    match t {
        PieceType::S => PieceType::Z,
        PieceType::Z => PieceType::S,
        PieceType::J => PieceType::L,
        PieceType::L => PieceType::J,
        other => other,
    }
}

/// Horizontally mirror the board (col x -> col BOARD_W-1-x).
pub fn mirror_board(board: &Board) -> Board {
    let mut out = Board::new();
    for y in 0..BOARD_H as usize {
        let r = board.rows[y];
        let mut m = 0u32;
        for x in 0..BOARD_W {
            if (r >> x) & 1 == 1 {
                m |= 1 << (BOARD_W - 1 - x);
            }
        }
        out.rows[y] = m;
    }
    out
}
