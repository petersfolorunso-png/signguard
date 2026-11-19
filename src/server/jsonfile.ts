import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { remoteStore } from "./remote-store.js";

/**
 * Tiny JSON persistence with atomic writes and debounced saves. When a remote
 * store is configured (SIGNGUARD_STORE_URL), it is the source of truth: the doc
 * is loaded from it at startup and every flush is mirrored to it, keyed by the
 * file name (identities.json, sponsor-budget.json, usage-real.json).
 */
export class JsonFile<T> {
  data: T;
  private timer: NodeJS.Timeout | null = null;
  private key: string;
  private lastRemote: Promise<void> = Promise.resolve();
  constructor(private path: string, initial: T, private mode = 0o600) {
    mkdirSync(dirname(path), { recursive: true });
    this.key = basename(path);
    const remote = remoteStore();
    const raw = remote && this.key in remote.docs ? remote.docs[this.key] : existsSync(path) ? readFileSync(path, "utf8") : null;
    this.data = raw ? { ...initial, ...JSON.parse(raw) } : initial;
    // First boot against an empty remote: seed it with what we have.
    if (remote && !(this.key in remote.docs) && raw) this.lastRemote = remote.store.put(this.key, raw).catch(() => {});
  }
  save(immediate = false) {
    if (immediate) return this.flush();
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 200);
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const json = JSON.stringify(this.data);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, json, { mode: this.mode });
    renameSync(tmp, this.path);
    const remote = remoteStore();
    if (remote) this.lastRemote = remote.store.put(this.key, json).catch(() => {});
  }
  /** Flush and wait until the remote copy is stored (throws if it can't be). */
  async persist() {
    this.flush();
    const remote = remoteStore();
    if (remote) await remote.store.put(this.key, JSON.stringify(this.data));
  }
}
