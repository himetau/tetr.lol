//! Precomputed row-bitmask piece data for fast collision tests.
//! Faithful port of src/engine/masks.ts.

use crate::board::{Board, BOARD_H, BOARD_W};
use crate::pieces::{piece_cells, PieceType, PIECE_TYPES};
use once_cell::sync::Lazy;

#[derive(Clone)]
pub struct Span {
    pub dy: i32,
    pub bits: u32, // cells of this row, bit (dx - min_dx)
    pub min_dx: i32,
    pub max_dx: i32,
}

#[derive(Clone)]
pub struct RotShape {
    pub spans: Vec<Span>,
    pub min_dx: i32,
    pub max_dx: i32,
    pub min_dy: i32,
    /// for each x-offset column present: lowest dy (bottom profile)
    pub bottom: Vec<(i32, i32)>,
}

// SHAPES[type_idx][rot]
static SHAPES: Lazy<[[RotShape; 4]; 7]> = Lazy::new(|| {
    std::array::from_fn(|ti| {
        let t = PIECE_TYPES[ti];
        std::array::from_fn(|rot| build_shape(t, rot))
    })
});

fn build_shape(t: PieceType, rot: usize) -> RotShape {
    let cells = piece_cells(t, rot);

    // group by dy, preserving first-seen order (mirrors the JS Map)
    let mut dys: Vec<i32> = Vec::new();
    let mut groups: Vec<Vec<i32>> = Vec::new();
    for &(dx, dy) in cells {
        if let Some(pos) = dys.iter().position(|&d| d == dy) {
            groups[pos].push(dx);
        } else {
            dys.push(dy);
            groups.push(vec![dx]);
        }
    }
    let mut spans = Vec::new();
    for (i, dxs) in groups.iter().enumerate() {
        let min_dx = *dxs.iter().min().unwrap();
        let max_dx = *dxs.iter().max().unwrap();
        let mut bits = 0u32;
        for &dx in dxs {
            bits |= 1 << (dx - min_dx);
        }
        spans.push(Span {
            dy: dys[i],
            bits,
            min_dx,
            max_dx,
        });
    }

    let min_dx = cells.iter().map(|c| c.0).min().unwrap();
    let max_dx = cells.iter().map(|c| c.0).max().unwrap();
    let min_dy = cells.iter().map(|c| c.1).min().unwrap();

    // bottom profile: for each dx, the lowest dy; first-seen dx order
    let mut bdx: Vec<i32> = Vec::new();
    let mut bdy: Vec<i32> = Vec::new();
    for &(dx, dy) in cells {
        if let Some(pos) = bdx.iter().position(|&d| d == dx) {
            if dy < bdy[pos] {
                bdy[pos] = dy;
            }
        } else {
            bdx.push(dx);
            bdy.push(dy);
        }
    }
    let bottom = bdx.into_iter().zip(bdy).collect();

    RotShape {
        spans,
        min_dx,
        max_dx,
        min_dy,
        bottom,
    }
}

#[inline]
pub fn shape(t: PieceType, rot: usize) -> &'static RotShape {
    &SHAPES[t.idx()][rot]
}

/// Fast collision: true if the piece at (x,y) overlaps stack/walls/floor.
pub fn collides_fast(board: &Board, t: PieceType, rot: usize, x: i32, y: i32) -> bool {
    let s = shape(t, rot);
    if x + s.min_dx < 0 || x + s.max_dx >= BOARD_W {
        return true;
    }
    if y + s.min_dy < 0 {
        return true;
    }
    for sp in &s.spans {
        let ry = y + sp.dy;
        if ry >= BOARD_H {
            continue;
        }
        // ry >= 0 guaranteed: y + min_dy >= 0 and dy >= min_dy
        if (board.rows[ry as usize] & (sp.bits << (x + sp.min_dx))) != 0 {
            return true;
        }
    }
    false
}

/// Landing y for a straight drop of (type,rot) at column x (from above).
pub fn drop_y(board: &Board, t: PieceType, rot: usize, x: i32) -> i32 {
    let s = shape(t, rot);
    let mut y = -s.min_dy; // lowest legal
    for &(dx, dy) in &s.bottom {
        let h = board.column_height(x + dx);
        y = y.max(h - dy);
    }
    y
}
