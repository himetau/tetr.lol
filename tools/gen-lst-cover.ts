// Regenerates src/data/lst-cover.json from swng's cover-visualizer sfinder
// cover CSVs in tools/data/cover/ (flat-top LST: bag 1-2 builds + the bag-3
// build alternatives). Each CSV column is one solution fumen: a start field
// plus one placement per page. The queue->O/X cover matrix is NOT shipped;
// the engine re-derives queue feasibility at runtime with its own SRS+ move
// generator (see src/engine/book.ts), so the JSON stays small and matches
// the trainer's actual kick rules.
//
// Run: npm run gen:lst-cover

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { decoder } from "tetris-fumen";

const here = dirname(fileURLToPath(import.meta.url));
const coverDir = join(here, "data", "cover");

interface BookPlacement {
  piece: string;
  cells: [number, number][]; // absolute board coords, row 0 = bottom
  clears: number; // rows completed when placed in fumen order
}
interface BookSolution {
  name: string;
  fumen: string;
  coverPct: number; // share of 7-piece queues sfinder marked viable
  placements: BookPlacement[];
}
interface BookGroup {
  name: string;
  start: string[]; // rows top-down, X/_ (empty board = [])
  solutions: BookSolution[];
}

/** Minimal CSV field split honoring double-quoted fields (comment rows contain commas). */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function fieldRows(field: { str(o?: object): string }): string[] {
  return field
    .str({ reduced: true, garbage: false })
    .split("\n")
    .filter((r) => r.length > 0)
    .map((r) => r.replace(/[^_]/g, "X"));
}

function decodeSolution(fumen: string): { start: string[]; placements: BookPlacement[] } {
  const pages = decoder.decode(fumen);
  const start = fieldRows(pages[0].field);
  // stamp placements onto a scratch copy to count row completions
  const scratch = pages[0].field.copy();
  const placements: BookPlacement[] = [];
  for (const page of pages) {
    if (!page.operation) {
      continue;
    }
    const mino = page.mino();
    const cells = mino.positions().map((p) => [p.x, p.y] as [number, number]);
    for (const [x, y] of cells) {
      scratch.set(x, y, "X");
    }
    let clears = 0;
    for (const y of new Set(cells.map(([, cy]) => cy))) {
      let full = true;
      for (let x = 0; x < 10; x++) {
        if (scratch.at(x, y) === "_") {
          full = false;
        }
      }
      if (full) {
        clears++;
      }
    }
    placements.push({ piece: mino.type, cells, clears });
  }
  return { start, placements };
}

const groups: BookGroup[] = [];
const seenFumens = new Set<string>();

for (const file of readdirSync(coverDir)
  .filter((f) => f.endsWith(".csv"))
  .sort()) {
  const lines = readFileSync(join(coverDir, file), "utf8").trim().split("\n");
  const fumens = lines[0]
    .split(",")
    .slice(1)
    .map((s) => s.trim());
  // comment cells are image alt-texts like "L_tetramino > S_tetramino"
  const comments = splitCsv(lines[1])
    .slice(1)
    .map((s) => s.replace(/_tetramino/g, "").trim());
  const queueRows = lines.slice(2).map((l) => l.split(","));

  const group: BookGroup = { name: file.replace(/( cover)?\.csv$/, ""), start: [], solutions: [] };
  for (let i = 0; i < fumens.length; i++) {
    // e.g. minimals files repeat solutions
    if (seenFumens.has(fumens[i])) {
      continue;
    }
    seenFumens.add(fumens[i]);
    const { start, placements } = decodeSolution(fumens[i]);
    if (group.solutions.length === 0) {
      group.start = start;
    } else if (group.start.join("|") !== start.join("|")) {
      throw new Error(`${file}: solution ${i} start field differs from group start`);
    }
    const viable = queueRows.filter((r) => r[i + 1] === "O").length;
    // line clears before the final placement shift every later placement's
    // absolute coords, which the book cannot represent - skip those variants
    if (placements.some((p, j) => p.clears > 0 && j !== placements.length - 1)) {
      console.warn(`skip: ${file} solution ${i + 1} (${comments[i]}) clears lines mid-build`);
      continue;
    }
    group.solutions.push({
      name: comments[i] || `solution ${i + 1}`,
      fumen: fumens[i],
      coverPct: Math.round((viable / queueRows.length) * 1000) / 10,
      placements,
    });
  }
  if (group.solutions.length > 0) {
    groups.push(group);
  }
}

writeFileSync(
  join(here, "..", "src", "data", "lst-cover.json"),
  JSON.stringify(
    {
      source: "https://github.com/swng/cover-visualizer (flat-top LST sfinder cover data)",
      groups,
    },
    null,
    1,
  ),
);

for (const g of groups) {
  console.log(`${g.name}: ${g.solutions.length} solutions, start ${g.start.length} rows`);
  for (const s of g.solutions) {
    console.log(
      `  ${s.name}: ${s.placements.map((p) => p.piece).join("")} (${s.coverPct}% queues)`,
    );
  }
}
