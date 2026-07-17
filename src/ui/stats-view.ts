// Stats page: one progress chart per mode, each tracking the number that mode
// is actually about — LST accuracy, 4-wide combo, all-spin B2B chain, 40 lines
// time, quick play altitude, 1v1 round share — plus lifetime totals and the
// recent-session log. Charts are inline SVG polylines with a crosshair +
// tooltip; the tables are the accessible fallback for everything the charts
// show. Only ranked sessions are ever recorded (no undo, no bot assist), so
// the charts need no filtering.

import { stats, accuracy, gradeAccuracy, gradeTotal, sessionPps, resetStats, fmtSprint, type Mode, type SessionRecord } from './stats';

const MODE_LABEL: Record<Mode, string> = {
  lst: 'LST drill (TKI → loop)',
  fourwide: '4-wide drill (combo book)',
  free: '40 Lines',
  quick: 'Quick play',
  allspin: 'All-Spin trainer',
  versus: '1v1 vs Cold Clear',
};

const SHORT_LABEL: Record<Mode, string> = { lst: 'LST', fourwide: '4-wide', free: '40 Lines', quick: 'Quick play', allspin: 'All-Spin', versus: '1v1' };

// one color per mode — each chart is single-series, so the colors only carry
// identity next to text (card titles, table dots), never alone
const SERIES_VAR: Record<Mode, string> = {
  lst: 'var(--series-lst)',
  fourwide: 'var(--series-fourwide)',
  free: 'var(--series-free)',
  quick: 'var(--series-quick)',
  allspin: 'var(--series-allspin)',
  versus: 'var(--series-versus)',
};

const TREND_WINDOW = 40;

interface ChartPoint {
  x: number;               // slot in the x order
  y: number;               // data value
  label: string;           // tooltip text
}

/** Percent ticks for accuracy / win-share charts. */
const PCT_TICKS = [0, 25, 50, 75, 100];

/** yMax rounded up to a multiple of `step` quarters, so ticks stay integers. */
function quarterTicks(top: number, minMax: number, step: number): number[] {
  const yMax = Math.max(minMax, Math.ceil(top / step) * step);
  return [0, yMax / 4, yMax / 2, (3 * yMax) / 4, yMax];
}

/** "· 2.31 pps" suffix when the session has one, else "". */
function ppsTag(s: SessionRecord): string {
  const pps = sessionPps(s);
  return pps ? ` · ${pps.toFixed(2)} pps` : '';
}

