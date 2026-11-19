import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/** Tiny JSON persistence with atomic writes and debounced saves. */
export class JsonFile<T> {
  data: T;
  private timer: NodeJS.Timeout | null = null;
  constructor(private path: string, initial: T, private mode = 0o600) {
    mkdirSync(dirname(path), { recursive: true });
    this.data = existsSync(path) ? { ...initial, ...JSON.parse(readFileSync(path, "utf8")) } : initial;
  }
  save(immediate = false) {
    if (immediate) return this.flush();
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 200);
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: this.mode });
    renameSync(tmp, this.path);
  }
}
