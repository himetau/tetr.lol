//! Spin detection. Port of src/core/spin.ts.

use crate::board::Board;
use crate::pieces::{cells_at, PieceType};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SpinKind {
    None,
    Mini,
    Full,
}

impl SpinKind {
    pub fn rank(self) -> u8 {
        match self {
            SpinKind::None => 0,
            SpinKind::Mini => 1,
            SpinKind::Full => 2,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            SpinKind::None => "none",
            SpinKind::Mini => "mini",
            SpinKind::Full => "full",
        }
    }
}

// front[rot] / back[rot]: corner offsets relative to the T center.
const FRONT: [[(i32, i32); 2]; 4] = [
    [(-1, 1), (1, 1)],
    [(1, 1), (1, -1)],
    [(-1, -1), (1, -1)],
    [(-1, 1), (-1, -1)],
];
const BACK: [[(i32, i32); 2]; 4] = [
    [(-1, -1), (1, -1)],
    [(-1, 1), (-1, -1)],
    [(-1, 1), (1, 1)],
    [(1, 1), (1, -1)],
];

pub fn detect_spin(
    board: &Board,
    t: PieceType,
    rot: usize,
    x: i32,
    y: i32,
    last_move_was_rotation: bool,
    last_kick_index: i32,
) -> SpinKind {
    if !last_move_was_rotation {
        return SpinKind::None;
    }
    if t != PieceType::T {
        // all-spin: any non-T boxed in on all four sides after a rotation
        return if is_immobile(board, t, rot, x, y) {
            SpinKind::Full
        } else {
            SpinKind::None
        };
    }
    let front_filled = FRONT[rot]
        .iter()
        .filter(|&&(dx, dy)| board.filled(x + dx, y + dy))
        .count();
    let back_filled = BACK[rot]
        .iter()
        .filter(|&&(dx, dy)| board.filled(x + dx, y + dy))
        .count();
    if front_filled + back_filled < 3 {
        return SpinKind::None;
    }
    if front_filled == 2 {
        return SpinKind::Full;
    }
    if last_kick_index == 4 {
        SpinKind::Full
    } else {
        SpinKind::Mini
    }
}

fn is_immobile(board: &Board, t: PieceType, rot: usize, x: i32, y: i32) -> bool {
    board.collides(&cells_at(t, rot, x - 1, y))
        && board.collides(&cells_at(t, rot, x + 1, y))
        && board.collides(&cells_at(t, rot, x, y - 1))
        && board.collides(&cells_at(t, rot, x, y + 1))
}
