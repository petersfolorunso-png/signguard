import React, { useEffect, useRef, useState } from "react";
import { SAMPLES } from "../core/samples";
import { CHAINS, shortAddr } from "../core/registry";
import type { Rules, TxFacts } from "../core/types";
import * as api from "./api";
import type { CheckResponse, Session, Stats } from "./api";

type Tab = "check" | "rules" | "stats";

export function App() {
  const [tab, setTab] = useState<Tab>("check");
  const [session, setSession] = useState<Session | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Sign-in sheet; `after` runs once the visitor is signed in (e.g. re-run their check in the enclave).
  const [signIn, setSignIn] = useState<{ reason?: string; after?: (s: Session) => void } | null>(null);
  const [welcome, setWelcome] = useState<Session | null>(null);

  useEffect(() => {
    api.startSession().then(setSession).catch((e) => setErr(e.message));
  }, []);

  const signedIn = !!session?.signedIn;
  const askSignIn = (reason?: string, after?: (s: Session) => void) => setSignIn({ reason, after });
  const onSignedIn = (s: Session) => {
    const after = signIn?.after;
    setSession(s);
    setSignIn(null);
    setWelcome(s);
    setTimeout(() => setWelcome(null), 6000);
    after?.(s);
  };
  const out = () => {
    api.signOut();
    setSession(session ? { signedIn: false, loginMethod: session.loginMethod, mode: session.mode } : null);
  };

  return (
    <div className="shell">
      <div className="glow" aria-hidden />
      <header className="top">
        <div className="brand">
          <Shield />
          <span>SignGuard</span>
        </div>
        <div className="top-right">
          {session && <ModePill mode={session.mode} />}
          {signedIn && session?.did && (
            <span className="did-chip" title={`Your T3N identity: ${session.did}`}>
              <span className="dot" /> {shortDid(session.did)}
              {session.loginMethod === "email" && <button className="chip-x" onClick={out} title="Sign out" aria-label="Sign out">×</button>}
            </span>
          )}
          {session && !signedIn && (
            <button className="signin-btn" onClick={() => askSignIn()}>Sign in</button>
          )}
        </div>
      </header>

      <nav className="tabs" role="tablist">
        {(["check", "rules", "stats"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t === "check" ? "Check a tx" : t === "rules" ? "My rules" : "Live stats"}
          </button>
        ))}
      </nav>

      {err && <div className="alert">{err}</div>}
      {welcome && (
        <div className="ok welcome" role="status">
          🎉 {welcome.created ? "You're in! Your own" : "Welcome back — your"} <b>did:t3n</b> is ready{welcome.sponsored ? ` with ${welcome.sponsored} free T3 credits` : ""}.
          {welcome.notes?.map((n, i) => <div key={i} className="muted small">{n}</div>)}
        </div>
      )}

      <main>
        {tab === "check" && <CheckView session={session} onRules={() => setTab("rules")} askSignIn={askSignIn} />}
        {tab === "rules" && <RulesView session={session} askSignIn={askSignIn} />}
        {tab === "stats" && <StatsView />}
      </main>

      {signIn && session && <SignInSheet mode={session.mode} reason={signIn.reason} onClose={() => setSignIn(null)} onDone={onSignedIn} />}

      <footer className="foot">
        <p>
          SignGuard never asks for your seed phrase or private key and never signs anything. Your rules are sealed in your own{" "}
          <a href="https://docs.terminal3.io" target="_blank" rel="noreferrer">Terminal 3</a> vault — the policy enclave only answers <b>allow / warn / block</b>.
        </p>
        <p className="muted">Not financial advice. A "looks OK" is not a guarantee — when in doubt, don't sign.</p>
      </footer>
    </div>
  );
}

// ------------------------------------------------------------------ Check

type AskSignIn = (reason?: string, after?: (s: Session) => void) => void;

