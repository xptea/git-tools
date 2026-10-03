import { countTextLines } from './counter.ts';

self.onmessage = (event: MessageEvent<{ id: number; bytes: Uint8Array }>) => {
  self.postMessage({ id: event.data.id, counts: countTextLines(event.data.bytes) });
};
