import { settings, saveSettings, applyTheme, DEFAULT_SETTINGS, type VolumeSettings, type BotLevel, type OpponentKind, type GradedMode } from './settings';
import type { Pressure } from '../core/versus';
import { keyDescriptor, type Keybinds } from '../core/handling';
import { sfx } from './sound';
import { addCustomImages, clearCustomImages, customImageCount, nextBackground } from './background';

const BIND_LABELS: Record<keyof Keybinds, string> = {
  left: 'Move left',
  right: 'Move right',
  softDrop: 'Soft drop',
  hardDrop: 'Hard drop',
  rotateCW: 'Rotate CW',
  rotateCCW: 'Rotate CCW',
  rotate180: 'Rotate 180',
  hold: 'Hold',
  undo: 'Undo piece',
  retry: 'Retry drill',
  showPaths: 'Show paths',
};

export function settingsView(): HTMLElement {
  const page = document.createElement('div');
  page.className = 'page';
  page.innerHTML = `<h1>Settings</h1><p class="sub">handling, keybinds and trainer behaviour — saved automatically</p>`;

  // ---- handling ----
  const handling = card('Handling');
  handling.appendChild(sliderRow('DAS', 'delayed auto shift (ms)', 0, 300, 1, settings.handling.dasMs, (v) => {
    settings.handling.dasMs = v;
  }));
  handling.appendChild(sliderRow('ARR', 'auto repeat rate (ms) — 0 = instant', 0, 80, 1, settings.handling.arrMs, (v) => {
    settings.handling.arrMs = v;
  }));
  handling.appendChild(sliderRow('SDF', 'soft drop factor — 41 = instant', 5, 41, 1, settings.handling.sdf, (v) => {
    settings.handling.sdf = v;
  }));
  handling.appendChild(sliderRow('DCD', 'DAS cut delay (ms) — pauses DAS after a rotate/hold/drop; 0 = off', 0, 100, 1, settings.handling.dcdMs, (v) => {
    settings.handling.dcdMs = v;
  }));
  handling.appendChild(toggleRow('DAS carry across direction change', 'on = the charge is preserved, so a charged flick bounces wall-to-wall (tetr.io style); off = DAS re-charges', settings.handling.dasCarry, (v) => {
    settings.handling.dasCarry = v;
  }));
  page.appendChild(handling);

  // ---- keybinds ----
  const binds = card('Keybinds');
  for (const key of Object.keys(BIND_LABELS) as (keyof Keybinds)[]) {
    binds.appendChild(bindRow(key));
  }
  page.appendChild(binds);

  // ---- trainer ----
  const trainer = card('Trainer');
  trainer.appendChild(selectRow('Feedback', 'which placements get a grade chip', settings.feedbackLevel, [
    ['all', 'every placement'],
    ['mistakes', 'mistakes only'],
    ['off', 'off'],
  ], (v) => { settings.feedbackLevel = v as typeof settings.feedbackLevel; }));
  trainer.appendChild(toggleRow('Stop on mistake', 'pause and open alternatives when you misplace', settings.stopOnMistake, (v) => {
    settings.stopOnMistake = v;
  }));
  trainer.appendChild(toggleRow('Neural evaluator', 'learned correction on top of the heuristic grading', settings.neuralEval, (v) => {
    settings.neuralEval = v;
  }));
  trainer.appendChild(toggleRow('Auto-retry on top out', 'start a fresh drill automatically', settings.autoRetryTopOut, (v) => {
    settings.autoRetryTopOut = v;
  }));
  const EVAL_LABEL: Record<GradedMode, [string, string]> = {
    lst: ['LST evaluation', 'book + engine grading in the LST drill'],
    fourwide: ['4-wide evaluation', 'combo-book grading in the 4-wide drill'],
    free: ['40 lines evaluation', 'generic placement grading during sprints'],
    allspin: ['All-Spin evaluation', 'Cold Clear grading in the all-spin drill'],
  };
  for (const m of Object.keys(EVAL_LABEL) as GradedMode[]) {
    const [name, hint] = EVAL_LABEL[m];
    trainer.appendChild(toggleRow(name, hint + ' — off hides grades, chips and the paths panel', settings.evalDrill[m], (v) => {
      settings.evalDrill[m] = v;
    }));
  }
  page.appendChild(trainer);

  // ---- versus / garbage pressure ----
  const vs = card('Versus & garbage');
  const v = settings.versus;
  vs.appendChild(selectRow('Bot strength', 'Cold Clear search budget per move', v.botLevel, [
    ['easy', 'easy'],
    ['normal', 'normal'],
    ['hard', 'hard'],
    ['elite', 'elite'],
    ['custom', 'custom (nodes below)'],
  ], (val) => { v.botLevel = val as BotLevel; }));
  vs.appendChild(sliderRow('Custom nodes', 'search nodes per move when strength is "custom"', 500, 100000, 500, v.botNodes, (val) => {
    v.botNodes = val;
  }));
  vs.appendChild(sliderRow('Bot speed', 'pieces per second', 0.5, 4, 0.25, v.botPps, (val) => {
    v.botPps = val;
  }));
  vs.appendChild(sliderRow('My attack', 'scales your outgoing garbage (%)', 25, 300, 25, v.attackScale, (val) => {
    v.attackScale = val;
  }));
  vs.appendChild(sliderRow('Bot attack', 'scales the bot’s outgoing garbage (%) — a handicap dial', 25, 300, 25, v.botAttackScale, (val) => {
    v.botAttackScale = val;
  }));
  vs.appendChild(sliderRow('Garbage delay', 'telegraph time (ms) before an attack can rise', 500, 5000, 250, v.garbageDelayMs, (val) => {
    v.garbageDelayMs = val;
  }));
  vs.appendChild(sliderRow('Messiness', 'chance (%) each garbage row moves the hole column', 0, 100, 5, v.messiness, (val) => {
    v.messiness = val;
  }));
  vs.appendChild(sliderRow('Garbage cap', 'max rows rising on one non-clearing lock', 1, 12, 1, v.garbageCap, (val) => {
    v.garbageCap = val;
  }));
  vs.appendChild(selectRow('First to', 'rounds needed to take a 1v1 match', String(v.firstTo), [
    ['1', '1'], ['2', '2'], ['3', '3'], ['5', '5'], ['7', '7'], ['10', '10'],
  ], (val) => { v.firstTo = Number(val); }));
  vs.appendChild(sliderRow('Spin attack', 'full-spin damage: lines × this', 0, 4, 0.5, v.rules.spinMult, (val) => {
    v.rules.spinMult = val;
  }));
  vs.appendChild(sliderRow('Quad attack', 'lines a quad sends', 0, 8, 1, v.rules.quadAttack, (val) => {
    v.rules.quadAttack = val;
  }));
  vs.appendChild(sliderRow('B2B bonus', 'extra lines while the back-to-back chain is alive', 0, 4, 1, v.rules.b2bBonus, (val) => {
    v.rules.b2bBonus = val;
  }));
  vs.appendChild(sliderRow('Combo interval', 'attack += floor(combo ÷ this); 0 turns combo damage off', 0, 4, 1, v.rules.comboDiv, (val) => {
    v.rules.comboDiv = val;
  }));
  vs.appendChild(sliderRow('All clear', 'lines a perfect clear adds', 0, 20, 1, v.rules.allClear, (val) => {
    v.rules.allClear = val;
  }));
  vs.appendChild(selectRow('Simulated pressure', 'attack pace when a drill uses "garbage" instead of the bot', v.pressure, [
    ['calm', 'calm'],
    ['normal', 'normal'],
    ['brutal', 'brutal'],
  ], (val) => { v.pressure = val as Pressure; }));
  const oppOptions: [string, string][] = [['off', 'off'], ['garbage', 'garbage only'], ['bot', 'cold clear bot']];
  vs.appendChild(selectRow('4-wide opponent', 'pressure during the 4-wide drill', v.drill.fourwide, oppOptions, (val) => {
    v.drill.fourwide = val as OpponentKind;
  }));
  vs.appendChild(selectRow('40 lines opponent', 'pressure during the sprint — turns it into a dig race', v.drill.free, oppOptions, (val) => {
    v.drill.free = val as OpponentKind;
  }));
  vs.appendChild(selectRow('All-Spin opponent', 'pressure during the all-spin drill', v.drill.allspin, oppOptions, (val) => {
    v.drill.allspin = val as OpponentKind;
  }));
  page.appendChild(vs);

  // ---- sound ----
  const sound = card('Sound');
  sound.appendChild(toggleRow('Sound effects', 'movement, clears, combos and milestones', settings.soundFx, (v) => {
    settings.soundFx = v;
  }));
  sound.appendChild(toggleRow('Mistake sound', 'audio cue on mistakes and blunders', settings.soundOnMistake, (v) => {
    settings.soundOnMistake = v;
  }));
  sound.appendChild(volumeRow('Master volume', 'scales every sound', 'master', () => sfx('clearline', 0.5, 'master')));
  sound.appendChild(volumeRow('Movement', 'move, rotate, drop, hold', 'move', () => sfx('harddrop', 0.5, 'move')));
  sound.appendChild(volumeRow('Clears & combos', 'line clears, spins, B2B and combo jingles', 'clear', () => sfx('clearquad', 0.55, 'clear')));
  sound.appendChild(volumeRow('Alerts & events', 'garbage, danger, countdowns, mistakes, milestones', 'alert', () => sfx('levelup', 0.55, 'alert')));
  page.appendChild(sound);

  // ---- appearance ----
  const appearance = card('Appearance');
  appearance.appendChild(selectRow('Theme', '', settings.theme, [
    ['dark', 'dark'],
    ['light', 'light'],
  ], (v) => { settings.theme = v as 'dark' | 'light'; applyTheme(); }));
  appearance.appendChild(sliderRow('Board zoom', 'field size (%)', 60, 160, 5, settings.boardZoom, (v) => {
    settings.boardZoom = v;
  }));
  appearance.appendChild(toggleRow('Ghost piece', '', settings.ghost, (v) => { settings.ghost = v; }));
  appearance.appendChild(toggleRow('Grid', '', settings.grid, (v) => { settings.grid = v; }));
  appearance.appendChild(toggleRow('Board effects', 'particles, screen shake and action text', settings.effects, (v) => { settings.effects = v; }));
  page.appendChild(appearance);

  // ---- background ----
  const bg = card('Background');
  bg.appendChild(selectRow('Backdrop', 'rotates behind the app, like tetr.io', settings.background.mode, [
    ['scenes', 'built-in scenes'],
    ['custom', 'my images'],
    ['aurora', 'aurora glow only'],
  ], (v) => { settings.background.mode = v as typeof settings.background.mode; }));
  bg.appendChild(sliderRow('Dim', 'overlay strength — lower shows more of the image', 0, 95, 5, settings.background.dim, (v) => {
    settings.background.dim = v;
  }));
  bg.appendChild(sliderRow('Cycle', 'seconds between background changes', 15, 600, 15, settings.background.cycleSec, (v) => {
    settings.background.cycleSec = v;
  }));
  bg.appendChild(bgImagesRow());
  page.appendChild(bg);

  const reset = document.createElement('button');
  reset.className = 'btn';
  reset.textContent = 'Reset all settings';
  reset.addEventListener('click', () => {
    Object.assign(settings, structuredClone(DEFAULT_SETTINGS));
    saveSettings();
    applyTheme();
    page.replaceWith(settingsView());
  });
  page.appendChild(reset);

  return page;
}

