//! Placement enumeration. Port of src/engine/enumerate.ts.
//!
//! `enumerate_placements` - exact BFS over (x, y, rot, last-rotation-kick):
//! finds every reachable lock position including tucks and spins.
//! `enumerate_fast` - hard-drops per (rot, x) plus reachable T-slot spins.

use crate::board::{Board, BOARD_W};
use crate::masks::{collides_fast, drop_y, shape};
use crate::pieces::{cells_at, Cell, PieceType};
use crate::spin::{detect_spin, SpinKind};
use crate::srs::try_rotate;
use std::collections::HashMap;

pub const SPAWN_X: i32 = 4;
pub const SPAWN_Y: i32 = 18;

#[derive(Clone)]
pub struct Placement {
    pub piece: PieceType,
    pub rot: usize,
    pub x: i32,
    pub y: i32,
    pub cells: Vec<Cell>,
    pub spin: SpinKind,
    pub lines_cleared: i32,
    pub after: Board,
    pub path: Vec<&'static str>,
}

/// Canonical "piece:sorted-cells" key for matching placements by their cells.
pub fn placement_key(piece: PieceType, cells: &[Cell]) -> String {
    let mut ids: Vec<i32> = cells.iter().map(|&(x, y)| x * 32 + y).collect();
    ids.sort_unstable();
    let mut s = String::new();
    s.push(piece.to_char());
    s.push(':');
    for (i, v) in ids.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&v.to_string());
    }
    s
}

#[derive(Clone, Copy, PartialEq)]
enum Move {
    Left,
    Right,
    Sd,
    Cw,
    Ccw,
    R180,
}

const MOVES: [Move; 6] = [
    Move::Left,
    Move::Right,
    Move::Sd,
    Move::Cw,
    Move::Ccw,
    Move::R180,
];

impl Move {
    fn as_str(self) -> &'static str {
        match self {
            Move::Left => "left",
            Move::Right => "right",
            Move::Sd => "sd",
            Move::Cw => "cw",
            Move::Ccw => "ccw",
            Move::R180 => "180",
        }
    }
}

struct Node {
    x: i32,
    y: i32,
    rot: usize,
    last_kick: i32, // -1 = last move was not a rotation
    parent: Option<usize>,
    mv: Option<Move>,
}

#[inline]
fn node_key(x: i32, y: i32, rot: usize, kc: i32) -> i32 {
    (((y + 3) * 16 + (x + 3)) * 4 + rot as i32) * 3 + kc
}

#[inline]
fn kick_class(k: i32) -> i32 {
    if k < 0 {
        0
    } else if k == 4 {
        2
    } else {
        1
    }
}

fn finish_placement(
    board: &Board,
    t: PieceType,
    rot: usize,
    x: i32,
    y: i32,
    spin: SpinKind,
    path: Vec<&'static str>,
) -> Placement {
    let cells = cells_at(t, rot, x, y);
    let mut after = *board;
    after.place(&cells);
    let cleared = after.clear_lines();
    Placement {
        piece: t,
        rot,
        x,
        y,
        cells,
        spin,
        lines_cleared: cleared.len() as i32,
        after,
        path,
    }
}

/// Cell-set-canonical key: S/Z/I rot 2/3 produce the same cells as 0/1 shifted.
fn canonical_key(t: PieceType, rot: usize, x: i32, y: i32) -> String {
    let s = shape(t, rot);
    let shape_id = match t {
        PieceType::O => 0,
        PieceType::I | PieceType::S | PieceType::Z => (rot % 2) as i32,
        _ => rot as i32,
    };
    format!("{}:{},{}", shape_id, x + s.min_dx, y + s.min_dy)
}

