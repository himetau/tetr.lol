// Tetromino definitions. Coordinates are y-up: (x, y) offsets from the piece
// origin (the SRS rotation center). Rotation states: 0=spawn, 1=CW(east),
// 2=180(south), 3=CCW(west).

export type PieceType = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';
export const PIECE_TYPES: PieceType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

export type Rot = 0 | 1 | 2 | 3;
export type Cell = readonly [number, number];

function rotateCW(cells: Cell[]): Cell[] {
  // y-up CW rotation about origin: (x, y) -> (y, -x); avoid -0
  return cells.map(([x, y]) => [y, x === 0 ? 0 : -x] as const);
}

function fourStates(spawn: Cell[]): Cell[][] {
  const s0 = spawn;
  const s1 = rotateCW(s0);
  const s2 = rotateCW(s1);
  const s3 = rotateCW(s2);
  return [s0, s1, s2, s3];
}

const SPAWN_CELLS: Record<PieceType, Cell[]> = {
  T: [[-1, 0], [0, 0], [1, 0], [0, 1]],
  S: [[-1, 0], [0, 0], [0, 1], [1, 1]],
  Z: [[-1, 1], [0, 1], [0, 0], [1, 0]],
  J: [[-1, 1], [-1, 0], [0, 0], [1, 0]],
  L: [[1, 1], [-1, 0], [0, 0], [1, 0]],
  O: [[0, 0], [1, 0], [0, 1], [1, 1]],
  I: [[-1, 0], [0, 0], [1, 0], [2, 0]],
};

// I rotates about the center of its 4x4 SRS box, which isn't a lattice point;
// hardcode the four states instead of generating them.
const I_STATES: Cell[][] = [
  [[-1, 0], [0, 0], [1, 0], [2, 0]],
  [[1, 1], [1, 0], [1, -1], [1, -2]],
  [[-1, -1], [0, -1], [1, -1], [2, -1]],
  [[0, 1], [0, 0], [0, -1], [0, -2]],
];

// O never kicks; keep all states identical so rotation is a no-op visually.
const O_STATES: Cell[][] = [SPAWN_CELLS.O, SPAWN_CELLS.O, SPAWN_CELLS.O, SPAWN_CELLS.O];

export const PIECE_CELLS: Record<PieceType, Cell[][]> = {
  T: fourStates(SPAWN_CELLS.T),
  S: fourStates(SPAWN_CELLS.S),
  Z: fourStates(SPAWN_CELLS.Z),
  J: fourStates(SPAWN_CELLS.J),
  L: fourStates(SPAWN_CELLS.L),
  O: O_STATES,
  I: I_STATES,
};

// Sampled from the user's tetr.io skin sheet (tetrio-plus .tpse export)
export const PIECE_COLORS: Record<PieceType, string> = {
  I: '#42afe1',
  O: '#f6d03c',
  T: '#9739a2',
  S: '#51b84d',
  Z: '#eb4f65',
  J: '#1165b5',
  L: '#f38927',
};

export function cellsAt(type: PieceType, rot: Rot, x: number, y: number): Cell[] {
  return PIECE_CELLS[type][rot].map(([cx, cy]) => [cx + x, cy + y] as const);
}
