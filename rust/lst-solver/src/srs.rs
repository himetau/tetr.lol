//! SRS kick tables with tetr.io-style 180 kicks. Port of src/core/srs.ts.
//! Offsets are (dx, dy) with y up, tried in order.

use crate::board::Board;
use crate::pieces::{cells_at, PieceType};

type Kick = (i32, i32);

// JLSTZ kicks keyed by (from, to)
fn jlstz_kicks(from: usize, to: usize) -> &'static [Kick] {
    match (from, to) {
        (0, 1) => &[(0, 0), (-1, 0), (-1, 1), (0, -2), (-1, -2)],
        (1, 0) => &[(0, 0), (1, 0), (1, -1), (0, 2), (1, 2)],
        (1, 2) => &[(0, 0), (1, 0), (1, -1), (0, 2), (1, 2)],
        (2, 1) => &[(0, 0), (-1, 0), (-1, 1), (0, -2), (-1, -2)],
        (2, 3) => &[(0, 0), (1, 0), (1, 1), (0, -2), (1, -2)],
        (3, 2) => &[(0, 0), (-1, 0), (-1, -1), (0, 2), (-1, 2)],
        (3, 0) => &[(0, 0), (-1, 0), (-1, -1), (0, 2), (-1, 2)],
        (0, 3) => &[(0, 0), (1, 0), (1, 1), (0, -2), (1, -2)],
        _ => &[(0, 0)],
    }
}

fn i_kicks(from: usize, to: usize) -> &'static [Kick] {
    match (from, to) {
        (0, 1) => &[(0, 0), (-2, 0), (1, 0), (-2, -1), (1, 2)],
        (1, 0) => &[(0, 0), (2, 0), (-1, 0), (2, 1), (-1, -2)],
        (1, 2) => &[(0, 0), (-1, 0), (2, 0), (-1, 2), (2, -1)],
        (2, 1) => &[(0, 0), (1, 0), (-2, 0), (1, -2), (-2, 1)],
        (2, 3) => &[(0, 0), (2, 0), (-1, 0), (2, 1), (-1, -2)],
        (3, 2) => &[(0, 0), (-2, 0), (1, 0), (-2, -1), (1, 2)],
        (3, 0) => &[(0, 0), (1, 0), (-2, 0), (1, -2), (-2, 1)],
        (0, 3) => &[(0, 0), (-1, 0), (2, 0), (-1, 2), (2, -1)],
        _ => &[(0, 0)],
    }
}

// tetr.io SRS+ 180 kicks (all pieces; I uses the same table there).
fn kicks_180(from: usize, to: usize) -> &'static [Kick] {
    match (from, to) {
        (0, 2) => &[(0, 0), (0, 1), (1, 1), (-1, 1), (1, 0), (-1, 0)],
        (2, 0) => &[(0, 0), (0, -1), (-1, -1), (1, -1), (-1, 0), (1, 0)],
        (1, 3) => &[(0, 0), (1, 0), (1, 2), (1, 1), (0, 2), (0, 1)],
        (3, 1) => &[(0, 0), (-1, 0), (-1, 2), (-1, 1), (0, 2), (0, 1)],
        _ => &[(0, 0)],
    }
}

pub fn kicks_for(t: PieceType, from: usize, to: usize) -> &'static [Kick] {
    if t == PieceType::O {
        return &[(0, 0)];
    }
    if (from + 2) % 4 == to {
        return kicks_180(from, to);
    }
    if t == PieceType::I {
        i_kicks(from, to)
    } else {
        jlstz_kicks(from, to)
    }
}

pub struct RotateResult {
    pub x: i32,
    pub y: i32,
    pub rot: usize,
    pub kick_index: i32,
}

/// Attempt rotation with kicks; returns the new position or None if blocked.
/// dir: 1 = CW, -1 (as 3) = CCW, 2 = 180.
pub fn try_rotate(
    board: &Board,
    t: PieceType,
    rot: usize,
    x: i32,
    y: i32,
    dir: i32,
) -> Option<RotateResult> {
    let to = (((rot as i32 + dir) % 4 + 4) % 4) as usize;
    let kicks = kicks_for(t, rot, to);
    for (i, &(dx, dy)) in kicks.iter().enumerate() {
        if !board.collides(&cells_at(t, to, x + dx, y + dy)) {
            return Some(RotateResult {
                x: x + dx,
                y: y + dy,
                rot: to,
                kick_index: i as i32,
            });
        }
    }
    None
}
