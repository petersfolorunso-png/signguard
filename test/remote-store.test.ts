/** Remote state store: load, coalesced writes, retries, and JsonFile mirroring. */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteStore, useRemoteStore } from "../src/server/remote-store";
import { JsonFile } from "../src/server/jsonfile";

function fakeWorker(opts: { failFirst?: number } = {}) {
  const docs: Record<string, string> = {};
  const puts: string[] = [];
  let fails = opts.failFirst ?? 0;
  const f = (async (url: string, init?: RequestInit) => {
    if ((init?.headers as Record<string, string>)?.authorization !== "Bearer t") return new Response("{}", { status: 401 });
    const u = new URL(url);
    if (!init?.method || init.method === "GET") return Response.json({ docs });
    if (fails-- > 0) return new Response("{}", { status: 503 });
    const k = decodeURIComponent(u.pathname.split("/").pop()!);
    docs[k] = String(init.body);
    puts.push(k);
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  return { docs, puts, f };
}

afterEach(() => useRemoteStore(null, {}));

describe("RemoteStore", () => {
  it("loads docs and stores writes, retrying 5xx", async () => {
    const w = fakeWorker({ failFirst: 2 });
    const s = new RemoteStore("https://x/", "t", w.f);
    await s.put("a.json", '{"n":1}');
    expect(w.docs["a.json"]).toBe('{"n":1}');
    expect(await s.load()).toEqual({ "a.json": '{"n":1}' });
  });

  it("coalesces bursts to the latest value", async () => {
    const w = fakeWorker();
    const s = new RemoteStore("https://x", "t", w.f);
    await Promise.all([1, 2, 3, 4, 5].map((n) => s.put("k.json", `{"n":${n}}`)));
    expect(w.docs["k.json"]).toBe('{"n":5}');
    expect(w.puts.length).toBeLessThanOrEqual(3);
  });

  it("rejects on a bad token instead of retrying forever", async () => {
    const w = fakeWorker();
    await expect(new RemoteStore("https://x", "nope", w.f).load()).rejects.toThrow(/401/);
  });

  it("JsonFile prefers the remote copy and mirrors writes (restart keeps state)", async () => {
    const w = fakeWorker();
    w.docs["identities.json"] = JSON.stringify({ users: { h: { did: "did:t3n:abc" } } });
    const store = new RemoteStore("https://x", "t", w.f);
    useRemoteStore(store, await store.load());
    const dir = mkdtempSync(join(tmpdir(), "sgrs-")); // fresh, empty disk (like a Render restart)
    const f = new JsonFile<{ users: Record<string, { did: string; sponsored?: number }> }>(join(dir, "identities.json"), { users: {} });
    expect(f.data.users.h.did).toBe("did:t3n:abc");
    f.data.users.h.sponsored = 100;
    await f.persist();
    expect(JSON.parse(w.docs["identities.json"]).users.h.sponsored).toBe(100);
    // "restart" on another empty disk: state survives
    useRemoteStore(store, await store.load());
    const g = new JsonFile<{ users: Record<string, { sponsored?: number }> }>(join(mkdtempSync(join(tmpdir(), "sgrs-")), "identities.json"), { users: {} });
    expect(g.data.users.h.sponsored).toBe(100);
  });
});
