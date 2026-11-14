// A steady timer for the look-ahead scheduler. Runs in a Worker when it can, because browsers
// throttle main-thread timers in background tabs to ~1 s, which would starve a 200 ms look-ahead.

const WORKER_SRC = `
let id = null;
onmessage = (e) => {
  if (e.data && e.data.cmd === 'start') {
    if (id !== null) clearInterval(id);
    id = setInterval(() => postMessage(0), e.data.ms);
  } else if (e.data && e.data.cmd === 'stop') {
    if (id !== null) clearInterval(id);
    id = null;
  }
};`;

export class Ticker {
  private worker: Worker | null = null;
  private url: string | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly cb: () => void,
    private readonly ms: number,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    try {
      this.url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
      const w = new Worker(this.url);
      w.onmessage = () => {
        if (this.running) this.cb();
      };
      w.onerror = () => this.fallback();
      w.postMessage({ cmd: 'start', ms: this.ms });
      this.worker = w;
    } catch {
      this.fallback();
    }
  }

  private fallback(): void {
    this.dropWorker();
    if (!this.running || this.interval !== null) return;
    this.interval = setInterval(() => this.cb(), this.ms);
  }

  private dropWorker(): void {
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        /* already gone */
      }
      this.worker = null;
    }
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
  }

  stop(): void {
    this.running = false;
    this.dropWorker();
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
