//! JSON-in / JSON-out entry point for solve_lst_run, shared by the wasm binding
//! and native callers (harvest tools). Field names match the TS SolveOptions /
//! SolveResult so the browser and Node can call it as a drop-in for solveLstRun.

use crate::board::Board;
use crate::pieces::PieceType;
use crate::solver::{solve_lst_run, Opts};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ApiOpts {
    budget_ms: Option<u64>,
    node_budget: Option<i64>,
    max_branch: Option<usize>,
    cycle_solutions: Option<i64>,
    cycle_node_cap: Option<i64>,
    tail_free: Option<i32>,
    max_disc: Option<i32>,
    frontier_band: Option<i32>,
    allow_quad: Option<bool>,
    sz_reserve: Option<i64>,
    partial_health: Option<bool>,
    left_o_cap_horizon: Option<i32>,
}

impl ApiOpts {
    fn resolve(self) -> Opts {
        let d = Opts::default();
        Opts {
            budget_ms: self.budget_ms.unwrap_or(d.budget_ms),
            node_budget: self.node_budget.unwrap_or(d.node_budget),
            max_branch: self.max_branch.unwrap_or(d.max_branch),
            cycle_solutions: self.cycle_solutions.unwrap_or(d.cycle_solutions),
            cycle_node_cap: self.cycle_node_cap.unwrap_or(d.cycle_node_cap),
            tail_free: self.tail_free.unwrap_or(d.tail_free),
            max_disc: self.max_disc.unwrap_or(d.max_disc),
            frontier_band: self.frontier_band.unwrap_or(d.frontier_band),
            allow_quad: self.allow_quad.unwrap_or(d.allow_quad),
            sz_reserve: self.sz_reserve.unwrap_or(d.sz_reserve),
            partial_health: self.partial_health.unwrap_or(d.partial_health),
            left_o_cap_horizon: self.left_o_cap_horizon.unwrap_or(d.left_o_cap_horizon),
        }
    }
}

#[derive(Deserialize)]
struct ApiInput {
    rows: Vec<u32>,
    queue: Vec<String>,
    hold: Option<String>,
    target: i32,
    #[serde(default)]
    opts: ApiOpts,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiMove {
    piece: String,
    cells: Vec<[i32; 2]>,
    spin: String,
    lines_cleared: i32,
    before_key: String,
    is_tsd: bool,
}

#[derive(Serialize)]
struct ApiOutput {
    moves: Vec<ApiMove>,
    tsds: i32,
    solved: bool,
    mirrored: bool,
    nodes: i64,
}

fn parse_piece(s: &str) -> Option<PieceType> {
    s.chars().next().and_then(PieceType::from_char)
}

/// Solve from a JSON request; returns a JSON SolveResult, or `"null"` when the
/// position is not an LST state (either handedness). Errors serialize as
/// `{"error": "..."}`.
pub fn solve_json(input: &str) -> String {
    let req: ApiInput = match serde_json::from_str(input) {
        Ok(v) => v,
        Err(e) => return format!("{{\"error\":{}}}", json_str(&e.to_string())),
    };
    if req.rows.len() != 26 {
        return "{\"error\":\"rows must have length 26\"}".to_string();
    }
    let mut board = Board::new();
    board.rows.copy_from_slice(&req.rows);
    let mut queue = Vec::with_capacity(req.queue.len());
    for q in &req.queue {
        match parse_piece(q) {
            Some(p) => queue.push(p),
            None => return format!("{{\"error\":\"bad queue piece {}}}\"", json_str(q)),
        }
    }
    let hold = match req.hold.as_deref() {
        None => None,
        Some(h) => match parse_piece(h) {
            Some(p) => Some(p),
            None => return format!("{{\"error\":\"bad hold {}}}\"", json_str(h)),
        },
    };
    let opts = req.opts.resolve();

    match solve_lst_run(&board, &queue, hold, req.target, &opts) {
        None => "null".to_string(),
        Some(res) => {
            let out = ApiOutput {
                moves: res
                    .moves
                    .into_iter()
                    .map(|m| ApiMove {
                        piece: m.piece.to_char().to_string(),
                        cells: m.cells.iter().map(|&(x, y)| [x, y]).collect(),
                        spin: m.spin.as_str().to_string(),
                        lines_cleared: m.lines_cleared,
                        before_key: m.before_key,
                        is_tsd: m.is_tsd,
                    })
                    .collect(),
                tsds: res.tsds,
                solved: res.solved,
                mirrored: res.mirrored,
                nodes: res.nodes,
            };
            serde_json::to_string(&out).unwrap_or_else(|_| "null".to_string())
        }
    }
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}
