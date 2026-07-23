//! Parity gate for the ported core primitives.
//! Reconstructs the exact boards dumped by tools/rust-fixtures.ts and asserts
//! that enumerate_placements() produces byte-identical output (ordered).

use lst_solver::board::{Board, BOARD_H};
use lst_solver::enumerate::{enumerate_fast, enumerate_placements, placement_key, Placement};
use lst_solver::eval::{find_lst_site, mirror_board, mirror_piece, quad_well_depth};
use lst_solver::pieces::{PieceType, PIECE_TYPES};
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize)]
struct PlacementDump {
    key: String,
    spin: String,
    lines: i32,
    after: String,
    path: String,
}

#[derive(Deserialize)]
struct SiteDump {
    y: i32,
    missing: i32,
    #[serde(rename = "roofReady")]
    roof_ready: bool,
}

#[derive(Deserialize)]
struct BoardDump {
    rows: Vec<u32>,
    key: String,
    placements: HashMap<String, Vec<PlacementDump>>,
    fast: HashMap<String, Vec<PlacementDump>>,
    site: Option<SiteDump>,
    #[serde(rename = "quadDepth")]
    quad_depth: i32,
    mirror: String,
}

#[derive(Deserialize)]
struct Fixtures {
    boards: Vec<BoardDump>,
}

fn board_from_rows(rows: &[u32]) -> Board {
    let mut b = Board::new();
    assert_eq!(rows.len(), BOARD_H as usize, "fixture rows must be BOARD_H");
    b.rows.copy_from_slice(rows);
    b
}

#[test]
fn enumerate_placements_matches_ts() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/primitives-fixtures.json");
    let data = std::fs::read_to_string(path)
        .unwrap_or_else(|_| panic!("missing fixtures: {path}\nrun: npx tsx tools/rust-fixtures.ts"));
    let fx: Fixtures = serde_json::from_str(&data).expect("parse fixtures");

    let mut checked = 0usize;
    for (bi, bd) in fx.boards.iter().enumerate() {
        let board = board_from_rows(&bd.rows);
        assert_eq!(board.key(), bd.key, "board {bi} key mismatch");

        for &t in PIECE_TYPES.iter() {
            let name = piece_name(t);
            checked += compare(bi, name, "exact", &bd.placements, enumerate_placements(&board, t));
            checked += compare(bi, name, "fast", &bd.fast, enumerate_fast(&board, t));
        }

        // LST predicates
        let site = find_lst_site(&board);
        match (&bd.site, site) {
            (None, None) => {}
            (Some(e), Some(g)) => {
                assert_eq!(g.y, e.y, "board {bi}: site.y");
                assert_eq!(g.missing, e.missing, "board {bi}: site.missing");
                assert_eq!(g.roof_ready, e.roof_ready, "board {bi}: site.roofReady");
            }
            (e, g) => panic!("board {bi}: site presence mismatch: TS={:?} rust={:?}", e.is_some(), g.is_some()),
        }
        assert_eq!(quad_well_depth(&board), bd.quad_depth, "board {bi}: quadWellDepth");
        assert_eq!(mirror_board(&board).key(), bd.mirror, "board {bi}: mirrorBoard key");
    }
    eprintln!(
        "primitives parity: {checked} placements matched across {} boards",
        fx.boards.len()
    );
}

fn compare(
    bi: usize,
    name: &str,
    kind: &str,
    expected_map: &HashMap<String, Vec<PlacementDump>>,
    got: Vec<Placement>,
) -> usize {
    let expected = expected_map
        .get(name)
        .unwrap_or_else(|| panic!("board {bi} {kind} missing piece {name}"));
    assert_eq!(
        got.len(),
        expected.len(),
        "board {bi} piece {name} [{kind}]: count {} != TS {}",
        got.len(),
        expected.len()
    );
    for (i, (g, e)) in got.iter().zip(expected.iter()).enumerate() {
        let gk = placement_key(g.piece, &g.cells);
        assert_eq!(gk, e.key, "board {bi} {name} [{kind}] #{i}: placement key");
        assert_eq!(g.spin.as_str(), e.spin, "board {bi} {name} [{kind}] #{i} ({gk}): spin");
        assert_eq!(g.lines_cleared, e.lines, "board {bi} {name} [{kind}] #{i} ({gk}): lines");
        assert_eq!(g.after.key(), e.after, "board {bi} {name} [{kind}] #{i} ({gk}): after-key");
        assert_eq!(g.path.join(" "), e.path, "board {bi} {name} [{kind}] #{i} ({gk}): path");
    }
    got.len()
}

#[test]
fn mirror_piece_matches_ts() {
    use PieceType::*;
    // MIRROR_PIECE in lst-solver.ts: S<->Z, J<->L, I/O/T fixed.
    for (a, b) in [(I, I), (O, O), (T, T), (S, Z), (Z, S), (J, L), (L, J)] {
        assert_eq!(mirror_piece(a), b, "mirror_piece({:?})", a);
    }
}

fn piece_name(t: PieceType) -> &'static str {
    match t {
        PieceType::I => "I",
        PieceType::O => "O",
        PieceType::T => "T",
        PieceType::S => "S",
        PieceType::Z => "Z",
        PieceType::J => "J",
        PieceType::L => "L",
    }
}
