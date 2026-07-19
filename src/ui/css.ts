// Cached CSS custom-property lookup. getComputedStyle can force a style
// recalculation - costly when called from render loops, especially on
// Firefox - so values are cached until the theme changes.

const cache = new Map<string, string>();

export function cssVar(name: string): string {
  let value = cache.get(name);
  if (value === undefined) {
    value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    cache.set(name, value);
  }
  return value;
}

/** Flush cached values - call whenever theme variables change. */
export function invalidateCssVars(): void {
  cache.clear();
}