export function statsView(): HTMLElement {
  const page = document.createElement('div');
  page.className = 'page';
  page.innerHTML = `<h1>Stats</h1><p class="sub">progress over time and lifetime numbers, stored locally — only ranked sessions count (no undo, no bot)</p>`;

  const of = (m: Mode) => stats.sessions.filter((s) => s.mode === m);
  const chartCard = (title: string, color: string, points: ChartPoint[], yTicks: number[], yFmt: (v: number) => string, few: string) => {
    const c = card(title);
    if (points.length < 2) {
      c.appendChild(emptyNote(few));
    } else {
      c.appendChild(lineChart({ color, points: points.slice(-TREND_WINDOW).map((p, i) => ({ ...p, x: i })) }, {
        slots: Math.min(points.length, TREND_WINDOW),
        yTicks,
        yFmt,
      }));
    }
    page.appendChild(c);
  };

  // ---- LST: the drill is about clean loop placements → accuracy ----
  const lst = of('lst').filter((s) => gradeTotal(s.grades) > 0);
  if (lst.length > 0) {
    chartCard('LST drill — accuracy per session', SERIES_VAR.lst,
      lst.map((s) => ({
        x: 0,
        y: gradeAccuracy(s.grades) * 100,
        label: `${fmtDate(s.at)} · ${(gradeAccuracy(s.grades) * 100).toFixed(0)}% · ${s.pieces} pieces · ${s.tsds} TSD${ppsTag(s)}`,
      })),
      PCT_TICKS, (v) => `${v}%`,
      'finish one more ranked LST drill and the trend appears here');
  }

  // ---- 4-wide: the drill is about the combo → longest combo per session ----
  const fw = of('fourwide').filter((s) => s.maxCombo !== undefined);
  if (fw.length > 0) {
    const top = Math.max(...fw.map((s) => s.maxCombo!));
    chartCard('4-wide — longest combo per session', SERIES_VAR.fourwide,
      fw.map((s) => ({
        x: 0,
        y: s.maxCombo!,
        label: `${fmtDate(s.at)} · combo ×${s.maxCombo} · ${s.pieces} pieces${ppsTag(s)}`,
      })),
      quarterTicks(top, 8, 4), (v) => `×${Math.round(v)}`,
      'finish one more ranked 4-wide drill and the trend appears here');
  }

  // ---- all-spin: the drill is about keeping the chain → best B2B ----
  // (accuracy fallback for stats recorded before B2B tracking existed)
  const asB2b = of('allspin').filter((s) => s.maxB2b !== undefined);
  const asAcc = of('allspin').filter((s) => gradeTotal(s.grades) > 0);
  if (asB2b.length >= 2 || (asB2b.length > 0 && asAcc.length < 2)) {
    const top = Math.max(...asB2b.map((s) => s.maxB2b!));
    chartCard('All-Spin — best B2B chain per session', SERIES_VAR.allspin,
      asB2b.map((s) => ({
        x: 0,
        y: s.maxB2b!,
        label: `${fmtDate(s.at)} · B2B ×${s.maxB2b} · ${(gradeAccuracy(s.grades) * 100).toFixed(0)}% · ${s.pieces} pieces${ppsTag(s)}`,
      })),
      quarterTicks(top, 8, 4), (v) => `×${Math.round(v)}`,
      'finish one more ranked all-spin drill and the trend appears here');
  } else if (asAcc.length > 0) {
    chartCard('All-Spin — accuracy per session', SERIES_VAR.allspin,
      asAcc.map((s) => ({
        x: 0,
        y: gradeAccuracy(s.grades) * 100,
        label: `${fmtDate(s.at)} · ${(gradeAccuracy(s.grades) * 100).toFixed(0)}% · ${s.pieces} pieces${ppsTag(s)}`,
      })),
      PCT_TICKS, (v) => `${v}%`,
      'finish one more ranked all-spin drill and the trend appears here');
  }

  // ---- 40 lines: time per finished run ----
  const sprints = of('free').filter((s) => s.sprintMs !== undefined);
  if (sprints.length > 0) {
    const slowest = Math.max(...sprints.map((r) => r.sprintMs!)) / 1000;
    chartCard('40 Lines — time per run', SERIES_VAR.free,
      sprints.map((s) => ({
        x: 0,
        y: s.sprintMs! / 1000,
        label: `${fmtDate(s.at)} · ${fmtSprint(s.sprintMs!)} · ${s.pieces} pieces${ppsTag(s)}`,
      })),
      quarterTicks(slowest, 60, 20), (v) => fmtSprint(v * 1000, false),
      'finish one more 40 lines run and the trend appears here');
  }

  // ---- quick play: altitude per run ----
  const runs = of('quick').filter((s) => s.altitude !== undefined);
  if (runs.length > 0) {
    const top = Math.max(...runs.map((r) => r.altitude!));
    chartCard('Quick play — altitude per run', SERIES_VAR.quick,
      runs.map((s) => ({
        x: 0,
        y: s.altitude!,
        label: `${fmtDate(s.at)} · ${Math.round(s.altitude!)}m · ${s.pieces} pieces${ppsTag(s)}`,
      })),
      quarterTicks(top, 100, 100), (v) => `${Math.round(v)}m`,
      'finish one more quick play run and the trend appears here');
  }

  // ---- 1v1: share of rounds taken per match ----
  const matches = of('versus').filter((s) => (s.wins ?? 0) + (s.losses ?? 0) > 0);
  if (matches.length > 0) {
    chartCard('1v1 — rounds taken per match', SERIES_VAR.versus,
      matches.map((s) => {
        const w = s.wins ?? 0;
        const l = s.losses ?? 0;
        return {
          x: 0,
          y: (w / (w + l)) * 100,
          label: `${fmtDate(s.at)} · ${w > l ? 'won' : 'lost'} ${w}–${l} · ${s.pieces} pieces${ppsTag(s)}`,
        };
      }),
      PCT_TICKS, (v) => `${v}%`,
      'finish one more 1v1 match and the trend appears here');
  }

  if (stats.sessions.length === 0) {
    const empty = card('Progress');
    empty.appendChild(emptyNote('finish a couple of ranked sessions (5+ placements, no undo/bot — retry, top out, or leave the drill records it) and per-mode trends appear here'));
    page.appendChild(empty);
  }

  // ---- lifetime table ----
  const life = card('Lifetime');
  const played = (['lst', 'fourwide', 'free', 'quick', 'allspin', 'versus'] as Mode[]).filter((m) => stats.modes[m].pieces > 0 || stats.modes[m].drills > 0);
  if (played.length === 0) {
    life.appendChild(emptyNote('no ranked sessions yet'));
  } else {
    const table = document.createElement('table');
    table.className = 'stats';
    table.innerHTML = `<tr><th>mode</th><th>drills</th><th>pieces</th><th>TSD</th><th>accuracy</th><th>avg PPS</th><th>record</th></tr>`;
    for (const m of played) {
      const s = stats.modes[m];
      const sessions = of(m);
      const ppsVals = sessions.map(sessionPps).filter((v): v is number => v !== null);
      const avgPps = ppsVals.length > 0 ? (ppsVals.reduce((a, b) => a + b, 0) / ppsVals.length).toFixed(2) : '—';
      const acc = gradeTotal(s.grades) > 0 ? `${(accuracy(s) * 100).toFixed(1)}%` : '—';
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${modeDot(m)}${MODE_LABEL[m]}</td><td>${s.drills}</td><td>${s.pieces}</td><td>${s.tsds}</td>` +
        `<td>${acc}</td><td>${avgPps}</td><td><b>${modeRecord(m, sessions)}</b></td>`;
      table.appendChild(tr);
    }
    life.appendChild(table);
  }
  page.appendChild(life);

  // ---- recent sessions ----
  const recent = stats.sessions.slice(-12).reverse();
  const log = card('Recent sessions');
  if (recent.length === 0) {
    log.appendChild(emptyNote('no ranked sessions yet'));
  } else {
    const t = document.createElement('table');
    t.className = 'stats';
    t.innerHTML = `<tr><th>when</th><th>mode</th><th>pieces</th><th>PPS</th><th>result</th></tr>`;
    for (const s of recent) {
      const tr = document.createElement('tr');
      const pps = sessionPps(s);
      tr.innerHTML = `<td>${fmtDate(s.at)}</td><td>${modeDot(s.mode)}${SHORT_LABEL[s.mode]}</td><td>${s.pieces}</td>` +
        `<td>${pps ? pps.toFixed(2) : '—'}</td><td><b>${sessionResult(s)}</b></td>`;
      t.appendChild(tr);
    }
    log.appendChild(t);
  }
  page.appendChild(log);

  // ---- restart the graph ----
  const danger = document.createElement('div');
  danger.className = 'stats-reset';
  const reset = document.createElement('button');
  reset.className = 'btn danger';
  reset.textContent = 'Restart stats…';
  reset.addEventListener('click', () => confirmRestart(() => {
    resetStats();
    page.replaceWith(statsView());
  }));
  const note = document.createElement('span');
  note.textContent = 'wipes the graph and lifetime numbers — cannot be undone';
  danger.append(reset, note);
  page.appendChild(danger);

  return page;
}

/** The mode-appropriate personal best across recorded sessions. */
function modeRecord(m: Mode, sessions: SessionRecord[]): string {
  switch (m) {
    case 'fourwide': {
      const best = Math.max(0, ...sessions.map((s) => s.maxCombo ?? 0));
      return best > 0 ? `combo ×${best}` : '—';
    }
    case 'allspin': {
      const best = Math.max(0, ...sessions.map((s) => s.maxB2b ?? 0));
      return best > 0 ? `B2B ×${best}` : '—';
    }
    case 'free': {
      const times = sessions.map((s) => s.sprintMs).filter((v): v is number => v !== undefined);
      return times.length > 0 ? fmtSprint(Math.min(...times)) : '—';
    }
    case 'quick': {
      const best = Math.max(0, ...sessions.map((s) => s.altitude ?? 0));
      return best > 0 ? `${Math.round(best)}m` : '—';
    }
    case 'versus': {
      const w = sessions.reduce((n, s) => n + (s.wins ?? 0), 0);
      const l = sessions.reduce((n, s) => n + (s.losses ?? 0), 0);
      return w + l > 0 ? `${w}–${l} rounds` : '—';
    }
    case 'lst': {
      const accs = sessions.filter((s) => gradeTotal(s.grades) > 0).map((s) => gradeAccuracy(s.grades));
      return accs.length > 0 ? `${(Math.max(...accs) * 100).toFixed(0)}% acc` : '—';
    }
  }
}

/** One-cell summary of a session for the recent log. */
function sessionResult(s: SessionRecord): string {
  const acc = gradeTotal(s.grades) > 0 ? `${(gradeAccuracy(s.grades) * 100).toFixed(0)}%` : '';
  switch (s.mode) {
    case 'quick': return `${Math.round(s.altitude ?? 0)}m`;
    case 'versus': return `${(s.wins ?? 0) > (s.losses ?? 0) ? 'won' : 'lost'} ${s.wins ?? 0}–${s.losses ?? 0}`;
    case 'fourwide': return s.maxCombo !== undefined ? `combo ×${s.maxCombo}${acc ? ` · ${acc}` : ''}` : acc || '—';
    case 'free': return s.sprintMs !== undefined ? `${fmtSprint(s.sprintMs)}${acc ? ` · ${acc}` : ''}` : 'unfinished';
    case 'allspin': return s.maxB2b !== undefined ? `B2B ×${s.maxB2b}${acc ? ` · ${acc}` : ''}` : acc || '—';
    case 'lst': return acc ? `${acc} accuracy` : '—';
  }
}

/** In-app confirm dialog for the restart action; Esc / backdrop / Cancel decline. */
function confirmRestart(onConfirm: () => void): void {
  const overlay = document.createElement('div');
  overlay.className = 'paths-overlay';
  const modal = document.createElement('div');
  modal.className = 'paths-modal confirm-modal';
  modal.setAttribute('role', 'alertdialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'confirm-restart-title');
  modal.innerHTML = `<h2 id="confirm-restart-title">Restart the graph?</h2>
    <p class="sub">Every recorded session and all lifetime numbers — for every mode — are wiped for good. There is no undo.</p>`;

  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  const actions = document.createElement('div');
  actions.className = 'confirm-actions';
  const cancel = document.createElement('button');
  cancel.className = 'btn';
  cancel.textContent = 'Keep my stats';
  cancel.addEventListener('click', close);
  const wipe = document.createElement('button');
  wipe.className = 'btn danger solid';
  wipe.textContent = 'Restart stats';
  wipe.addEventListener('click', () => {
    close();
    onConfirm();
  });
  actions.append(cancel, wipe);
  modal.appendChild(actions);

  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  cancel.focus(); // safe default — Enter declines
}

// ---- chart plumbing ----

const VB_W = 720;
const VB_H = 220;
const PAD = { l: 44, r: 14, t: 12, b: 20 };

interface ChartSeries {
  color: string;
  points: ChartPoint[];
}

function lineChart(series: ChartSeries, opts: { slots: number; yTicks: number[]; yFmt: (v: number) => string }): HTMLElement {
  // wrap contains only the svg + tooltip, so tooltip math needs no offsets
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';

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
  const pts = series.points.map((p) => ({ x: px(p.x), y: py(p.y) }));
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  let marks = '';
  if (pts.length > 1) {
    // faint fill under the line grounds the trend without adding a second hue
    const base = PAD.t + plotH;
    marks += `<path d="${line} L${pts[pts.length - 1].x.toFixed(1)} ${base} L${pts[0].x.toFixed(1)} ${base} Z" fill="${series.color}" fill-opacity="0.08" stroke="none"/>`;
  }
  marks += `<path d="${line}" fill="none" stroke="${series.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  for (const p of pts) {
    marks += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="${series.color}" stroke="var(--bg-raised)" stroke-width="2"/>`;
  }
  svg.innerHTML = grid + yLabels + marks;
  wrap.appendChild(svg);

  // hover: vertical crosshair + ring + tooltip on the nearest point by x
  const tip = document.createElement('div');
  tip.className = 'chart-tooltip';
  wrap.appendChild(tip);
  const xhair = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  xhair.classList.add('xhair');
  xhair.setAttribute('y1', String(PAD.t));
  xhair.setAttribute('y2', String(PAD.t + plotH));
  xhair.style.display = 'none';
  svg.appendChild(xhair);
  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  ring.setAttribute('r', '6.5');
  ring.setAttribute('fill', 'none');
  ring.setAttribute('stroke-width', '2');
  ring.style.display = 'none';
  svg.appendChild(ring);

  const all = series.points;
  const hide = () => {
    ring.style.display = 'none';
    xhair.style.display = 'none';
    tip.classList.remove('show');
  };
  svg.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const mx = ((e.clientX - r.left) / r.width) * VB_W;
    let nearest = all[0];
    let bd = Infinity;
    for (const p of all) {
      const d = Math.abs(px(p.x) - mx);
      if (d < bd) { bd = d; nearest = p; }
    }
    if (!nearest || bd > 50) {
      hide();
      return;
    }
    const cx = px(nearest.x);
    xhair.style.display = '';
    xhair.setAttribute('x1', String(cx));
    xhair.setAttribute('x2', String(cx));
    ring.style.display = '';
    ring.setAttribute('cx', String(cx));
    ring.setAttribute('cy', String(py(nearest.y)));
    ring.setAttribute('stroke', series.color);
    tip.textContent = nearest.label;
    tip.classList.add('show');
    const tx = (cx / VB_W) * r.width;
    tip.style.left = `${Math.min(Math.max(tx, 70), r.width - 70)}px`;
    tip.style.top = `${(py(nearest.y) / VB_H) * r.height - 34}px`;
  });
  svg.addEventListener('mouseleave', hide);

  return wrap;
}

function modeDot(m: Mode): string {
  return `<i class="mode-dot" style="background:${SERIES_VAR[m]}"></i>`;
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
