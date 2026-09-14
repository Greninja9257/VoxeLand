// Tiny worker pool with request ids and least-busy dispatch.
export class WorkerPool {
  private workers: { w: Worker; busy: number }[] = [];
  private callbacks = new Map<number, (msg: any) => void>();
  private nextId = 1;
  private readyCount = 0;
  private readyResolvers: (() => void)[] = [];

  constructor(factory: () => Worker, public size: number, initMessage: any) {
    for (let i = 0; i < size; i++) {
      const w = factory();
      const entry = { w, busy: 0 };
      w.onmessage = (e: MessageEvent) => {
        const m = e.data;
        if (m.type === 'ready') { this.readyCount++; if (this.readyCount === size) { for (const r of this.readyResolvers) r(); this.readyResolvers = []; } return; }
        entry.busy--;
        const cb = this.callbacks.get(m.id);
        if (cb) { this.callbacks.delete(m.id); cb(m); }
      };
      w.onerror = (e) => console.error('worker error', e.message, e);
      w.postMessage(initMessage);
      this.workers.push(entry);
    }
  }

  ready(): Promise<void> {
    if (this.readyCount === this.size || this.size === 0) return Promise.resolve();
    return new Promise((r) => this.readyResolvers.push(r));
  }

  get inFlight(): number { let n = 0; for (const w of this.workers) n += w.busy; return n; }

  request(msg: any, transfer?: Transferable[]): Promise<any> {
    const id = this.nextId++;
    let best = this.workers[0];
    for (const w of this.workers) if (w.busy < best.busy) best = w;
    best.busy++;
    return new Promise((resolve) => {
      this.callbacks.set(id, resolve);
      best.w.postMessage({ ...msg, id }, transfer ?? []);
    });
  }

  /** Send a message to every worker (no reply expected). */
  broadcast(msg: any): void { for (const w of this.workers) w.w.postMessage(msg); }

  terminate(): void { for (const w of this.workers) w.w.terminate(); this.workers = []; }
}