function CheckView({ session, onRules, askSignIn }: { session: Session | null; onRules: () => void; askSignIn: AskSignIn }) {
  const [input, setInput] = useState("");
  const [chainId, setChainId] = useState<string>("");
  const [to, setTo] = useState("");
  const [adv, setAdv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<CheckResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  async function run(text = input, sampleId: string | null = null, s: Session | null = session) {
    if (!s) return;
    setBusy(true);
    setErr(null);
    setActive(sampleId);
    try {
      const r = await api.check(s.signedIn ? s.handle : undefined, text, chainId ? Number(chainId) : undefined, to || undefined);
      setRes(r);
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } catch (e) {
      const ae = e as api.ApiError;
      if (ae.signIn) askSignIn(ae.message, (ns) => run(text, sampleId, ns));
      else setErr(ae.message);
      setRes(null);
    } finally {
      setBusy(false);
    }
  }

  function trySample(id: string) {
    const s = SAMPLES.find((x) => x.id === id)!;
    setInput(s.input);
    run(s.input, id);
  }

  return (
    <>
      <section className="hero">
        <h1>
          Don't sign <span className="grad">blind.</span>
        </h1>
        <p className="lede">Paste any wallet transaction or signature request. SignGuard decodes it and checks it against <b>your private rules</b> — no wallet, no seed phrase, no deposit.</p>
        <button className="cta" disabled={!session || busy} onClick={() => trySample("unlimited-usdc")}>
          <span className="cta-icon">⚡</span> Try a scary tx
        </button>
        <p className="hint">One tap. Watch an airdrop-scam approval get stopped.</p>
      </section>

      <section className="card">
        <div className="samples">
          {SAMPLES.map((s) => (
            <button key={s.id} className={`chip ${s.scary ? "scary" : "safe"} ${active === s.id ? "on" : ""}`} onClick={() => trySample(s.id)} disabled={!session || busy} title={s.blurb}>
              {s.scary ? "☠️" : "👌"} {s.title}
            </button>
          ))}
        </div>

        <label className="lbl" htmlFor="tx">Paste a tx, calldata, signature request, Hyperliquid action, tx hash — or the text your wallet shows</label>
        <textarea id="tx" value={input} spellCheck={false} onChange={(e) => setInput(e.target.value)} placeholder={'0x095ea7b3…   or   { "to": "0x…", "data": "0x…", "chainId": 42161 }   or   0x<tx hash>'} rows={6} />

        <button className="link" onClick={() => setAdv(!adv)}>{adv ? "− Hide" : "+ Add"} chain / contract (for bare calldata)</button>
        {adv && (
          <div className="adv">
            <select value={chainId} onChange={(e) => setChainId(e.target.value)} aria-label="Chain">
              <option value="">Chain: auto</option>
              {Object.entries(CHAINS).map(([id, c]) => <option key={id} value={id}>{c.name}</option>)}
            </select>
            <input value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="Contract (tx.to) 0x…" aria-label="Contract address" />
          </div>
        )}

        <button className="primary" disabled={!session || busy || !input.trim()} onClick={() => run()}>
          {busy ? <span className="spin" /> : "🛡️"} {busy ? "Checking in the enclave…" : "Check it"}
        </button>
        {err && <div className="alert">{err}</div>}
      </section>

      {res && (
        <div ref={resultRef}>
          <VerdictCard res={res} onRules={onRules} onSignIn={() => askSignIn("Run this check in your own private Terminal 3 enclave.", (ns) => run(input, active, ns))} />
        </div>
      )}

      <section className="how">
        <Step n={1} title="Paste" text="Raw calldata, tx JSON, eth_signTypedData, a tx hash, or your wallet's popup text." />
        <Step n={2} title="Decode" text="Approvals, permits, Permit2, setApprovalForAll, transfers, GMX & Hyperliquid leverage, Polymarket orders." />
        <Step n={3} title="Private check" text="Your rules sit in your own Terminal 3 vault. The enclave answers allow / warn / block — never your limits." />
      </section>
    </>
  );
}

function VerdictCard({ res, onRules, onSignIn }: { res: CheckResponse; onRules: () => void; onSignIn: () => void }) {
  const v = res.result.verdict;
  const label = v === "block" ? "BLOCK" : v === "warn" ? "WARNING" : "LOOKS OK";
  const share = `SignGuard just ${v === "block" ? "stopped me from signing" : "checked"} a sketchy tx: "${res.explanation.headline}" 🛡️\n\nPrivate pre-sign rules, sealed in a @terminal3io enclave.`;
  return (
    <section className={`verdict v-${v}`} aria-live="polite">
      <div className="v-head">
        <div className="v-badge">{res.explanation.emoji} {label}</div>
        <div className="v-src">{res.policySource === "t3n-tee" ? "Verdict from T3N enclave" : res.policySource === "preview" ? "Preview · default rules" : "Mock enclave (local)"}</div>
      </div>
      <h2>{res.explanation.headline}</h2>
      {res.needsSignIn && (
        <div className="preview-cta">
          <span>This is a quick local preview. Sign in with just your email to get your own <b>did:t3n</b> and run it against <b>your private rules</b> in a Terminal 3 enclave — free.</span>
          <button className="primary small" onClick={onSignIn}>✉️ Sign in &amp; check privately</button>
        </div>
      )}

      {res.explanation.why.length > 0 && (
        <ul className="why">
          {res.explanation.why.map((w, i) => (
            <li key={i} className={`sev-${res.result.hits[i]?.severity}`}>{w}</li>
          ))}
        </ul>
      )}

      <div className="what">
        <div className="what-h">What this actually does</div>
        {res.explanation.what.map((w, i) => <p key={i}>{w}</p>)}
      </div>

      <details className="facts">
        <summary>Decoded details</summary>
        {res.facts.map((f, i) => <FactsTable key={i} f={f} />)}
      </details>

      <div className="v-foot">
        {res.did && <span title={res.did}>🪪 {shortDid(res.did)}</span>}
        {res.credits !== undefined && <span>⛽ {res.credits} T3 credits</span>}
        <span>📥 {res.source.replace("_", " ")}</span>
      </div>
      <div className="v-actions">
        <button className="ghost" onClick={onRules}>Tune my rules</button>
        <a className="ghost" target="_blank" rel="noreferrer" href={`https://x.com/intent/post?text=${encodeURIComponent(share)}&url=${encodeURIComponent(location.origin)}`}>Share on X</a>
      </div>
    </section>
  );
}

function FactsTable({ f }: { f: TxFacts }) {
  const rows: [string, string | undefined][] = [
    ["Type", f.kind],
    ["Method", f.method],
    ["Chain", f.chainId ? `${CHAINS[f.chainId]?.name ?? "chain"} (${f.chainId})` : undefined],
    ["Contract", f.target ? `${f.targetLabel ? f.targetLabel + " · " : ""}${f.target}` : undefined],
    ["Spender / operator", f.spender ? `${f.spenderLabel ? f.spenderLabel + " · " : ""}${f.spender}` : undefined],
    ["Recipient", f.recipient],
    ["Token", f.tokenSymbol ? `${f.tokenSymbol}${f.token ? " · " + shortAddr(f.token) : ""}` : undefined],
    ["Amount", f.unlimited ? "UNLIMITED" : f.amount !== undefined ? `${f.amount}${f.amountUsd !== undefined ? ` (≈$${f.amountUsd})` : ""}` : f.amountRaw],
    ["Leverage", f.leverage !== undefined ? `${f.leverage}x` : undefined],
    ["Position size", f.sizeUsd !== undefined ? `$${f.sizeUsd.toLocaleString("en-US")}` : undefined],
    ["Expires", f.deadline ? new Date(f.deadline * 1000).toISOString().slice(0, 10) : undefined],
    ["Off-chain signature", f.offchainSignature ? "yes" : undefined],
  ];
  return (
    <table>
      <tbody>
        {rows.filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => (
          <tr key={k}><th>{k}</th><td>{v}</td></tr>
        ))}
        {f.notes?.map((n, i) => <tr key={`n${i}`}><th>Note</th><td>{n}</td></tr>)}
      </tbody>
    </table>
  );
}

