// Incoming-attack bookkeeping shared by the versus garbage queue and the
// Zenith simulator. Attacks telegraph first (entersAtMs), then become active;
// both states stay cancelable until the rows actually rise.

export interface QueuedAttack {
  lines: number;
  entersAtMs: number; // telegraph ends here
  rising?: boolean; // already started entering the board
}

/** All queued lines (cancelable until they actually rise). */
export function totalLines(incoming: QueuedAttack[]): number {
  return incoming.reduce((n, a) => n + a.lines, 0);
}

/** Lines whose telegraph elapsed - they rise on the next non-clearing lock. */
export function activeLines(incoming: QueuedAttack[], nowMs: number): number {
  return incoming.reduce((n, a) => n + (a.entersAtMs <= nowMs ? a.lines : 0), 0);
}

/** Cancel up to `lines` queued garbage (oldest first); returns lines used. */
export function cancelLines(incoming: QueuedAttack[], lines: number): number {
  let canceled = 0;

  while (lines - canceled > 0 && incoming.length > 0) {
    const head = incoming[0];
    const used = Math.min(head.lines, lines - canceled);
    head.lines -= used;
    canceled += used;

    if (head.lines === 0) {
      incoming.shift();
    }
  }

  return canceled;
}
