// Regenerates src/data/tki.json and src/data/lst-patterns.json from the
// four.lol page data snapshots in tools/data/ (Gatsby page-data JSON for
// https://four.lol/openers/tki/ and https://four.lol/stacking/lst/).
//
// Run: npm run gen:lst-db

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { decoder } from 'tetris-fumen';

const here = dirname(fileURLToPath(import.meta.url));

interface PatternPage {
  rows: string[];   // top-down, piece letters or X (gray) / _ (empty)
}
interface Pattern {
  fumen: string;
  pages: PatternPage[];
}
interface Section {
  heading: string;
  patterns: Pattern[];
}

function extract(name: 'tki' | 'lst'): Section[] {
  const pd = JSON.parse(readFileSync(join(here, 'data', `${name}-pd.json`), 'utf8'));
  const body: string = pd.result.data.mdx.body;
  const re = /mdx\(\s*"(h[23])",\s*\{[^}]*\},\s*"((?:[^"\\]|\\.)*)"\)|data:\s*"(v115@[^"]+)"/g;
  const sections: Section[] = [{ heading: 'Intro', patterns: [] }];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m[1]) {
      sections.push({ heading: m[2], patterns: [] });
    } else {
      const fumen = m[3].replace(/\?/g, '');
      try {
        const pages = decoder.decode(fumen).map((pg) => ({
          rows: pg.field.str({ reduced: true, garbage: false }).split('\n').filter((r) => r.length > 0),
        }));
        sections[sections.length - 1].patterns.push({ fumen, pages });
      } catch {
        // skip undecodable
      }
    }
  }
  return sections.filter((s) => s.patterns.length > 0);
}

const tkiSections = extract('tki');
const lstSections = extract('lst');

// ---- TKI targets ------------------------------------------------------
// Pre-TSD flat-top shapes (bag-order variants) that the opener drill grades
// against: "Basic Shape", "Using TKI" first pages and every "Follow-up
// Variations" shape. Cells are piece letters; the drill treats any letter as
// "must be filled", `_` as "must be empty".

function firstPageRows(p: Pattern): string[] {
  return p.pages[0].rows;
}

const targets: { name: string; rows: string[] }[] = [];
for (const sec of tkiSections) {
  if (/Basic Shape|Using TKI|Follow-up|Flat top continuation/i.test(sec.heading)) {
    for (const p of sec.patterns) {
      const rows = firstPageRows(p);
      // only keep plausible first-bag builds: height <= 5, no gray-only page
      if (rows.length <= 5 && rows.some((r) => /[LZSJIOT]/.test(r))) {
        targets.push({ name: sec.heading, rows });
      }
    }
  }
}
// dedupe by shape
const seen = new Set<string>();
const dedupedTargets = targets.filter((t) => {
  const k = t.rows.join('|');
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

// Post-TSD LST start board (flat-top TKI after the first TSD, J placed):
const LST_START = ['_______X__', 'X__XX_XXXX'];

writeFileSync(
  join(here, '..', 'src', 'data', 'tki.json'),
  JSON.stringify(
    {
      source: 'https://four.lol/openers/tki/',
      targets: dedupedTargets,
      lstStart: LST_START,
    },
    null,
    2,
  ),
);

writeFileSync(
  join(here, '..', 'src', 'data', 'lst-patterns.json'),
  JSON.stringify(
    {
      source: 'https://four.lol/stacking/lst/',
      tki: tkiSections,
      lst: lstSections,
    },
    null,
    2,
  ),
);

console.log(`tki.json: ${dedupedTargets.length} targets`);
console.log(`lst-patterns.json: tki ${tkiSections.length} sections, lst ${lstSections.length} sections`);
