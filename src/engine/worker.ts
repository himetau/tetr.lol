// Analysis worker: keeps the game thread at full frame rate while grading
// runs. One request per locked piece; superseded requests are dropped.

import { gradePlacement, type GradeRequest } from './grade';

export interface WorkerMsg {
  kind: 'grade';
  id: number;
  req: GradeRequest;
  depth: number;
  beamWidth: number;
}

self.onmessage = (e: MessageEvent<WorkerMsg>) => {
  const msg = e.data;
  if (msg.kind === 'grade') {
    const result = gradePlacement(msg.req, { depth: msg.depth, beamWidth: msg.beamWidth });
    (self as unknown as Worker).postMessage({ kind: 'grade', id: msg.id, result });
  }
};