// which sections the user collapsed, persisted so it survives navigation
const COLLAPSE_KEY = 'lst-trainer-settings-collapsed-v1';

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/** A collapsible settings section. Rows are appended after the header, so the
 * callers' `card.appendChild(row)` still works — they land inside the
 * disclosure. Open/closed state persists per title. */
function card(title: string): HTMLElement {
  const c = document.createElement('details');
  c.className = 'card';
  c.open = !loadCollapsed().has(title);
  const head = document.createElement('summary');
  head.className = 'card-head';
  const h = document.createElement('h2');
  h.textContent = title;
  const chev = document.createElement('span');
  chev.className = 'chevron';
  chev.setAttribute('aria-hidden', 'true');
  chev.textContent = '›';
  head.append(h, chev);
  c.appendChild(head);
  c.addEventListener('toggle', () => {
    const set = loadCollapsed();
    if (c.open) set.delete(title);
    else set.add(title);
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]));
  });
  return c;
}

function row(name: string, hint: string): HTMLElement {
  const r = document.createElement('div');
  r.className = 'set-row';
  const label = document.createElement('label');
  label.className = 'name';
  label.textContent = name;
  if (hint) {
    const h = document.createElement('span');
    h.className = 'hint';
    h.textContent = hint;
    label.appendChild(h);
  }
  r.appendChild(label);
  return r;
}

