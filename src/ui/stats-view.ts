// Stats page: accuracy trend over recent sessions (per mode, toggleable via
// checkmark tabs), quick-play altitude per run, 40 lines time per run,
// lifetime totals, and the recent-session log. Charts are inline SVG — smooth
// monotone curves with a crosshair + tooltip; the session tables are the
// accessible fallback for everything the charts show. Only ranked sessions
// are ever recorded (no undo, no bot assist), so the charts need no filtering.

import { stats, accuracy, gradeAccuracy, resetStats, fmtSprint, type Mode } from './stats';

const MODE_LABEL: Record<Mode, string> = {
  lst: 'LST drill (TKI → loop)',
  fourwide: '4-wide drill (combo book)',
  free: '40 Lines',
  quick: 'Quick play',
  allspin: 'All-Spin trainer',
};

const SHORT_LABEL: Record<Mode, string> = { lst: 'LST', fourwide: '4-wide', free: '40 Lines', quick: 'Quick play', allspin: 'All-Spin' };

// one color per mode — validated (CVD + contrast) against --bg-raised in both
// themes, slot order lst → free → fourwide → allspin (+quick in its own chart)
const SERIES_VAR: Record<Mode, string> = {
  lst: 'var(--series-lst)',
  fourwide: 'var(--series-fourwide)',
  free: 'var(--series-free)',
  quick: 'var(--series-quick)',
  allspin: 'var(--series-allspin)',
};

const TREND_MODES: Mode[] = ['lst', 'fourwide', 'free', 'allspin'];
const TREND_WINDOW = 40;
const TABS_KEY = 'lst-trainer-stats-tabs-v1';

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

/** modes the user has unchecked on the trend chart, persisted across visits */
function loadHiddenModes(): Set<Mode> {
  try {
    const raw = JSON.parse(localStorage.getItem(TABS_KEY) ?? '[]') as Mode[];
    return new Set(raw.filter((m) => TREND_MODES.includes(m)));
  } catch {
    return new Set();
  }
}

