// Rotating full-window backgrounds behind the app, tetr.io style: a set of
// built-in generated scenes, or the user's own images. Custom images are
// stored as blobs in IndexedDB so they survive restarts (works on file:// in
// the packaged Electron build too). A theme-colored dim overlay keeps the UI
// readable; the aurora glow takes over when no image background is active.

import { settings, onSettingsChange } from './settings';

// ---- custom image store (IndexedDB) ----

// predates the tetr.ai rename — kept so stored backgrounds survive
const DB_NAME = 'lst-trainer-bg';
const STORE = 'images';

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { autoIncrement: true });
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function tx(db: IDBDatabase, mode: IDBTransactionMode, run: (s: IDBObjectStore) => void): Promise<void> {
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    run(t.objectStore(STORE));
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

async function dbAll(): Promise<Blob[]> {
  const db = await openDb();
  return new Promise((res, rej) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => res(req.result as Blob[]);
    req.onerror = () => rej(req.error);
  });
}

// ---- built-in scenes (generated SVG, Catppuccin-leaning hues) ----

/** tiny deterministic rng so the star fields are stable across loads */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function stars(n: number, seed: number, maxY = 900, color = '#cdd6f4'): string {
  const rnd = lcg(seed);
  let out = '';
  for (let i = 0; i < n; i++) {
    const r = rnd() < 0.85 ? 1 + rnd() : 2 + rnd() * 1.5;
    out += `<circle cx='${(rnd() * 1600).toFixed(0)}' cy='${(rnd() * maxY).toFixed(0)}' r='${r.toFixed(1)}' fill='${color}' opacity='${(0.15 + rnd() * 0.55).toFixed(2)}'/>`;
  }
  return out;
}

