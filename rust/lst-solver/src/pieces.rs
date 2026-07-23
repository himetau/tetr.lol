//! Tetromino definitions. Faithful port of src/core/pieces.ts.
//! Coordinates are y-up: (x, y) offsets from the SRS rotation center.
//! Rotation states: 0=spawn, 1=CW(east), 2=180(south), 3=CCW(west).

use once_cell::sync::Lazy;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum PieceType {
    I,
    O,
    T,
    S,
    Z,
    J,
    L,
}

pub const PIECE_TYPES: [PieceType; 7] = [
    PieceType::I,
    PieceType::O,
    PieceType::T,
    PieceType::S,
    PieceType::Z,
    PieceType::J,
    PieceType::L,
];

impl PieceType {
    #[inline]
    pub fn idx(self) -> usize {
        match self {
            PieceType::I => 0,
            PieceType::O => 1,
            PieceType::T => 2,
            PieceType::S => 3,
            PieceType::Z => 4,
            PieceType::J => 5,
            PieceType::L => 6,
        }
    }

    pub fn from_char(c: char) -> Option<PieceType> {
        Some(match c {
            'I' => PieceType::I,
            'O' => PieceType::O,
            'T' => PieceType::T,
            'S' => PieceType::S,
            'Z' => PieceType::Z,
            'J' => PieceType::J,
            'L' => PieceType::L,
            _ => return None,
        })
    }

    pub fn to_char(self) -> char {
        match self {
            PieceType::I => 'I',
            PieceType::O => 'O',
            PieceType::T => 'T',
            PieceType::S => 'S',
            PieceType::Z => 'Z',
            PieceType::J => 'J',
            PieceType::L => 'L',
        }
    }
}

pub type Cell = (i32, i32);

/// y-up CW rotation about origin: (x, y) -> (y, -x).
fn rotate_cw(cells: &[Cell]) -> Vec<Cell> {
    cells.iter().map(|&(x, y)| (y, -x)).collect()
}

fn four_states(spawn: &[Cell]) -> [Vec<Cell>; 4] {
    let s0: Vec<Cell> = spawn.to_vec();
    let s1 = rotate_cw(&s0);
    let s2 = rotate_cw(&s1);
    let s3 = rotate_cw(&s2);
    [s0, s1, s2, s3]
}

// Spawn cells, matching SPAWN_CELLS in pieces.ts exactly (order preserved).
const T_SPAWN: [Cell; 4] = [(-1, 0), (0, 0), (1, 0), (0, 1)];
const S_SPAWN: [Cell; 4] = [(-1, 0), (0, 0), (0, 1), (1, 1)];
const Z_SPAWN: [Cell; 4] = [(-1, 1), (0, 1), (0, 0), (1, 0)];
const J_SPAWN: [Cell; 4] = [(-1, 1), (-1, 0), (0, 0), (1, 0)];
const L_SPAWN: [Cell; 4] = [(1, 1), (-1, 0), (0, 0), (1, 0)];
const O_SPAWN: [Cell; 4] = [(0, 0), (1, 0), (0, 1), (1, 1)];

// I rotates about the center of its 4x4 SRS box (not a lattice point); the four
// states are hardcoded, matching I_STATES in pieces.ts.
const I_STATES: [[Cell; 4]; 4] = [
    [(-1, 0), (0, 0), (1, 0), (2, 0)],
    [(1, 1), (1, 0), (1, -1), (1, -2)],
    [(-1, -1), (0, -1), (1, -1), (2, -1)],
    [(0, 1), (0, 0), (0, -1), (0, -2)],
];

/// PIECE_CELLS[type_idx][rot] = cells for that state.
pub static PIECE_CELLS: Lazy<[[Vec<Cell>; 4]; 7]> = Lazy::new(|| {
    let t = four_states(&T_SPAWN);
    let s = four_states(&S_SPAWN);
    let z = four_states(&Z_SPAWN);
    let j = four_states(&J_SPAWN);
    let l = four_states(&L_SPAWN);
    // O never kicks; all four states identical.
    let o = [
        O_SPAWN.to_vec(),
        O_SPAWN.to_vec(),
        O_SPAWN.to_vec(),
        O_SPAWN.to_vec(),
    ];
    let i = [
        I_STATES[0].to_vec(),
        I_STATES[1].to_vec(),
        I_STATES[2].to_vec(),
        I_STATES[3].to_vec(),
    ];
    // Index order must match PieceType::idx: I,O,T,S,Z,J,L
    [i, o, t, s, z, j, l]
});

#[inline]
pub fn piece_cells(t: PieceType, rot: usize) -> &'static [Cell] {
    &PIECE_CELLS[t.idx()][rot]
}

/// Absolute cells of (type, rot) placed at (x, y).
pub fn cells_at(t: PieceType, rot: usize, x: i32, y: i32) -> Vec<Cell> {
    piece_cells(t, rot)
        .iter()
        .map(|&(cx, cy)| (cx + x, cy + y))
        .collect()
}