pub fn enumerate_placements(board: &Board, t: PieceType) -> Vec<Placement> {
    if collides_fast(board, t, 0, SPAWN_X, SPAWN_Y) {
        return Vec::new();
    }
    let mut nodes: Vec<Node> = Vec::new();
    nodes.push(Node {
        x: SPAWN_X,
        y: SPAWN_Y,
        rot: 0,
        last_kick: -1,
        parent: None,
        mv: None,
    });

    let mut seen: std::collections::HashSet<i32> = std::collections::HashSet::new();
    seen.insert(node_key(SPAWN_X, SPAWN_Y, 0, 0));
    let mut queue: Vec<usize> = vec![0];
    let mut qh = 0usize;

    // insertion-ordered results, keyed by canonical cell-set (mirrors JS Map)
    let mut order: Vec<(usize, SpinKind)> = Vec::new(); // (node_idx, spin)
    let mut index: HashMap<String, usize> = HashMap::new();

    while qh < queue.len() {
        let ni = queue[qh];
        qh += 1;
        let (nx, ny, nrot, nlk) = {
            let n = &nodes[ni];
            (n.x, n.y, n.rot, n.last_kick)
        };

        // grounded? -> record a lock candidate
        if collides_fast(board, t, nrot, nx, ny - 1) {
            let spin = detect_spin(board, t, nrot, nx, ny, nlk >= 0, nlk);
            let ckey = canonical_key(t, nrot, nx, ny);
            match index.get(&ckey) {
                Some(&pos) => {
                    if spin.rank() > order[pos].1.rank() {
                        order[pos] = (ni, spin);
                    }
                }
                None => {
                    index.insert(ckey, order.len());
                    order.push((ni, spin));
                }
            }
        }

        for &mv in MOVES.iter() {
            let mut mx = nx;
            let mut my = ny;
            let mut mrot = nrot;
            let mut mkick = -1;
            match mv {
                Move::Left | Move::Right => {
                    mx += if mv == Move::Left { -1 } else { 1 };
                    if collides_fast(board, t, mrot, mx, my) {
                        continue;
                    }
                }
                Move::Sd => {
                    my -= 1;
                    if collides_fast(board, t, mrot, mx, my) {
                        continue;
                    }
                }
                Move::Cw | Move::Ccw | Move::R180 => {
                    let dir = match mv {
                        Move::Cw => 1,
                        Move::Ccw => -1,
                        _ => 2,
                    };
                    match try_rotate(board, t, nrot, nx, ny, dir) {
                        Some(res) => {
                            mx = res.x;
                            my = res.y;
                            mrot = res.rot;
                            mkick = res.kick_index;
                        }
                        None => continue,
                    }
                }
            }
            let k = node_key(mx, my, mrot, kick_class(mkick));
            if seen.contains(&k) {
                continue;
            }
            seen.insert(k);
            let idx = nodes.len();
            nodes.push(Node {
                x: mx,
                y: my,
                rot: mrot,
                last_kick: mkick,
                parent: Some(ni),
                mv: Some(mv),
            });
            queue.push(idx);
        }
    }

    let mut placements = Vec::with_capacity(order.len());
    for &(ni, spin) in &order {
        let mut path: Vec<&'static str> = Vec::new();
        let mut p = Some(ni);
        while let Some(pi) = p {
            let node = &nodes[pi];
            if let Some(mv) = node.mv {
                path.push(mv.as_str());
                p = node.parent;
            } else {
                break;
            }
        }
        path.reverse();
        let node = &nodes[ni];
        placements.push(finish_placement(
            board, t, node.rot, node.x, node.y, spin, path,
        ));
    }
    placements
}

/// Fast approximate enumeration for lookahead: hard drops + T-slot spins.
pub fn enumerate_fast(board: &Board, t: PieceType) -> Vec<Placement> {
    let rots: &[usize] = match t {
        PieceType::O => &[0],
        PieceType::I | PieceType::S | PieceType::Z => &[0, 1],
        _ => &[0, 1, 2, 3],
    };
    let mut out = Vec::new();
    for &rot in rots {
        let s = shape(t, rot);
        let mut x = -s.min_dx;
        while x < BOARD_W - s.max_dx {
            let y = drop_y(board, t, rot, x);
            out.push(finish_placement(board, t, rot, x, y, SpinKind::None, Vec::new()));
            x += 1;
        }
    }
    if t == PieceType::T {
        let max_y = (board.max_height(0) + 1).min(22);
        for y in 0..=max_y {
            for x in 1..(BOARD_W - 1) {
                if collides_fast(board, PieceType::T, 2, x, y) {
                    continue;
                }
                if !collides_fast(board, PieceType::T, 2, x, y - 1) {
                    continue;
                }
                if !board.filled(x - 1, y + 1) && !board.filled(x + 1, y + 1) {
                    continue;
                }
                let spin = detect_spin(board, PieceType::T, 2, x, y, true, 0);
                if spin == SpinKind::None {
                    continue;
                }
                if drop_y(board, PieceType::T, 2, x) != y {
                    out.push(finish_placement(board, PieceType::T, 2, x, y, spin, Vec::new()));
                }
            }
        }
    }
    out
}
