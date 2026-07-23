//! Parity gate for the ported solveLstRun. Reconstructs the exact solve inputs
//! dumped by tools/rust-solver-fixtures.ts and asserts byte-identical output,
//! including the node count -- an exact match means the LDS search trees are
//! algorithmically identical between TS and Rust.

use lst_solver::board::Board;
use lst_solver::pieces::PieceType;
use lst_solver::solver::{solve_lst_run, Opts};
use serde::Deserialize;

#[derive(Deserialize)]
struct OptsDump {
    #[serde(rename = "budgetMs")]
    budget_ms: u64,
    #[serde(rename = "nodeBudget")]
    node_budget: i64,
    #[serde(rename = "maxBranch")]
    max_branch: usize,
    #[serde(rename = "cycleSolutions")]
    cycle_solutions: i64,
    #[serde(rename = "cycleNodeCap")]
    cycle_node_cap: i64,
    #[serde(rename = "tailFree")]
    tail_free: i32,
    #[serde(rename = "maxDisc")]
    max_disc: i32,
    #[serde(rename = "frontierBand")]
    frontier_band: i32,
    #[serde(rename = "allowQuad")]
    allow_quad: bool,
    #[serde(rename = "szReserve", default)]
    sz_reserve: i64,
    #[serde(rename = "partialHealth", default)]
    partial_health: bool,
}

#[derive(Deserialize)]
struct InputDump {
    rows: Vec<u32>,
    queue: Vec<String>,
    hold: Option<String>,
    target: i32,
    opts: OptsDump,
}

#[derive(Deserialize)]
struct MoveDump {
    piece: String,
    cells: Vec<[i32; 2]>,
    spin: String,
    #[serde(rename = "linesCleared")]
    lines_cleared: i32,
    #[serde(rename = "beforeKey")]
    before_key: String,
    #[serde(rename = "isTsd")]
    is_tsd: bool,
}

#[derive(Deserialize)]
struct OutputDump {
    moves: Vec<MoveDump>,
    tsds: i32,
    solved: bool,
    mirrored: bool,
    nodes: i64,
}

#[derive(Deserialize)]
struct CaseDump {
    seed: i64,
    input: InputDump,
    output: OutputDump,
    #[serde(rename = "solveMs")]
    solve_ms: f64,
}

#[derive(Deserialize)]
struct Fixtures {
    cases: Vec<CaseDump>,
}

fn parse_piece(s: &str) -> PieceType {
    PieceType::from_char(s.chars().next().unwrap()).unwrap_or_else(|| panic!("bad piece {s}"))
}

#[test]
fn solve_lst_run_matches_ts() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/solver-fixtures.json");
    let data = std::fs::read_to_string(path).unwrap_or_else(|_| {
        panic!("missing fixtures: {path}\nrun: npx tsx tools/rust-solver-fixtures.ts")
    });
    let fx: Fixtures = serde_json::from_str(&data).expect("parse solver fixtures");

    for c in &fx.cases {
        let mut board = Board::new();
        assert_eq!(c.input.rows.len(), 26);
        board.rows.copy_from_slice(&c.input.rows);
        let queue: Vec<PieceType> = c.input.queue.iter().map(|s| parse_piece(s)).collect();
        let hold = c.input.hold.as_deref().map(parse_piece);
        let o = &c.input.opts;
        let opts = Opts {
            budget_ms: o.budget_ms,
            node_budget: o.node_budget,
            max_branch: o.max_branch,
            cycle_solutions: o.cycle_solutions,
            cycle_node_cap: o.cycle_node_cap,
            tail_free: o.tail_free,
            max_disc: o.max_disc,
            frontier_band: o.frontier_band,
            allow_quad: o.allow_quad,
            sz_reserve: o.sz_reserve,
            partial_health: o.partial_health,
        };

        let t0 = std::time::Instant::now();
        let res = solve_lst_run(&board, &queue, hold, c.input.target, &opts)
            .unwrap_or_else(|| panic!("seed {}: rust returned None", c.seed));
        let rust_ms = t0.elapsed().as_secs_f64() * 1000.0;
        let exp = &c.output;

        assert_eq!(res.nodes, exp.nodes, "seed {}: node count", c.seed);
        assert_eq!(res.solved, exp.solved, "seed {}: solved", c.seed);
        assert_eq!(res.tsds, exp.tsds, "seed {}: tsds", c.seed);
        assert_eq!(res.mirrored, exp.mirrored, "seed {}: mirrored", c.seed);
        assert_eq!(
            res.moves.len(),
            exp.moves.len(),
            "seed {}: move count {} != TS {}",
            c.seed,
            res.moves.len(),
            exp.moves.len()
        );
        for (i, (g, e)) in res.moves.iter().zip(exp.moves.iter()).enumerate() {
            assert_eq!(g.piece.to_char().to_string(), e.piece, "seed {} move {i}: piece", c.seed);
            let gcells: Vec<[i32; 2]> = g.cells.iter().map(|&(x, y)| [x, y]).collect();
            assert_eq!(gcells, e.cells, "seed {} move {i}: cells", c.seed);
            assert_eq!(g.spin.as_str(), e.spin, "seed {} move {i}: spin", c.seed);
            assert_eq!(g.lines_cleared, e.lines_cleared, "seed {} move {i}: lines", c.seed);
            assert_eq!(g.before_key, e.before_key, "seed {} move {i}: beforeKey", c.seed);
            assert_eq!(g.is_tsd, e.is_tsd, "seed {} move {i}: isTsd", c.seed);
        }
        eprintln!(
            "seed {} tgt {}: parity OK — {} moves, {} tsds, {} nodes | TS {:.0}ms  Rust {:.1}ms  ({:.1}x)",
            c.seed,
            c.input.target,
            res.moves.len(),
            res.tsds,
            res.nodes,
            c.solve_ms,
            rust_ms,
            c.solve_ms / rust_ms.max(0.001),
        );
    }
}