// ------------------------------------------------------------------ Rules

function RulesView({ session, askSignIn }: { session: Session | null; askSignIn: AskSignIn }) {
  const [rules, setRules] = useState<Rules | null>(null);
  const [allowText, setAllowText] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const local = api.localRules();
    if (local) { setRules(local); setAllowText(local.allowlist.join("\n")); }
    else api.getDefaults().then((d) => { setRules(d); setAllowText(d.allowlist.join("\n")); });
  }, []);

  if (!rules) return <section className="card"><span className="spin" /></section>;
  const set = <K extends keyof Rules>(k: K, v: Rules[K]) => { setRules({ ...rules, [k]: v }); setSaved(null); };
  const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s));

  async function save(s: Session | null = session) {
    if (!s || !rules) return;
    if (!s.signedIn || !s.handle) return askSignIn("Sign in to seal these rules in your own Terminal 3 vault.", (ns) => save(ns));
    setBusy(true); setErr(null);
    try {
      const r = { ...rules, allowlist: allowText.split(/[\s,]+/).map((a) => a.trim()).filter(Boolean) };
      await api.saveRules(s.handle, r);
      setRules(r);
      setSaved(s.mode === "real" ? "Sealed in your Terminal 3 vault ✓" : "Saved to the mock vault ✓ (real T3N vault once the key is set)");
    } catch (e) {
      const ae = e as api.ApiError;
      if (ae.signIn) askSignIn(ae.message, (ns) => save(ns));
      else setErr(ae.message);
    }
    finally { setBusy(false); }
  }

  return (
    <section className="card rules">
      <h2>Your private rules</h2>
      <p className="muted">Stored in your own T3N vault under your DID. SignGuard's server keeps no copy; the enclave only ever answers allow / warn / block.</p>

      <Toggle label="Block unlimited approvals" sub="approve(MAX), unlimited permits, Permit2 MaxUint160" on={rules.blockUnlimitedApprovals} set={(v) => set("blockUnlimitedApprovals", v)} />
      <Toggle label="Block setApprovalForAll" sub="Handing over every NFT / outcome share in a collection" on={rules.blockApprovalForAll} set={(v) => set("blockApprovalForAll", v)} />

      <div className="row2">
        <NumField label="Max spend per tx (USD)" value={rules.maxSpendUsd} placeholder="off" onChange={(s) => set("maxSpendUsd", numOrNull(s))} />
        <NumField label="Max leverage (x)" value={rules.maxLeverage} placeholder="off" onChange={(s) => set("maxLeverage", numOrNull(s))} />
      </div>
      <div className="row2">
        <Select label="Off-chain permit signatures" value={rules.permitSignatures} onChange={(v) => set("permitSignatures", v as Rules["permitSignatures"])} />
        <NumField label="Max permit lifetime (days)" value={rules.maxPermitDays} placeholder="off" onChange={(s) => set("maxPermitDays", numOrNull(s))} />
      </div>

      <label className="lbl" htmlFor="allow">Trusted contracts (one address per line)</label>
      <textarea id="allow" rows={4} value={allowText} onChange={(e) => { setAllowText(e.target.value); setSaved(null); }} placeholder="0x000000000022D473030F116dDEE9F6B43aC78BA3" spellCheck={false} />
      <Select label="When a contract isn't on the list" value={rules.unlistedContract} onChange={(v) => set("unlistedContract", v as Rules["unlistedContract"])} />

      <button className="primary" onClick={() => save()} disabled={busy || !session}>{busy ? <span className="spin" /> : "🔒"} Seal rules in my vault</button>
      {saved && <div className="ok">{saved}</div>}
      {err && <div className="alert">{err}</div>}
    </section>
  );
}

