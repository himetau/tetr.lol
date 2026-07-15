// Analysis worker: keeps the game thread at full frame rate while grading
// runs. One request per locked piece; superseded requests are dropped.

import { gradePlacement, type GradeRequest } from './grade';
import { setNeuralBlend } from './neural';

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
    setNeuralBlend(msg.req.neural === false ? 0 : 1);
    const result = gradePlacement(msg.req, { depth: msg.depth, beamWidth: msg.beamWidth });
    (self as unknown as Worker).postMessage({ kind: 'grade', id: msg.id, result });
  }
};