function sliderRow(name: string, hint: string, min: number, max: number, step: number, value: number, onChange: (v: number) => void): HTMLElement {
  const r = row(name, hint);
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(value);
  const num = document.createElement('input');
  num.type = 'number';
  num.min = slider.min;
  num.max = slider.max;
  num.value = slider.value;
  const apply = (v: number) => {
    const clamped = Math.max(min, Math.min(max, v));
    slider.value = String(clamped);
    num.value = String(clamped);
    onChange(clamped);
    saveSettings();
  };
  slider.addEventListener('input', () => apply(Number(slider.value)));
  num.addEventListener('change', () => apply(Number(num.value)));
  r.append(slider, num);
  return r;
}

/** A 0–100% mixer slider that previews its channel when released. */
function volumeRow(name: string, hint: string, key: keyof VolumeSettings, preview: () => void): HTMLElement {
  const r = sliderRow(name, hint, 0, 100, 5, settings.volume[key], (v) => {
    settings.volume[key] = v;
  });
  // preview on release ('change'), not while dragging ('input')
  for (const input of r.querySelectorAll('input')) {
    input.addEventListener('change', preview);
  }
  return r;
}

function toggleRow(name: string, hint: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const r = row(name, hint);
  const t = document.createElement('input');
  t.type = 'checkbox';
  t.className = 'toggle';
  t.checked = value;
  t.addEventListener('change', () => {
    onChange(t.checked);
    saveSettings();
  });
  r.appendChild(t);
  return r;
}

