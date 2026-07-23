//! Bitboard. Faithful port of src/core/board.ts.
//! Row 0 is the bottom. Bit x of rows[y] = cell at column x.

use crate::pieces::Cell;

pub const BOARD_W: i32 = 10;
pub const BOARD_H: i32 = 26; // 20 visible + hidden rows above
pub const VISIBLE_H: i32 = 20;

pub const FULL_ROW: u32 = (1 << BOARD_W) - 1;

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct Board {
    pub rows: [u32; BOARD_H as usize],
}

impl Default for Board {
    fn default() -> Self {
        Board {
            rows: [0; BOARD_H as usize],
        }
    }
}

impl Board {
    pub fn new() -> Self {
        Board::default()
    }

    #[inline]
    pub fn filled(&self, x: i32, y: i32) -> bool {
        // walls and the floor count as filled
        if x < 0 || x >= BOARD_W || y < 0 {
            return true;
        }
        if y >= BOARD_H {
            return false;
        }
        ((self.rows[y as usize] >> x) & 1) == 1
    }

    pub fn collides(&self, cells: &[Cell]) -> bool {
        cells.iter().any(|&(x, y)| self.filled(x, y))
    }

    pub fn place(&mut self, cells: &[Cell]) {
        for &(x, y) in cells {
            if y >= 0 && y < BOARD_H {
                self.rows[y as usize] |= 1 << x;
            }
        }
    }

    /// Clears full rows, returns the cleared row indices (bottom-up, pre-clear).
    pub fn clear_lines(&mut self) -> Vec<i32> {
        let mut cleared = Vec::new();
        let mut dst = 0usize;
        for y in 0..BOARD_H as usize {
            if self.rows[y] == FULL_ROW {
                cleared.push(y as i32);
            } else {
                self.rows[dst] = self.rows[y];
                dst += 1;
            }
        }
        while dst < BOARD_H as usize {
            self.rows[dst] = 0;
            dst += 1;
        }
        cleared
    }

    /// Tallest column, optionally ignoring a column bitmask.
    pub fn max_height(&self, ignore_cols: u32) -> i32 {
        for y in (0..BOARD_H as usize).rev() {
            if (self.rows[y] & !ignore_cols) != 0 {
                return y as i32 + 1;
            }
        }
        0
    }

    pub fn column_height(&self, x: i32) -> i32 {
        for y in (0..BOARD_H as usize).rev() {
            if (self.rows[y] >> x) & 1 == 1 {
                return y as i32 + 1;
            }
        }
        0
    }

    pub fn is_empty(&self) -> bool {
        self.rows.iter().all(|&r| r == 0)
    }

    pub fn cell_count(&self) -> u32 {
        self.rows.iter().map(|r| r.count_ones()).sum()
    }

    /// Byte-exact match for board.ts `key()` = rows.join(",").
    pub fn key(&self) -> String {
        let mut s = String::new();
        for (i, r) in self.rows.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            s.push_str(&r.to_string());
        }
        s
    }

    /// lines are top-down, 'X'/'#' = filled, anything else empty.
    pub fn from_strings(lines: &[&str]) -> Board {
        let mut b = Board::new();
        let h = lines.len();
        for (i, line) in lines.iter().enumerate() {
            let y = h - 1 - i;
            for (x, c) in line.chars().enumerate() {
                if x >= BOARD_W as usize {
                    break;
                }
                if c == 'X' || c == '#' {
                    b.rows[y] |= 1 << x;
                }
            }
        }
        b
    }
}
