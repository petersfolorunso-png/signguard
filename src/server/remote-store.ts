/**
 * Durable server state off local disk (Render's free disk is wiped on restart).
 * Talks to the `signguard-store` Worker (store-worker/worker.js) on Cloudflare D1:
 *   GET  /docs        -> { docs: { [key]: jsonString } }
 *   PUT  /docs/:key   <- jsonString
 * One writer (this server). Writes per key are coalesced (latest wins) and retried.
 */
export class RemoteStore {
  private pending = new Map<string, string>();
  private inflight = new Map<string, Promise<void>>();
  constructor(private url: string, private token: string, private fetchFn: typeof fetch = fetch) {
    this.url = url.replace(/\/+$/, "");
  }

  async load(): Promise<Record<string, string>> {
    const r = await this.fetchFn(`${this.url}/docs`, { headers: { authorization: `Bearer ${this.token}` } });
    if (!r.ok) throw new Error(`state store load failed: HTTP ${r.status}`);
    return ((await r.json()) as { docs: Record<string, string> }).docs ?? {};
  }

  /** Queue a write; resolves once this (or a newer) value for the key is stored. */
  put(key: string, json: string): Promise<void> {
    this.pending.set(key, json);
    const running = this.inflight.get(key);
    if (running) return running.then(() => (this.pending.has(key) ? this.put(key, this.pending.get(key)!) : undefined));
    const p = (async () => {
      while (this.pending.has(key)) {
        const body = this.pending.get(key)!;
        this.pending.delete(key);
        await this.send(key, body);
      }
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async send(key: string, body: string) {
    let wait = 500;
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await this.fetchFn(`${this.url}/docs/${encodeURIComponent(key)}`, { method: "PUT", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" }, body });
        if (r.ok) return;
        if (r.status < 500 && r.status !== 429) throw new Error(`state store refused ${key}: HTTP ${r.status}`);
      } catch (e) {
        if (attempt >= 6 || /refused/.test(String((e as Error).message))) {
          console.error(`[signguard] state store write failed for ${key}: ${(e as Error).message}`);
          throw e;
        }
      }
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 8000);
    }
  }

  async drain() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight.values()]);
  }
}

let active: { store: RemoteStore; docs: Record<string, string> } | null = null;
export function useRemoteStore(store: RemoteStore | null, docs: Record<string, string>) {
  active = store ? { store, docs } : null;
}
export function remoteStore() {
  return active;
}