function selectRow(name: string, hint: string, value: string, options: [string, string][], onChange: (v: string) => void): HTMLElement {
  const r = row(name, hint);
  const s = document.createElement('select');
  for (const [v, label] of options) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    if (v === value) o.selected = true;
    s.appendChild(o);
  }
  s.addEventListener('change', () => {
    onChange(s.value);
    saveSettings();
  });
  r.appendChild(s);
  return r;
}

/** Custom background images: add files or a whole folder, stored locally. */
function bgImagesRow(): HTMLElement {
  const r = row('My images', 'stored in this browser/app only — adding switches the backdrop to “my images”');
  const label = r.querySelector('label.name') as HTMLElement;
  const countEl = document.createElement('span');
  countEl.className = 'hint';
  label.appendChild(countEl);
  const refresh = () => {
    const n = customImageCount();
    countEl.textContent = n === 0 ? 'no images added yet' : `${n} image${n > 1 ? 's' : ''} in the cycle`;
  };
  refresh();

  const makePicker = (folder: boolean): HTMLInputElement => {
    const input = document.createElement('input');
    input.type = 'file';
    if (folder) {
      // no accept filter here — combined with webkitdirectory the Linux
      // folder dialog applies image/* to directories and grays them all out;
      // addCustomImages drops non-image files anyway
      input.webkitdirectory = true;
      input.multiple = true;
    } else {
      input.accept = 'image/*';
      input.multiple = true;
    }
    input.style.display = 'none';
    input.addEventListener('change', () => {
      void (async () => {
        const added = await addCustomImages(input.files ?? []);
        input.value = '';
        if (added > 0 && settings.background.mode !== 'custom') {
          settings.background.mode = 'custom';
          const sel = r.closest('.card')?.querySelector('select');
          if (sel) sel.value = 'custom';
        }
        if (added > 0) saveSettings();
        refresh();
      })();
    });
    return input;
  };
  const filePick = makePicker(false);
  const folderPick = makePicker(true);

  const mkBtn = (text: string, onClick: () => void) => {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  };
  r.append(
    filePick,
    folderPick,
    mkBtn('Add images…', () => filePick.click()),
    mkBtn('Add folder…', () => folderPick.click()),
    mkBtn('Next ▸', () => nextBackground()),
    mkBtn('Clear', () => {
      void clearCustomImages().then(refresh);
    }),
  );
  return r;
}

function bindRow(action: keyof Keybinds): HTMLElement {
  const r = row(BIND_LABELS[action], '');
  const b = document.createElement('button');
  b.className = 'keybind-btn';
  const show = () => {
    b.textContent = settings.binds[action].join(' / ') || 'unbound';
  };
  show();
  b.addEventListener('click', () => {
    b.textContent = 'press a key…';
    b.classList.add('listening');
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== 'Escape') {
        settings.binds[action] = [keyDescriptor(e)];
        saveSettings();
      }
      b.classList.remove('listening');
      show();
      document.removeEventListener('keydown', onKey, true);
    };
    document.addEventListener('keydown', onKey, true);
  });
  r.appendChild(b);
  return r;
}
