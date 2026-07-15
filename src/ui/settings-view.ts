import { settings, saveSettings, applyTheme, DEFAULT_SETTINGS } from './settings';
import { keyDescriptor, type Keybinds } from '../core/handling';

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
  handling.appendChild(toggleRow('Cancel DAS on direction change', 'off = DAS carries, so a charged flick bounces wall-to-wall (tetr.io default)', settings.handling.cancelDasOnDirChange, (v) => {
    settings.handling.cancelDasOnDirChange = v;
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
  trainer.appendChild(toggleRow('Mistake sound', 'short thud on mistakes', settings.soundOnMistake, (v) => {
    settings.soundOnMistake = v;
  }));
  trainer.appendChild(toggleRow('Sound effects', 'piece lock and line-clear sounds', settings.soundFx, (v) => {
    settings.soundFx = v;
  }));
  trainer.appendChild(toggleRow('Neural evaluator', 'learned correction on top of the heuristic grading', settings.neuralEval, (v) => {
    settings.neuralEval = v;
  }));
  trainer.appendChild(toggleRow('Auto-retry on top out', 'start a fresh drill automatically', settings.autoRetryTopOut, (v) => {
    settings.autoRetryTopOut = v;
  }));
  page.appendChild(trainer);

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
  page.appendChild(appearance);

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

function card(title: string): HTMLElement {
  const c = document.createElement('div');
  c.className = 'card';
  const h = document.createElement('h2');
  h.textContent = title;
  c.appendChild(h);
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
