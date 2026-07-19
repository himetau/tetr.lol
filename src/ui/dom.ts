// Small shared DOM builders for the play views.

/** A labeled panel container. */
export function panel(label: string): HTMLElement {
  const p = document.createElement("div");
  p.className = "panel";
  const l = document.createElement("div");
  l.className = "label";
  l.textContent = label;
  p.appendChild(l);
  return p;
}

/** A standard button. */
export function btn(text: string, onClick: () => void): HTMLElement {
  const b = document.createElement("button");
  b.className = "btn";
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}
