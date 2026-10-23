import { useCallback, useEffect, useMemo, useState } from "react";
import { WINDOW_WORDS, affected, describeMove, eventsFor, impactLine, mainWindow, pct } from "./moves.js";

// The day-to-day market moves: how the pound has moved against each currency
// (official ECB rates, /api/market), why (the event engine's recent events,
// /data/events.json), and — with the Accounts password — which accounts on the
// list each material move hits, with a call line.
const PW_KEY = "fx-accounts-password";   // the Accounts page's key: unlocked there = unlocked here
const remembered = () => { try { return sessionStorage.getItem(PW_KEY) || ""; } catch { return ""; } };
const remember = (pw) => { try { pw ? sessionStorage.setItem(PW_KEY, pw) : sessionStorage.removeItem(PW_KEY); } catch { /* private mode */ } };

export default function MovesApp() {
  const [market, setMarket] = useState(null);
  const [events, setEvents] = useState([]);
  const [accounts, setAccounts] = useState(null);
  const [error, setError] = useState("");
  const [password, setPassword] = useState(remembered);
  const [pwError, setPwError] = useState("");

  useEffect(() => {
    fetch("/api/market", { cache: "no-store" })
      .then(async (r) => (r.ok ? setMarket(await r.json()) : setError((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)))
      .catch(() => setError("Couldn't reach the site — check your connection."));
    fetch(`/data/events.json?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((d) => setEvents(Object.values(d || {})))
      .catch(() => setEvents([]));
  }, []);

  const unlock = useCallback(async (pw) => {
    if (!pw) return;
    setPwError("");
    try {
      const r = await fetch("/api/accounts", { headers: { authorization: `Bearer ${pw}` }, cache: "no-store" });
      const body = await r.json().catch(() => ({}));
      if (r.ok) { setAccounts(body.rows || []); remember(pw); }
      else { setPwError(body.error || `HTTP ${r.status}`); if (r.status === 401) { remember(""); setPassword(""); } }
    } catch { setPwError("Couldn't reach the site."); }
  }, []);
  useEffect(() => { if (password) unlock(password); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const material = useMemo(() => (market?.currencies || []).filter((c) => c.material?.length), [market]);

  return (
    <>
      <style>{CSS}</style>
      <div className="tb">
        <div className="tb-l">
          <div className="tb-logo"><div className="tb-mark">FX</div>Discovery Engine</div>
          <div className="tb-sep" />
          <div className="tb-tag">Market moves</div>
        </div>
        <div className="tb-r">
          {market && <span className="tb-time">ECB rates to {market.as_of}</span>}
          <a className="btn-sm" href="/accounts">Accounts</a>
          <a className="btn-sm" href="/">Event leads</a>
        </div>
      </div>

      <main className="wrap">
        {error && <div className="empty">{error}</div>}
        {!market && !error && <div className="empty">Loading…</div>}
        {market && (
          <>
            <h1 className="h1">{material.length ? `${material.length} material move${material.length > 1 ? "s" : ""} against the pound` : "No material moves today"}</h1>
            <p className="sub">
              Material = the pound moved {market.rules["1m"]}%+ in a month or {market.rules["3m"]}%+ in three. Rates: {market.source}.
            </p>

            {accounts === null && (
              <form className="unlock" onSubmit={(e) => { e.preventDefault(); unlock(password); }}>
                <span>See which accounts each move hits:</span>
                <input className="input" type="password" placeholder="Accounts password" value={password}
                       onChange={(e) => setPassword(e.target.value)} aria-label="Accounts password" />
                <button className="btn-sm" type="submit" disabled={!password}>Unlock</button>
                {pwError && <span className="err">{pwError}</span>}
              </form>
            )}

            {material.map((cur) => (
              <Move key={cur.code} cur={cur} events={eventsFor(events, cur.code, market.as_of)} accounts={accounts} />
            ))}

            <h2 className="h2">All currencies</h2>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Currency</th><th>£1 buys</th>{Object.keys(WINDOW_WORDS).map((w) => <th key={w}>{w}</th>)}<th>90 days</th></tr></thead>
                <tbody>
                  {market.currencies.map((c) => (
                    <tr key={c.code} className={c.material?.length ? "hot" : ""}>
                      <td><b>{c.code}</b> <span className="muted">{c.name}</span></td>
                      <td>{c.rate}</td>
                      {Object.keys(WINDOW_WORDS).map((w) => (
                        <td key={w} className={c.changes[w] < 0 ? "down" : c.changes[w] > 0 ? "up" : ""}>
                          {c.changes[w] === undefined ? "—" : pct(c.changes[w])}
                        </td>
                      ))}
                      <td><Spark history={c.history} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="note">Change is in what £1 buys: negative = the pound fell (imports cost more), positive = it rose (export takings worth less).</p>
          </>
        )}
      </main>
    </>
  );
}

function Move({ cur, events, accounts }) {
  const w = mainWindow(cur);
  const hits = accounts ? affected(accounts, cur, w) : [];
  const [copied, setCopied] = useState("");
  const copy = async (text, key) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(""), 1500); } catch { /* no clipboard */ }
  };
  return (
    <section className="move">
      <div className="move-top">
        <div>
          <div className="move-title">{describeMove(cur, w)}</div>
          <div className="move-sub">{impactLine(cur, w)} · £1 = {cur.symbol || cur.code + " "}{cur.rate}</div>
        </div>
        <Spark history={cur.history} wide />
      </div>

      <div className="why">
        <div className="label">Why it moved</div>
        {events.length ? events.slice(0, 3).map((e) => (
          <div key={e.id || e.detected_at} className="event">
            <span className="muted">{new Date(e.detected_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>{" "}
            {e.source_url ? <a href={e.source_url} target="_blank" rel="noreferrer">{e.headline}</a> : e.headline}
            {e.what_happened && <div className="muted small">{e.what_happened}</div>}
          </div>
        )) : <div className="muted small">No strong or medium event for this pair in the last week.</div>}
      </div>

      {accounts !== null && (
        <div className="hits">
          <div className="label">Accounts this hits ({hits.length})</div>
          {hits.length ? hits.slice(0, 25).map(({ account: a, effect }) => (
            <div key={a.company_number || a.rank} className={`hit ${effect.hurt ? "hurt" : "helped"}`}>
              <div className="hit-top">
                <b>{a.company_name}</b>
                <span className="chip">{effect.angle}</span>
                {a.finance_contact && <span className="muted">{a.finance_contact}{a.finance_contact_role ? `, ${a.finance_contact_role}` : ""}</span>}
                {a.currency_confidence && <span className="muted small">currency: {a.currency_confidence}{a.currency_confidence === "Low" ? " (niche default — check)" : ""}</span>}
              </div>
              <div className="hit-line">
                <span>{effect.line}</span>
                <button className="btn-sm" onClick={() => copy(effect.line, a.company_number)}>{copied === a.company_number ? "Copied" : "Copy"}</button>
              </div>
              {a.fx_estimate && <div className="muted small">{a.fx_estimate}</div>}
            </div>
          )) : <div className="muted small">No account on the list deals mainly in {cur.code} with a known direction.</div>}
        </div>
      )}
    </section>
  );
}

function Spark({ history = [], wide = false }) {
  if (history.length < 2) return null;
  const values = history.map((h) => h[1]);
  const lo = Math.min(...values), hi = Math.max(...values);
  const W = wide ? 220 : 90, H = wide ? 48 : 22;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * W},${H - ((v - lo) / (hi - lo || 1)) * H}`).join(" ");
  const up = values[values.length - 1] >= values[0];
  return (
    <svg className="spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img"
         aria-label={`£1 in this currency over 90 days: ${values[0]} to ${values[values.length - 1]}`}>
      <polyline points={pts} fill="none" stroke={up ? "#10B981" : "#F87171"} strokeWidth="1.5" />
    </svg>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#07090F;color:#E2E8F0;font-family:'Inter',sans-serif;-webkit-font-smoothing:antialiased;font-size:14px;line-height:1.5}
a{color:#34D399;text-decoration:none}a:hover{text-decoration:underline}
.tb{position:sticky;top:0;z-index:10;background:rgba(7,9,15,.92);backdrop-filter:blur(20px);border-bottom:1px solid rgba(255,255,255,.05);padding:0 40px;height:52px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.tb-l,.tb-r{display:flex;align-items:center;gap:10px}
.tb-logo{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:#F8FAFC;white-space:nowrap}
.tb-mark{width:28px;height:28px;border-radius:7px;background:linear-gradient(135deg,#10B981,#059669);display:grid;place-items:center;font-size:12px;font-weight:800;color:#fff}
.tb-sep{width:1px;height:14px;background:rgba(255,255,255,.1)}
.tb-tag{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.1em;color:#10B981;text-transform:uppercase}
.tb-time{font-family:'JetBrains Mono',monospace;font-size:10px;color:rgba(255,255,255,.3);white-space:nowrap}
.btn-sm{padding:6px 12px;border-radius:7px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.6);font:600 12px 'Inter',sans-serif;cursor:pointer;white-space:nowrap}
.btn-sm:hover{background:rgba(255,255,255,.08);color:#fff;text-decoration:none}
.btn-sm:disabled{opacity:.4;cursor:default}
.input{padding:7px 12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:rgba(255,255,255,.85);font:13px 'Inter',sans-serif;outline:none}
.wrap{max-width:1100px;margin:0 auto;padding:28px 40px 80px}
.h1{font-size:24px;font-weight:800;color:#F8FAFC;letter-spacing:-.02em}
.h2{font-size:15px;font-weight:700;color:#F8FAFC;margin:32px 0 10px}
.sub{color:rgba(255,255,255,.45);font-size:13px;margin:6px 0 18px}
.unlock{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px 14px;border-radius:10px;background:rgba(99,102,241,.07);border:1px solid rgba(99,102,241,.2);margin-bottom:18px;font-size:13px;color:rgba(255,255,255,.7)}
.err{color:#F87171;font-size:12px}
.move{padding:18px;border-radius:12px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.08);margin-bottom:14px}
.move-top{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:center}
.move-title{font-size:17px;font-weight:700;color:#F8FAFC}
.move-sub{font-size:13px;color:rgba(255,255,255,.55);margin-top:2px}
.label{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.35);margin:14px 0 6px}
.event{font-size:13px;margin-bottom:6px}
.muted{color:rgba(255,255,255,.45)}
.small{font-size:12px}
.hit{padding:10px 12px;border-radius:8px;margin-bottom:8px;border-left:3px solid}
.hit.hurt{background:rgba(248,113,113,.05);border-color:rgba(248,113,113,.6)}
.hit.helped{background:rgba(16,185,129,.05);border-color:rgba(16,185,129,.5)}
.hit-top{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.hit-line{display:flex;gap:10px;justify-content:space-between;align-items:flex-start;margin-top:4px;font-size:13px;color:rgba(255,255,255,.8)}
.chip{font-size:11px;padding:2px 8px;border-radius:6px;background:rgba(245,158,11,.1);color:#FBBF24}
.table-wrap{overflow-x:auto}
.table{width:100%;border-collapse:collapse;font-size:13px}
.table th{text-align:left;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:rgba(255,255,255,.35);padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.08)}
.table td{padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.04);white-space:nowrap;font-family:'JetBrains Mono',monospace;font-size:12px}
.table td:first-child{font-family:'Inter',sans-serif}
.table tr.hot td:first-child b{color:#FBBF24}
.down{color:#F87171}.up{color:#34D399}
.note{font-size:12px;color:rgba(255,255,255,.35);margin-top:8px}
.empty{padding:40px;text-align:center;color:rgba(255,255,255,.4)}
@media(max-width:700px){.tb,.wrap{padding-left:16px;padding-right:16px}.tb-tag,.tb-time{display:none}}
`;
