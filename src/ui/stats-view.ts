// Stats page: accuracy trend over recent sessions (per mode), quick-play
// altitude per run, lifetime totals, and the recent-session log. Charts are
// inline SVG with a hover tooltip; the session table is the accessible
// fallback for everything the charts show.

import { stats, accuracy, gradeAccuracy, type Mode } from './stats';

const MODE_LABEL: Record<Mode, string> = {
  lst: 'LST drill (TKI → loop)',
  fourwide: '4-wide drill (combo book)',
  free: 'Freeplay',
  quick: 'Quick play',
  allspin: 'All-Spin trainer',
};

const SHORT_LABEL: Record<Mode, string> = { lst: 'LST', fourwide: '4-wide', free: 'Freeplay', quick: 'Quick play', allspin: 'All-Spin' };

// validated against the app card surfaces (light #faf8f2 / dark #30302e):
// all checks pass incl. CVD separation and 3:1 contrast
const SERIES_VAR: Record<Mode, string> = {
  lst: 'var(--series-lst)',
  fourwide: 'var(--series-fourwide)',
  free: 'var(--series-free)',
  quick: 'var(--series-lst)',
  allspin: 'var(--series-fourwide)',
};

const TREND_WINDOW = 40;

interface ChartPoint {
  x: number;               // slot in the shared x order
  y: number;               // data value
  label: string;           // tooltip text
}

interface ChartSeries {
  name: string;
  color: string;
  points: ChartPoint[];
}

