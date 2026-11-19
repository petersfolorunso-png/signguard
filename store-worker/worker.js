// SignGuard state store: a tiny authenticated document store on Cloudflare D1 (free).
// Bindings: DB (D1), TOKEN (secret). Single writer (the SignGuard server).
const enc = new TextEncoder();
async function same(a, b) {
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json({ ok: true });
    const auth = req.headers.get("authorization") ?? "";
    if (!env.TOKEN || !(await same(auth, `Bearer ${env.TOKEN}`))) return json({ error: "unauthorized" }, 401);
    if (req.method === "GET" && url.pathname === "/docs") {
      const { results } = await env.DB.prepare("SELECT k, v FROM docs").all();
      return json({ docs: Object.fromEntries(results.map((r) => [r.k, r.v])) });
    }
    const m = url.pathname.match(/^\/docs\/([A-Za-z0-9._-]{1,64})$/);
    if (m && req.method === "PUT") {
      const v = await req.text();
      if (v.length > 1_900_000) return json({ error: "too large" }, 413);
      try { JSON.parse(v); } catch { return json({ error: "not json" }, 400); }
      await env.DB.prepare("INSERT INTO docs (k, v, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at").bind(m[1], v, Date.now()).run();
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  },
};