function svgUrl(body: string): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='1600' height='900' viewBox='0 0 1600 900'>${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

const BLUR = `<filter id='b' x='-40%' y='-40%' width='180%' height='180%'><feGaussianBlur stdDeviation='90'/></filter>`;

const SCENES: string[] = [
  // nebula — mauve/blue/teal clouds over deep space
  svgUrl(`<rect width='1600' height='900' fill='#0f0f1c'/>${BLUR}
    <g filter='url(#b)'>
      <circle cx='420' cy='280' r='300' fill='#cba6f7' opacity='0.34'/>
      <circle cx='1220' cy='620' r='340' fill='#89b4fa' opacity='0.3'/>
      <circle cx='950' cy='180' r='200' fill='#94e2d5' opacity='0.22'/>
      <circle cx='260' cy='740' r='240' fill='#f5c2e7' opacity='0.2'/>
    </g>${stars(150, 7)}`),
  // dusk peaks — layered ridges under a moonlit gradient
  svgUrl(`<defs><linearGradient id='s' x1='0' y1='0' x2='0' y2='1'>
      <stop offset='0' stop-color='#181825'/><stop offset='0.6' stop-color='#313253'/><stop offset='1' stop-color='#585b70'/>
    </linearGradient></defs>
    <rect width='1600' height='900' fill='url(#s)'/>${BLUR}
    <circle cx='1180' cy='190' r='46' fill='#f9e2af' opacity='0.9'/>
    <circle cx='1180' cy='190' r='90' fill='#f9e2af' opacity='0.25' filter='url(#b)'/>
    ${stars(90, 11, 500)}
    <polygon points='0,900 0,560 220,420 430,590 640,400 830,620 1050,470 1290,650 1470,520 1600,600 1600,900' fill='#1e1e2e'/>
    <polygon points='0,900 0,700 260,560 520,730 780,570 1040,760 1330,620 1600,740 1600,900' fill='#181825'/>
    <polygon points='0,900 0,810 340,690 700,840 1060,710 1400,850 1600,780 1600,900' fill='#11111b'/>`),
  // aurora — green/teal curtains over a dark sky
  svgUrl(`<rect width='1600' height='900' fill='#0d1117'/>${BLUR}
    <g filter='url(#b)'>
      <ellipse cx='500' cy='260' rx='520' ry='110' fill='#a6e3a1' opacity='0.3' transform='rotate(-14 500 260)'/>
      <ellipse cx='1000' cy='380' rx='560' ry='120' fill='#94e2d5' opacity='0.26' transform='rotate(-10 1000 380)'/>
      <ellipse cx='1300' cy='210' rx='420' ry='90' fill='#89dceb' opacity='0.2' transform='rotate(-16 1300 210)'/>
    </g>${stars(130, 23)}
    <polygon points='0,900 0,830 400,760 900,860 1300,790 1600,840 1600,900' fill='#0a0d12'/>`),
  // deep waves — layered blue swells
  svgUrl(`<rect width='1600' height='900' fill='#11111b'/>${BLUR}
    <g filter='url(#b)'><circle cx='800' cy='120' r='260' fill='#b4befe' opacity='0.16'/></g>
    ${stars(70, 41, 420)}
    <path d='M0,520 C300,460 500,600 800,540 C1100,480 1300,620 1600,560 L1600,900 L0,900 Z' fill='#1e2030' opacity='0.9'/>
    <path d='M0,640 C300,580 550,720 850,660 C1150,600 1350,730 1600,670 L1600,900 L0,900 Z' fill='#24273a' opacity='0.9'/>
    <path d='M0,760 C350,700 600,830 900,780 C1200,730 1400,840 1600,790 L1600,900 L0,900 Z' fill='#181825'/>`),
  // ember dunes — warm peach glow on dark sand
  svgUrl(`<defs><linearGradient id='d' x1='0' y1='0' x2='0' y2='1'>
      <stop offset='0' stop-color='#181420'/><stop offset='1' stop-color='#2c1f2b'/>
    </linearGradient></defs>
    <rect width='1600' height='900' fill='url(#d)'/>${BLUR}
    <g filter='url(#b)'><circle cx='400' cy='430' r='230' fill='#fab387' opacity='0.3'/></g>
    ${stars(80, 57, 400)}
    <path d='M0,560 C400,480 700,640 1100,560 C1350,510 1500,570 1600,540 L1600,900 L0,900 Z' fill='#332433' opacity='0.9'/>
    <path d='M0,700 C350,630 750,760 1150,690 C1400,650 1550,710 1600,690 L1600,900 L0,900 Z' fill='#251a26'/>
    <path d='M0,820 C450,760 900,860 1300,800 L1600,830 L1600,900 L0,900 Z' fill='#191019'/>`),
];

// ---- the layer ----

let layerA: HTMLElement | undefined;
let layerB: HTMLElement | undefined;
let dimEl: HTMLElement | undefined;
let front = 0; // which layer is currently visible
let cycleTimer = 0;
let customUrls: string[] = [];
let idx = 0;
let currentImage = '';

function activeList(): string[] {
  const bg = settings.background;
  if (bg.mode === 'custom') return customUrls.length ? customUrls.map((u) => `url("${u}")`) : SCENES;
  if (bg.mode === 'scenes') return SCENES;
  return [];
}

function showImage(img: string, instant = false): void {
  if (!layerA || !layerB) return;
  if (img === currentImage) return;
  currentImage = img;
  const inc = front === 0 ? layerB : layerA;
  const out = front === 0 ? layerA : layerB;
  front = 1 - front;
  inc.style.backgroundImage = img;
  if (instant) inc.style.transition = 'none';
  inc.classList.add('show');
  if (instant) {
    void inc.offsetWidth;
    inc.style.transition = '';
  }
  out.classList.remove('show');
}

function apply(): void {
  const list = activeList();
  document.body.classList.toggle('has-bg', list.length > 0);
  if (dimEl) dimEl.style.opacity = String(settings.background.dim / 100);
  clearInterval(cycleTimer);
  if (list.length === 0) {
    currentImage = '';
    layerA?.classList.remove('show');
    layerB?.classList.remove('show');
    return;
  }
  showImage(list[idx % list.length]);
  if (list.length > 1) {
    cycleTimer = window.setInterval(() => {
      const l = activeList();
      if (l.length === 0) return;
      idx = (idx + 1) % l.length;
      showImage(l[idx]);
    }, Math.max(15, settings.background.cycleSec) * 1000);
  }
}

/** Mount the background layer and start cycling. Call once at startup. */
export function initBackground(): void {
  const root = document.createElement('div');
  root.className = 'bg-root';
  layerA = document.createElement('div');
  layerA.className = 'bg-img';
  layerB = document.createElement('div');
  layerB.className = 'bg-img';
  dimEl = document.createElement('div');
  dimEl.className = 'bg-dim';
  root.append(layerA, layerB, dimEl);
  document.body.prepend(root);
  idx = (Math.random() * 1000) | 0; // start on a random scene, like tetr.io
  apply();
  onSettingsChange(apply);
  void dbAll().then((blobs) => {
    customUrls = blobs.map((b) => URL.createObjectURL(b));
    apply();
  });
}

/** Skip to the next background right away (settings preview). */
export function nextBackground(): void {
  const list = activeList();
  if (list.length === 0) return;
  idx = (idx + 1) % list.length;
  apply();
}

export function customImageCount(): number {
  return customUrls.length;
}

/** Store user-picked images; they join the cycle immediately. */
export async function addCustomImages(files: FileList | File[]): Promise<number> {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  if (images.length === 0) return 0;
  const db = await openDb();
  await tx(db, 'readwrite', (s) => {
    for (const f of images) s.add(f);
  });
  for (const f of images) customUrls.push(URL.createObjectURL(f));
  apply();
  return images.length;
}

/** Forget every stored custom image. */
export async function clearCustomImages(): Promise<void> {
  const db = await openDb();
  await tx(db, 'readwrite', (s) => s.clear());
  for (const u of customUrls) URL.revokeObjectURL(u);
  customUrls = [];
  apply();
}