export function statsView(): HTMLElement {
  const page = document.createElement('div');
  page.className = 'page';
  page.innerHTML = `<h1>Stats</h1><p class="sub">progress over time and lifetime numbers, stored locally — only ranked sessions count (no undo, no bot)</p>`;

  // ---- accuracy trend (per mode, checkmark tabs) ----
  const graded = stats.sessions.filter((s) => s.mode !== 'quick');
  const trend = card('Accuracy trend');
  if (graded.length < 2) {
    trend.appendChild(emptyNote('finish a couple of ranked drills (5+ graded placements, no undo/bot — retry, top out, or leave the drill records it) and the trend appears here'));
  } else {
    const present = TREND_MODES.filter((m) => graded.some((s) => s.mode === m));
    const hidden = loadHiddenModes();
    const area = document.createElement('div');

    const draw = () => {
      area.replaceChildren();
      const visible = graded.filter((s) => !hidden.has(s.mode)).slice(-TREND_WINDOW);
      if (visible.length < 2) {
        area.appendChild(emptyNote('not enough sessions for the checked modes — toggle a tab back on'));
        return;
      }
      const series: ChartSeries[] = present
        .filter((m) => !hidden.has(m))
        .map((m) => ({
          name: SHORT_LABEL[m],
          color: SERIES_VAR[m],
          points: visible
            .map((s, i) => ({ s, i }))
            .filter(({ s }) => s.mode === m)
            .map(({ s, i }) => ({
              x: i,
              y: gradeAccuracy(s.grades) * 100,
              label: `${fmtDate(s.at)} · ${SHORT_LABEL[s.mode]} · ${(gradeAccuracy(s.grades) * 100).toFixed(0)}% · ${s.pieces} pieces · ${s.tsds} TSD`,
            })),
        }))
        .filter((s) => s.points.length > 0);
      area.appendChild(lineChart(series, {
        slots: visible.length,
        yTicks: [0, 25, 50, 75, 100],
        yFmt: (v) => `${v}%`,
      }));
    };

    // checkmark tab per mode — toggles the series, selection persists
    const tabs = document.createElement('div');
    tabs.className = 'chart-tabs';
    for (const m of present) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'chart-tab' + (hidden.has(m) ? '' : ' active');
      tab.style.setProperty('--tab-c', SERIES_VAR[m]);
      tab.setAttribute('role', 'checkbox');
      tab.setAttribute('aria-checked', String(!hidden.has(m)));
      tab.innerHTML = `<i class="dot"></i>${SHORT_LABEL[m]}<span class="ck">✓</span>`;
      tab.addEventListener('click', () => {
        if (hidden.has(m)) hidden.delete(m);
        else hidden.add(m);
        tab.classList.toggle('active', !hidden.has(m));
        tab.setAttribute('aria-checked', String(!hidden.has(m)));
        localStorage.setItem(TABS_KEY, JSON.stringify([...hidden]));
        draw();
      });
      tabs.appendChild(tab);
    }
    trend.append(tabs, area);
    draw();
  }
  page.appendChild(trend);

  // ---- quick play altitude ----
  const runs = stats.sessions.filter((s) => s.mode === 'quick' && s.altitude !== undefined).slice(-TREND_WINDOW);
  if (runs.length >= 2) {
    const alt = card('Quick play — altitude per run');
    const top = Math.max(...runs.map((r) => r.altitude!));
    const yMax = Math.max(100, Math.ceil(top / 100) * 100);
    alt.appendChild(lineChart([{
      name: SHORT_LABEL.quick,
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

  // ---- 40 lines sprint times ----
  const sprints = stats.sessions.filter((s) => s.mode === 'free' && s.sprintMs !== undefined).slice(-TREND_WINDOW);
  if (sprints.length >= 2) {
    const spr = card('40 Lines — time per run');
    const slowest = Math.max(...sprints.map((r) => r.sprintMs!)) / 1000;
    const yMax = Math.max(60, Math.ceil(slowest / 30) * 30);
    spr.appendChild(lineChart([{
      name: SHORT_LABEL.free,
      color: SERIES_VAR.free,
      points: sprints.map((s, i) => ({
        x: i,
        y: s.sprintMs! / 1000,
        label: `${fmtDate(s.at)} · ${fmtSprint(s.sprintMs!)} · ${s.pieces} pieces`,
      })),
    }], {
      slots: sprints.length,
      yTicks: [0, yMax / 4, yMax / 2, (3 * yMax) / 4, yMax],
      yFmt: (v) => fmtSprint(v * 1000, false),
    }));
    page.appendChild(spr);
  }

  // ---- lifetime table ----
  const life = card('Lifetime');
  const played = (['lst', 'fourwide', 'free', 'quick', 'allspin'] as Mode[]).filter((m) => stats.modes[m].pieces > 0 || stats.modes[m].drills > 0);
  if (played.length === 0) {
    life.appendChild(emptyNote('no ranked sessions yet'));
  } else {
    const table = document.createElement('table');
    table.className = 'stats';
    table.innerHTML = `<tr><th>mode</th><th>drills</th><th>pieces</th><th>TSD</th><th>best</th><th>good</th><th>inacc</th><th>mistake</th><th>killer</th><th>accuracy</th></tr>`;
    for (const m of played) {
      const s = stats.modes[m];
      const g = s.grades;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${modeDot(m)}${MODE_LABEL[m]}</td><td>${s.drills}</td><td>${s.pieces}</td><td>${s.tsds}</td>` +
        `<td>${g.best}</td><td>${g.good}</td><td>${g.inaccuracy}</td><td>${g.mistake}</td><td>${g.killer}</td>` +
        `<td><b>${(accuracy(s) * 100).toFixed(1)}%</b></td>`;
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
    t.innerHTML = `<tr><th>when</th><th>mode</th><th>pieces</th><th>TSD</th><th>result</th></tr>`;
    for (const s of recent) {
      const tr = document.createElement('tr');
      const result = s.mode === 'quick'
        ? `${Math.round(s.altitude ?? 0)}m`
        : s.mode === 'fourwide' && s.maxCombo !== undefined
          ? `${(gradeAccuracy(s.grades) * 100).toFixed(0)}% · combo ×${s.maxCombo}`
          : s.mode === 'free' && s.sprintMs !== undefined
            ? `${fmtSprint(s.sprintMs)} · ${(gradeAccuracy(s.grades) * 100).toFixed(0)}%`
            : `${(gradeAccuracy(s.grades) * 100).toFixed(0)}% accuracy`;
      tr.innerHTML = `<td>${fmtDate(s.at)}</td><td>${modeDot(s.mode)}${SHORT_LABEL[s.mode]}</td><td>${s.pieces}</td><td>${s.tsds}</td><td><b>${result}</b></td>`;
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

function lineChart(series: ChartSeries[], opts: { slots: number; yTicks: number[]; yFmt: (v: number) => string }): HTMLElement {
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
  let marks = '';
  for (const s of series) {
    const pts = s.points.map((p) => ({ x: px(p.x), y: py(p.y) }));
    marks += `<path d="${smoothPath(pts)}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    for (const p of pts) {
      marks += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="${s.color}" stroke="var(--bg-raised)" stroke-width="2"/>`;
    }
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

  const all = series.flatMap((s) => s.points.map((p) => ({ ...p, color: s.color })));
  const hide = () => {
    ring.style.display = 'none';
    xhair.style.display = 'none';
    tip.classList.remove('show');
  };
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
    ring.setAttribute('stroke', nearest.color);
    tip.textContent = nearest.label;
    tip.classList.add('show');
    const tx = (cx / VB_W) * r.width;
    tip.style.left = `${Math.min(Math.max(tx, 70), r.width - 70)}px`;
    tip.style.top = `${(py(nearest.y) / VB_H) * r.height - 34}px`;
  });
  svg.addEventListener('mouseleave', hide);

  return wrap;
}

/**
 * Smooth "round" line through the points: monotone cubic interpolation
 * (Fritsch–Carlson tangents), which never overshoots the data the way a
 * naive Catmull-Rom spline would on an accuracy chart.
 */
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  const n = pts.length;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const h = Math.max(pts[i + 1].x - pts[i].x, 1e-6);
    dx.push(h);
    slope.push((pts[i + 1].y - pts[i].y) / h);
  }
  const tan: number[] = [slope[0]];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) {
      tan.push(0);
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      tan.push((w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]));
    }
  }
  tan.push(slope[n - 2]);
  let d = `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i];
    d += ` C${(pts[i].x + h / 3).toFixed(1)} ${(pts[i].y + (tan[i] * h) / 3).toFixed(1)}` +
      ` ${(pts[i + 1].x - h / 3).toFixed(1)} ${(pts[i + 1].y - (tan[i + 1] * h) / 3).toFixed(1)}` +
      ` ${pts[i + 1].x.toFixed(1)} ${pts[i + 1].y.toFixed(1)}`;
  }
  return d;
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
