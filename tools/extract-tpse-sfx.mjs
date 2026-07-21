// Extract selected sounds from a tetrio-plus .tpse soundpack into
// public/sfx/<name>.ogg. The pack stores one big OGG sprite (data URI) plus
// customSoundAtlas: { name: [startMs, durationMs] }.
//
//   node tools/extract-tpse-sfx.mjs "<path to .tpse>" [outdir]
//
// Requires ffmpeg on PATH.

import { readFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

// every sound the app plays; keep in sync with src/ui/sound.ts SfxName
const WANTED = [
  "move",
  "rotate",
  "harddrop",
  "softdrop",
  "hold",
  "floor",
  "spin",
  "clearline",
  "clearquad",
  "clearspin",
  "clearbtb",
  "allclear",
  "btb_1",
  "btb_2",
  "btb_3",
  "btb_break",
  "combobreak",
  "garbage_in_small",
  "garbage_in_medium",
  "garbage_in_large",
  "garbagerise",
  "garbagesmash",
  "damage_alert",
  "topout",
  "go",
  // mistake cues
  "no",
  "failure",
  // milestones & immersion
  "personalbest",
  "levelup",
  "gameover",
  "clutch",
  "applause",
  "hyperalert",
  // rolling-thunder spike cues for big sends (the "nuke")
  "thunder1",
  "thunder2",
  "thunder3",
  "thunder4",
  "thunder5",
  "thunder6",
  "countdown1",
  "countdown2",
  "countdown3",
  // escalating combo jingles (plus "power" variants for spin/quad clears)
  ...Array.from({ length: 16 }, (_, i) => `combo_${i + 1}`),
  ...Array.from({ length: 16 }, (_, i) => `combo_${i + 1}_power`),
];

const tpsePath = process.argv[2];
const outDir = process.argv[3] ?? "public/sfx";
if (!tpsePath) {
  console.error("usage: node tools/extract-tpse-sfx.mjs <pack.tpse> [outdir]");
  process.exit(1);
}

const pack = JSON.parse(readFileSync(tpsePath, "utf8"));
const atlas = pack.customSoundAtlas;
const dataUri = pack.customSounds;
if (!atlas || !dataUri?.startsWith("data:audio/")) {
  console.error("no customSounds/customSoundAtlas in this pack");
  process.exit(1);
}

const sprite = join(tmpdir(), "tpse-sprite.ogg");
writeFileSync(sprite, Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1), "base64"));
mkdirSync(outDir, { recursive: true });

let total = 0;
for (const name of WANTED) {
  const entry = atlas[name];
  if (!entry) {
    console.warn(`SKIP ${name} - not in pack`);
    continue;
  }
  const [startMs, durMs] = entry;
  const out = join(outDir, `${name}.ogg`);
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-ss",
    String(startMs / 1000),
    "-t",
    String(durMs / 1000),
    "-i",
    sprite,
    "-c:a",
    "libvorbis",
    "-q:a",
    "3",
    out,
  ]);
  const kb = statSync(out).size / 1024;
  total += kb;
  console.log(`${name}.ogg  ${kb.toFixed(1)} kB`);
}
console.log(`-> ${outDir}: ${total.toFixed(0)} kB total`);