function Toggle({ label, sub, on, set }: { label: string; sub: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <button className="toggle" role="switch" aria-checked={on} onClick={() => set(!on)}>
      <span className="t-text"><b>{label}</b><small>{sub}</small></span>
      <span className={`sw ${on ? "on" : ""}`}><span /></span>
    </button>
  );
}

function NumField({ label, value, placeholder, onChange }: { label: string; value: number | null; placeholder: string; onChange: (s: string) => void }) {
  return (
    <label className="field"><span>{label}</span><input inputMode="decimal" value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} /></label>
  );
}

function Select({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="field"><span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="ignore">Ignore</option><option value="warn">Warn</option><option value="block">Block</option>
      </select>
    </label>
  );
}

// ------------------------------------------------------------------ Sign in

/** "Enter email, enter code, done." Terminal 3 sends the code; SignGuard never stores your email. */
function SignInSheet({ mode, reason, onClose, onDone }: { mode: "mock" | "real"; reason?: string; onClose: () => void; onDone: (s: Session) => void }) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<api.EmailStart | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [busy, onClose]);

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true); setErr(null);
    try {
      const p = await api.emailStart(email.trim());
      setPending(p); setStep("code"); setCode(""); setCooldown(45);
      setTimeout(() => codeRef.current?.focus(), 50);
    } catch (ex) {
      const ae = ex as api.ApiError;
      setErr(ae.message);
      if (ae.retryAfterSecs) setCooldown(ae.retryAfterSecs);
    } finally { setBusy(false); }
  }

  async function verify(e?: React.FormEvent) {
    e?.preventDefault();
    if (!pending) return;
    setBusy(true); setErr(null);
    try {
      onDone(await api.emailVerify(pending.pendingId, code.trim(), name.trim()));
    } catch (ex) {
      const ae = ex as api.ApiError;
      setErr(ae.message);
      // T3N's login is single-shot in real mode: a refused/expired code needs a fresh one.
      if (ae.status === 410 || (mode === "real" && ae.status === 400)) { setPending(null); setCooldown(0); }
    } finally { setBusy(false); }
  }

  return (
    <div className="sheet-bg" onClick={() => !busy && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="signin-h" onClick={(e) => e.stopPropagation()}>
        <button className="sheet-x" onClick={onClose} disabled={busy} aria-label="Close">×</button>
        <div className="sheet-steps" aria-hidden>
          <span className={step === "email" ? "on" : "done"}>1 · Email</span>
          <span className={step === "code" ? "on" : ""}>2 · Code</span>
          <span>3 · Done</span>
        </div>
        {step === "email" ? (
          <form onSubmit={send}>
            <h2 id="signin-h">Get your private vault</h2>
            <p className="muted">{reason ?? "Your rules live under your own did:t3n identity on Terminal 3."} Just your email — no wallet, no seed phrase, free.</p>
            <input className="big-input" type="email" inputMode="email" autoComplete="email" autoFocus required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" />
            <input className="big-input small-input" autoComplete="name" placeholder="Your name (optional)" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Name (optional)" />
            <button className="primary" disabled={busy || !email.includes("@") || cooldown > 0}>
              {busy ? <span className="spin" /> : "✉️"} {cooldown > 0 ? `Try again in ${cooldown}s` : busy ? "Sending…" : "Email me a code"}
            </button>
            <p className="muted small">{mode === "real" ? "Terminal 3 emails you a one-time code (it expires fast, so have your inbox ready). SignGuard never stores your email." : "Demo mode: no email is sent — the code appears on the next screen."}</p>
          </form>
        ) : (
          <form onSubmit={verify}>
            <h2 id="signin-h">Check your inbox</h2>
            <p className="muted">Enter the code we sent to <b>{email}</b>.</p>
            {pending?.demoCode && <div className="demo-code">Demo code: <b>{pending.demoCode}</b></div>}
            <input ref={codeRef} className="big-input code" inputMode="numeric" autoComplete="one-time-code" placeholder="123456" maxLength={12} value={code} onChange={(e) => setCode(e.target.value.replace(/\s/g, ""))} aria-label="Code" disabled={!pending} />
            {pending ? (
              <button className="primary" disabled={busy || code.length < 4}>{busy ? <span className="spin" /> : "✅"} {busy ? "Creating your did:t3n…" : "Verify & continue"}</button>
            ) : (
              <button type="button" className="primary" onClick={() => send()} disabled={busy || cooldown > 0}>{cooldown > 0 ? `New code in ${cooldown}s` : "Send a new code"}</button>
            )}
            <div className="sheet-links">
              <button type="button" className="link" onClick={() => { setStep("email"); setErr(null); }}>Use a different email</button>
              {pending && <button type="button" className="link" disabled={busy || cooldown > 0} onClick={() => send()}>{cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}</button>}
            </div>
          </form>
        )}
        {err && <div className="alert">{err}</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Stats

function StatsView() {
  const [s, setS] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const load = () => api.getStats().then(setS).catch((e) => setErr(e.message));
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);
  if (err) return <div className="alert">{err}</div>;
  if (!s) return <section className="card"><span className="spin" /></section>;
  const max = Math.max(1, ...s.series.map((d) => d.checks));
  return (
    <>
      <section className="stats-grid">
        <Stat big={s.uniqueDids} label="unique did:t3n users" />
        <Stat big={s.totals.checks} label="checks run" />
        <Stat big={s.totals.block} label="risky txs blocked" accent="red" />
        <Stat big={s.returningDids} label="returning users" />
      </section>
      <section className="card">
        <div className="row-between"><h3>Checks, last 14 days</h3><ModePill mode={s.mode} /></div>
        <div className="bars">
          {s.series.map((d) => (
            <div key={d.date} className="bar" title={`${d.date}: ${d.checks} checks, ${d.users} users`}>
              <div style={{ height: `${(d.checks / max) * 100}%` }} />
              <span>{d.date.slice(8)}</span>
            </div>
          ))}
        </div>
        <div className="split">
          <span className="sv allow">✅ {s.totals.allow} ok</span>
          <span className="sv warn">⚠️ {s.totals.warn} warned</span>
          <span className="sv block">🛑 {s.totals.block} blocked</span>
          <span className="sv">⛽ {s.totals.credits} credits{s.mode === "mock" ? " (sim)" : ""}</span>
        </div>
      </section>
      <section className="card">
        <h3>Live feed</h3>
        {s.recent.length === 0 && <p className="muted">No checks yet — be the first.</p>}
        <ul className="feed">
          {s.recent.map((r, i) => (
            <li key={i}><span className={`pill ${r.verdict}`}>{r.verdict}</span><code>{r.did}</code><span className="muted">{r.kinds.join(", ")}</span><span className="muted t">{ago(r.ts)}</span></li>
          ))}
        </ul>
        <p className="muted small">Every check is a Terminal 3 contract call made for that user's DID, recorded in T3N's tamper-evident activity log.</p>
      </section>
    </>
  );
}

function Stat({ big, label, accent }: { big: number; label: string; accent?: string }) {
  return <div className={`stat ${accent ?? ""}`}><b>{big.toLocaleString("en-US")}</b><span>{label}</span></div>;
}

// ------------------------------------------------------------------ bits

function Step({ n, title, text }: { n: number; title: string; text: string }) {
  return <div className="step"><span className="n">{n}</span><b>{title}</b><p>{text}</p></div>;
}

function ModePill({ mode }: { mode: "mock" | "real" }) {
  return <span className={`mode ${mode}`}>{mode === "real" ? "T3N testnet" : "Mock T3N"}</span>;
}

function Shield() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
      <defs><linearGradient id="g" x1="0" y1="0" x2="24" y2="24"><stop stopColor="#7cf7c4" /><stop offset="1" stopColor="#6aa8ff" /></linearGradient></defs>
      <path d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5l8-3z" fill="url(#g)" />
      <path d="M8.5 12.2l2.4 2.4 4.6-5" stroke="#07080c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const shortDid = (d: string) => (d.length > 24 ? `${d.slice(0, 14)}…${d.slice(-4)}` : d);
function ago(ts: number) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
