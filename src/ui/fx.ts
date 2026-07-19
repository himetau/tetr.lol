// Action-text juice layer: tetr.io-style popups over the field panel
// ("QUAD", "T-SPIN DOUBLE", "B2B ×7", "ALL CLEAR", floor-ups). The canvas
// effects (particles, shake, flashes) live in FieldRenderer; this file is
// the DOM half plus the naming logic for what a lock event should shout.

import type { LockEvent } from "../core/game";

export type ActionKind = "plain" | "spin" | "quad" | "allclear" | "surge" | "floor" | "combo";

/** Chain bubble in a reserved slot above the Next queue: the chain label
 * ("B2B" / "COMBO") sits above a drifting bubble that heats gold → deep red
 * as the count grows, pops on every extension and glows while `charged`.
 * Shows B2B in quick play / free / all-spin / 1v1 and the combo chain in
 * 4-wide. Insert `el` into the right side column before the queue panel. */
export class ChainBubble {
  readonly el: HTMLElement;
  private labelEl: HTMLElement;
  private bubbleEl: HTMLElement;
  private last = 0;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "chain-slot";
    // label + bubble share one floating wrapper so they drift in lockstep
    // (the bubble's pop animation can restart without desyncing the label)
    const float = document.createElement("div");
    float.className = "chain-float";
    this.labelEl = document.createElement("div");
    this.labelEl.className = "chain-label";
    this.bubbleEl = document.createElement("div");
    this.bubbleEl.className = "b2b-bubble";
    float.append(this.labelEl, this.bubbleEl);
    this.el.append(float);
  }

  /** Show `label ×count`. Dropping to 0 from a live chain shatters the bubble
   * (a chain that big shouldn't just fade); use reset() to hide instantly. */
  set(label: string, count: number, charged = false): void {
    if (count >= 1) {
      this.bubbleEl.classList.remove("breaking");
      this.labelEl.textContent = label;
      this.bubbleEl.textContent = `×${count}`;
      const hue = Math.max(5, 50 - (count - 1) * 6);
      this.el.style.setProperty("--b2b-col", `hsl(${hue}, 90%, 55%)`);
      this.el.classList.add("show");
      this.bubbleEl.classList.toggle("charged", charged);
      if (count > this.last) {
        this.bubbleEl.classList.remove("pop");
        void this.bubbleEl.offsetWidth; // restart the pop animation
        this.bubbleEl.classList.add("pop");
      }
    } else if (this.last >= 1) {
      this.shatter(); // going 0 from a live chain: burst (then hides itself)
    }
    // else already hidden or mid-shatter - leave the burst to finish
    this.last = count;
  }

  /** Burst the bubble apart, then hide - the visual for a snapped chain. */
  private shatter(): void {
    const b = this.bubbleEl;
    b.classList.remove("pop", "charged");
    // keep the slot shown so the burst is visible; hide once it finishes
    b.classList.remove("breaking");
    void b.offsetWidth;
    b.classList.add("breaking");
    const done = (e: AnimationEvent) => {
      if (e.target !== b) {
        return;
      }
      b.removeEventListener("animationend", done);
      this.hide();
    };
    b.addEventListener("animationend", done);
  }

  private hide(): void {
    this.el.classList.remove("show");
    this.bubbleEl.classList.remove("charged", "pop", "breaking");
  }

  reset(): void {
    this.hide();
    this.last = 0;
  }
}

/** The popup layer over `host`, created on first use. */
function actionLayer(host: HTMLElement): HTMLElement {
  let layer = host.querySelector<HTMLElement>(":scope > .action-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "action-layer";
    host.appendChild(layer);
  }
  return layer;
}

/** Remove `el` once its animation finishes. */
function removeOnAnimationEnd(el: HTMLElement): void {
  el.addEventListener("animationend", (e) => {
    if (e.target === el) {
      el.remove();
    }
  });
}

/** Pop a floating action label over the field. Stacks briefly, cleans itself
 * up. `place: 'low'` anchors it in the bottom third instead of the usual
 * spot, so a popup firing on the same lock as a clear label (SURGE lands
 * together with SINGLE/QUAD/…) doesn't stamp over it. */
export function actionText(
  host: HTMLElement,
  main: string,
  sub = "",
  kind: ActionKind = "plain",
  place: "mid" | "low" = "mid",
): void {
  const layer = actionLayer(host);
  const el = document.createElement("div");
  el.className = `action-text at-${kind}${place === "low" ? " at-low" : ""}`;
  const m = document.createElement("div");
  m.className = "at-main";
  m.textContent = main;
  el.appendChild(m);
  if (sub) {
    const s = document.createElement("div");
    s.className = "at-sub";
    s.textContent = sub;
    el.appendChild(s);
  }
  // slight random tilt/offset so rapid-fire popups don't stamp on each other
  el.style.setProperty("--at-x", `${(Math.random() * 2 - 1) * 14}px`);
  el.style.setProperty("--at-r", `${(Math.random() * 2 - 1) * 3}deg`);
  removeOnAnimationEnd(el);
  while (layer.children.length >= 3) {
    layer.firstChild!.remove();
  }
  layer.appendChild(el);
}

/**
 * A big "+N" attack number that punches in over the field and rattles harder
 * the more lines you sent - the bigger the spike, the larger and shakier it is.
 * `intensity` is 0..1 (how far above the big-send threshold the attack was).
 */
export function sentNumber(host: HTMLElement, lines: number, intensity: number): void {
  const layer = actionLayer(host);
  const t = Math.max(0, Math.min(1, intensity));
  const el = document.createElement("div");
  el.className = "sent-pop";
  el.textContent = `+${lines}`;
  el.style.setProperty("--sp-scale", `${1 + t * 1.2}`); // grows with the spike
  el.style.setProperty("--sp-shake", `${2 + t * 12}px`); // rattles harder
  el.style.setProperty("--sp-dur", `${0.5 + t * 0.5}s`); // lingers a touch longer
  removeOnAnimationEnd(el);
  layer.appendChild(el);
}

const LINES_NAME = ["", "SINGLE", "DOUBLE", "TRIPLE", "QUAD"];

export interface ActionLabel {
  main: string;
  kind: ActionKind;
}

/** What a lock event should shout, tetr.io-style. Null = nothing noteworthy. */
export function lockActionLabel(ev: LockEvent): ActionLabel | null {
  const n = ev.linesCleared;
  const allClear = n > 0 && ev.boardAfter.isEmpty();
  if (allClear) {
    return { main: "ALL CLEAR", kind: "allclear" };
  }
  if (ev.spin !== "none") {
    const mini = ev.spin === "mini" ? "MINI " : "";
    const what = n > 0 ? ` ${LINES_NAME[Math.min(n, 4)]}` : "";
    return { main: `${mini}${ev.piece}-SPIN${what}`, kind: "spin" };
  }
  if (n === 4) {
    return { main: "QUAD", kind: "quad" };
  }
  if (n > 0) {
    return { main: LINES_NAME[n], kind: "plain" };
  }
  return null;
}

/** Cleared row indices (pre-clear, bottom-up) implied by a lock event. */
export function clearedRowsOf(ev: LockEvent): number[] {
  if (ev.linesCleared === 0) {
    return [];
  }
  const b = ev.boardBefore.clone();
  b.place(ev.cells);
  return b.clearLines();
}