export function statsView(): HTMLElement {
  const page = document.createElement('div');
  page.className = 'page';
  page.innerHTML = `<h1>Stats</h1><p class="sub">progress over time and lifetime numbers, stored locally</p>`;

  // ---- accuracy trend ----
  const graded = stats.sessions.filter((s) => s.mode !== 'quick').slice(-TREND_WINDOW);
  const trend = card('Accuracy trend');
  if (graded.length < 2) {
    trend.appendChild(emptyNote('finish a couple of drills (5+ graded placements each) and the trend appears here'));
  } else {
    const modes = [...new Set(graded.map((s) => s.mode))] as Mode[];
    const series: ChartSeries[] = modes.map((m) => ({
      name: SHORT_LABEL[m],
      color: SERIES_VAR[m],
      points: graded
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => s.mode === m)
        .map(({ s, i }) => ({
          x: i,
          y: gradeAccuracy(s.grades) * 100,
          label: `${fmtDate(s.at)} · ${SHORT_LABEL[s.mode]} · ${(gradeAccuracy(s.grades) * 100).toFixed(0)}% · ${s.pieces} pieces · ${s.tsds} TSD`,
        })),
    })).filter((s) => s.points.length > 0);
    trend.appendChild(lineChart(series, {
      slots: graded.length,
      yTicks: [0, 25, 50, 75, 100],
      yFmt: (v) => `${v}%`,
    }));
  }
  page.appendChild(trend);

  // ---- quick play altitude ----
  const runs = stats.sessions.filter((s) => s.mode === 'quick' && s.altitude !== undefined).slice(-TREND_WINDOW);
  if (runs.length >= 2) {
    const alt = card('Quick play — altitude per run');
    const top = Math.max(...runs.map((r) => r.altitude!));
    const yMax = Math.max(100, Math.ceil(top / 100) * 100);
    alt.appendChild(lineChart([{
      name: 'altitude',
      color: SERIES_VAR.quick,
      points: runs.map((s, i) => ({
        x: i,
        y: s.altitude!,
        label: `${fmtDate(s.at)} · ${Math.round(s.altitude!)}m · ${s.pieces} pieces`,
      })),
    }], {
      slots: runs.length,
      yTicks: [0, yMax / 4, yMax / 2, (3 * yMax) / 4, yMax],
      yFmt: (v) => `${Math.round(v)}m`,
    }));
    page.appendChild(alt);
  }

  // ---- lifetime table ----
  const life = card('Lifetime');
  const table = document.createElement('table');
  table.className = 'stats';
  table.innerHTML = `<tr><th>mode</th><th>drills</th><th>pieces</th><th>TSD</th><th>best</th><th>good</th><th>inacc</th><th>mistake</th><th>killer</th><th>accuracy</th></tr>`;
  for (const m of ['lst', 'fourwide', 'free', 'quick'] as Mode[]) {
    if (m === 'fourwide' && stats.modes[m].drills === 0) continue;
    const s = stats.modes[m];
    if (m === 'quick' && s.drills === 0) continue;
    const g = s.grades;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${MODE_LABEL[m]}</td><td>${s.drills}</td><td>${s.pieces}</td><td>${s.tsds}</td>` +
      `<td>${g.best}</td><td>${g.good}</td><td>${g.inaccuracy}</td><td>${g.mistake}</td><td>${g.killer}</td>` +
      `<td><b>${(accuracy(s) * 100).toFixed(1)}%</b></td>`;
    table.appendChild(tr);
  }
  life.appendChild(table);
  page.appendChild(life);

  // ---- recent sessions ----
  const recent = stats.sessions.slice(-12).reverse();
  const log = card('Recent sessions');
  if (recent.length === 0) {
    log.appendChild(emptyNote('no sessions yet'));
  } else {
    const t = document.createElement('table');
    t.className = 'stats';
    t.innerHTML = `<tr><th>when</th><th>mode</th><th>pieces</th><th>TSD</th><th>result</th></tr>`;
    for (const s of recent) {
      const tr = document.createElement('tr');
      const result = s.mode === 'quick'
        ? `${Math.round(s.altitude ?? 0)}m`
        : s.mode === 'fourwide' && s.maxCombo !== undefined
          ? `${(gradeAccuracy(s.grades) * 100).toFixed(0)}% · combo ×${s.maxCombo}`
          : `${(gradeAccuracy(s.grades) * 100).toFixed(0)}% accuracy`;
      tr.innerHTML = `<td>${fmtDate(s.at)}</td><td>${SHORT_LABEL[s.mode]}</td><td>${s.pieces}</td><td>${s.tsds}</td><td><b>${result}</b></td>`;
      t.appendChild(tr);
    }
    log.appendChild(t);
  }
  page.appendChild(log);

  return page;
}

// ---- chart plumbing ----

const VB_W = 720;
const VB_H = 220;
const PAD = { l: 44, r: 14, t: 12, b: 20 };

function lineChart(series: ChartSeries[], opts: { slots: number; yTicks: number[]; yFmt: (v: number) => string }): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';

  // legend only when there are multiple series; color never carries
  // identity alone (the tooltip and table name the mode too)
  if (series.length > 1) {
    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    for (const s of series) {
      const chip = document.createElement('span');
      chip.className = 'legend-chip';
      chip.innerHTML = `<i style="background:${s.color}"></i>${s.name}`;
      legend.appendChild(chip);
    }
    wrap.appendChild(legend);
  }

  const yMax = Math.max(...opts.yTicks);
  const plotW = VB_W - PAD.l - PAD.r;
  const plotH = VB_H - PAD.t - PAD.b;
  const px = (slot: number) => PAD.l + (opts.slots === 1 ? plotW / 2 : (slot / (opts.slots - 1)) * plotW);
  const py = (v: number) => PAD.t + plotH - (v / yMax) * plotH;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${VB_W} ${VB_H}`);
  svg.classList.add('chart');

  let grid = '';
  let yLabels = '';
  for (const t of opts.yTicks) {
    const y = py(t);
    grid += `<line x1="${PAD.l}" y1="${y}" x2="${VB_W - PAD.r}" y2="${y}" class="gridline"/>`;
    yLabels += `<text x="${PAD.l - 8}" y="${y + 3.5}" text-anchor="end" class="tick">${opts.yFmt(t)}</text>`;
  }
  let marks = '';
  for (const s of series) {
    const d = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.x).toFixed(1)} ${py(p.y).toFixed(1)}`).join(' ');
    marks += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    for (const p of s.points) {
      marks += `<circle cx="${px(p.x).toFixed(1)}" cy="${py(p.y).toFixed(1)}" r="3" fill="${s.color}" stroke="var(--bg-raised)" stroke-width="1.5"/>`;
    }
  }
  svg.innerHTML = grid + yLabels + marks;
  wrap.appendChild(svg);

  // hover: nearest point across all series -> ring + tooltip
  const tip = document.createElement('div');
  tip.className = 'chart-tooltip';
  wrap.appendChild(tip);
  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  ring.setAttribute('r', '6');
  ring.setAttribute('fill', 'none');
  ring.setAttribute('stroke-width', '2');
  ring.style.display = 'none';
  svg.appendChild(ring);

  const all = series.flatMap((s) => s.points.map((p) => ({ ...p, color: s.color })));
  svg.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const mx = ((e.clientX - r.left) / r.width) * VB_W;
    const my = ((e.clientY - r.top) / r.height) * VB_H;
    // nearest by x (crosshair-style), y only breaks ties between series
    let nearest = all[0];
    let bd = Infinity;
    for (const p of all) {
      const d = Math.abs(px(p.x) - mx) * 1000 + Math.abs(py(p.y) - my);
      if (d < bd) { bd = d; nearest = p; }
    }
    if (!nearest || bd > 50 * 1000) {
      ring.style.display = 'none';
      tip.classList.remove('show');
      return;
    }
    ring.style.display = '';
    ring.setAttribute('cx', String(px(nearest.x)));
    ring.setAttribute('cy', String(py(nearest.y)));
    ring.setAttribute('stroke', nearest.color);
    tip.textContent = nearest.label;
    tip.classList.add('show');
    const tx = (px(nearest.x) / VB_W) * r.width;
    tip.style.left = `${Math.min(Math.max(tx, 70), r.width - 70)}px`;
    tip.style.top = `${(py(nearest.y) / VB_H) * r.height - 34}px`;
  });
  svg.addEventListener('mouseleave', () => {
    ring.style.display = 'none';
    tip.classList.remove('show');
  });

  return wrap;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function card(title: string): HTMLElement {
  const c = document.createElement('div');
  c.className = 'card';
  const h = document.createElement('h2');
  h.textContent = title;
  c.appendChild(h);
  return c;
}

function emptyNote(text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = 'chart-empty';
  p.textContent = text;
  return p;
}
