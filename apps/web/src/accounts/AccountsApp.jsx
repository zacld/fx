import { useCallback, useEffect, useMemo, useState } from "react";
import { CONFIDENCE, SORTS, bankUrl, factUrl, filterRows, fxLine, fxShare, googleFd, hasConfirmedFd, isOut, money, parts, sortRows, toCsv, wallet } from "./format.js";

// The standing account list from the company finder (lead-sourcer), behind a
// password: the list is fetched from /api/accounts, which checks it.
const API = "/api/accounts";
const PW_KEY = "fx-accounts-password";
const PAGE = 50;

const remembered = () => { try { return sessionStorage.getItem(PW_KEY) || ""; } catch { return ""; } };
const remember = (pw) => { try { pw ? sessionStorage.setItem(PW_KEY, pw) : sessionStorage.removeItem(PW_KEY); } catch { /* private mode */ } };

const ago = (iso) => {
  if (!iso) return "";
  const h = Math.floor((Date.now() - new Date(iso)) / 3600000);
  return h < 1 ? "under an hour ago" : h < 48 ? `${h}h ago` : `${Math.floor(h / 24)} days ago`;
};

const CONF_COLOUR = { Verified: "#10B981", Confirmed: "#38BDF8", Likely: "#F59E0B", Guess: "rgba(255,255,255,.4)" };

export default function AccountsApp() {
  const [password, setPassword] = useState(remembered);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (pw) => {
    if (!pw) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(API, { headers: { authorization: `Bearer ${pw}` }, cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (res.ok) { setData(body); remember(pw); }
      else { setError(body.error || `HTTP ${res.status}`); if (res.status === 401) { remember(""); setPassword(""); } }
    } catch {
      setError("Couldn't reach the site — check your connection.");
    }
    setLoading(false);
  }, []);

  useEffect(() => { if (password) load(password); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const lock = () => { remember(""); setPassword(""); setData(null); };

  return (
    <>
      <style>{CSS}</style>
      <div className="tb">
        <div className="tb-l">
          <div className="tb-logo"><div className="tb-mark">FX</div>Discovery Engine</div>
          <div className="tb-sep" />
          <div className="tb-tag">Accounts</div>
        </div>
        <div className="tb-r">
          {data && <span className="tb-time">list made {ago(data.made_at)}</span>}
          <a className="btn-sm" href="/moves">Market moves</a>
          <a className="btn-sm" href="/">Event leads</a>
          {data && <button className="btn-sm" onClick={lock}>Lock</button>}
        </div>
      </div>
      {data ? <Accounts data={data} /> : (
        <Gate password={password} setPassword={setPassword} onSubmit={() => load(password)} error={error} loading={loading} />
      )}
    </>
  );
}

function Gate({ password, setPassword, onSubmit, error, loading }) {
  return (
    <div className="gate">
      <form className="gate-card" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
        <div className="gate-title">Account list</div>
        <p className="gate-sub">UK companies with proven FX flows and their finance directors, from the daily company finder.</p>
        <label className="gate-label" htmlFor="pw">Password</label>
        <input id="pw" className="input" type="password" autoComplete="current-password" autoFocus
               value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <div className="gate-error" role="alert">{error}</div>}
        <button className="btn-primary" type="submit" disabled={!password || loading}>{loading ? "Opening…" : "Open"}</button>
      </form>
    </div>
  );
}

function Accounts({ data }) {
  const rows = data.rows || [];
  const [filters, setFilters] = useState({ section: "", query: "", confidence: "", fdOnly: false, pair: "", triggersOnly: false,
                                            showOut: false });
  const [sort, setSort] = useState("rank");
  const [shown, setShown] = useState(PAGE);
  const set = (patch) => { setFilters((f) => ({ ...f, ...patch })); setShown(PAGE); };

  const pairs = useMemo(() => [...new Set(rows.flatMap((r) => parts(r.currency_pairs)))].sort(), [rows]);
  const visible = useMemo(() => sortRows(filterRows(rows, filters), sort), [rows, filters, sort]);
  const stats = [
    { n: rows.length, l: "Accounts", s: "Checked in full", c: "#6366F1" },
    { n: rows.filter(hasConfirmedFd).length, l: "FD named", s: "Verified or confirmed", c: "#10B981" },
    { n: rows.filter((r) => r.finance_contact_confidence === "Verified").length, l: "Verified", s: "2+ independent sources", c: "#10B981" },
    { n: rows.filter((r) => r.triggers).length, l: "With triggers", s: "New owner, charges, directors", c: "#F59E0B" },
    { n: rows.filter((r) => r.planning_window_now === "yes").length, l: "Planning now", s: "Year-end planning window", c: "#38BDF8" },
  ];

  const exportCsv = () => {
    const blob = new Blob([toCsv(visible)], { type: "text/csv;charset=utf-8" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `fx-accounts-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <main>
      <div className="stats">
        {stats.map(({ n, l, s, c }) => (
          <div className="stat" key={l}>
            <div className="stat-n" style={{ color: c }}>{n}</div>
            <div><span className="stat-l">{l}</span><span className="stat-s">{s}</span></div>
          </div>
        ))}
      </div>

      <div className="controls">
        <div className="tabs" role="tablist">
          {["", ...(data.sections || [])].map((s) => (
            <button key={s || "all"} role="tab" aria-selected={filters.section === s}
                    className={`tab${filters.section === s ? " on" : ""}`} onClick={() => set({ section: s })}>
              {s || "All"} <span className="tab-n">{s ? rows.filter((r) => r.section === s).length : rows.length}</span>
            </button>
          ))}
        </div>
        <div className="filters">
          <input className="input search" placeholder="Search company, person, niche, bank…" value={filters.query}
                 onChange={(e) => set({ query: e.target.value })} aria-label="Search" />
          <select className="input" value={filters.confidence} onChange={(e) => set({ confidence: e.target.value })} aria-label="Contact confidence">
            <option value="">Any confidence</option>
            {CONFIDENCE.map((c) => <option key={c} value={c}>{c}</option>)}
            <option value="none">No contact</option>
          </select>
          <select className="input" value={filters.pair} onChange={(e) => set({ pair: e.target.value })} aria-label="Currency pair">
            <option value="">Any currency</option>
            {pairs.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select className="input" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
            {Object.entries(SORTS).map(([k, { label }]) => <option key={k} value={k}>Sort: {label}</option>)}
          </select>
          <label className="check"><input type="checkbox" checked={filters.fdOnly} onChange={(e) => set({ fdOnly: e.target.checked })} /> FD named</label>
          <label className="check"><input type="checkbox" checked={filters.triggersOnly} onChange={(e) => set({ triggersOnly: e.target.checked })} /> Triggers</label>
          <label className="check"><input type="checkbox" checked={filters.showOut} onChange={(e) => set({ showOut: e.target.checked })} /> Show qualified out ({rows.filter(isOut).length})</label>
          <button className="btn-sm export" onClick={exportCsv} disabled={!visible.length}>Export CSV ({visible.length})</button>
        </div>
      </div>

      <div className="list">
        {visible.slice(0, shown).map((r) => <Account key={r.company_number || r.rank} r={r} />)}
        {!visible.length && <div className="empty">No accounts match these filters.</div>}
        {visible.length > shown && (
          <button className="btn-sm more" onClick={() => setShown((n) => n + PAGE)}>Show more ({visible.length - shown} left)</button>
        )}
      </div>
    </main>
  );
}

// Text that opens its source document when there is one.
function Src({ href, children, className, title }) {
  return href
    ? <a className={`src ${className || ""}`} href={href} target="_blank" rel="noreferrer" title={title || "Open the source document"}>{children}</a>
    : <span className={className} title={title}>{children}</span>;
}

function Account({ r }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const conf = r.finance_contact_confidence;
  const copy = async () => {
    try { await navigator.clipboard.writeText(r.opener || r.call_angle || ""); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* no clipboard */ }
  };
  const details = [
    ["Incumbent bank", r.incumbent_bank, r.incumbent_bank_url], ["Facility ends", r.facility_ends_evidence, r.accounts_url],
    ["FX today", r.fx_today_evidence, r.fx_today_url],
    ["Lenders", r.lenders], ["FX size", r.fx_estimate], ["Currency evidence", r.currency_evidence], ["Why FX", r.fx_evidence], ["Niche", r.fx_niche], ["Exposure", r.fx_exposure],
    ["Imports in", r.import_currencies], ["Exports in", r.export_currencies], ["Trade", r.trade_countries],
    ["Wallet basis", r.fx_wallet_basis], ["Why untapped", r.untapped_reasons],
    ["Contact evidence", r.finance_contact_evidence], ["Search check", r.search_check],
    ["Lead director", [r.lead_director, r.lead_director_occupation].filter(Boolean).join(" — ")],
    ["Directors", r.all_directors], ["Company secretary", r.company_secretary], ["Signed accounts", r.accounts_signed_by],
    ["Owners", r.owners], ["Group", r.group_parent], ["Parent's finance contact", r.parent_finance_contact],
    ["Banking", r.banking_relationships],
    ["FX gain/loss", fxLine(r), r.fx_gain_loss_url], ["FX figure to check", r.fx_gain_loss_check, r.fx_gain_loss_url],
    ["Growth", r.turnover_growth], ["Overseas sales", r.overseas_turnover_share],
    ["Cash / borrowings", [money(r.cash_gbp), money(r.bank_borrowings_gbp)].filter(Boolean).join(" / ")],
    ["Auditor", [r.auditor, r.auditor_tier].filter(Boolean).join(" — ")], ["Accounts", r.size_basis],
    ["Generic emails", r.generic_emails], ["Address", r.registered_address],
  ].filter(([, v]) => v);

  return (
    <article className="card">
      <div className="card-top">
        <div className="card-name">
          <span className="rank">#{r.rank}</span>
          <a href={r.companies_house_url} target="_blank" rel="noreferrer" className="co">{r.company_name}</a>
          {r.trading_as && <span className="site">t/a {r.trading_as}</span>}
          {r.website && <a className="site" href={r.website.startsWith("http") ? r.website : `https://${r.website}`} target="_blank" rel="noreferrer">{r.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}</a>}
        </div>
        <div className="figures">
          {r.turnover_gbp && <span><b>{money(r.turnover_gbp)}</b> turnover</span>}
          {wallet(r) && <span><b>{wallet(r)}</b> FX a year</span>}
          {r.fx_gain_loss_gbp && <Src href={r.fx_gain_loss_url} title="Open the accounts at the FX line"><b>{money(r.fx_gain_loss_gbp)}</b> FX {Number(r.fx_gain_loss_gbp) < 0 ? "loss" : "gain"}{fxShare(r) && ` (${fxShare(r).replace(" of turnover", "")})`}</Src>}
        </div>
      </div>

      <div className="contact">
        {r.finance_contact ? (
          <>
            <span className="person">{r.finance_contact}</span>
            <span className="role">{r.finance_contact_role}</span>
            {conf && <span className="badge" style={{ color: CONF_COLOUR[conf], borderColor: CONF_COLOUR[conf] }}>{conf}</span>}
          </>
        ) : <span className="role">No finance contact found yet</span>}
        <span className="links">
          {r.finance_contact_linkedin
            ? <a href={r.finance_contact_linkedin} target="_blank" rel="noreferrer">LinkedIn profile</a>
            : r.linkedin_search_url && <a href={r.linkedin_search_url} target="_blank" rel="noreferrer">LinkedIn search</a>}
          {r.company_name && <a href={googleFd(r)} target="_blank" rel="noreferrer">Check on Google</a>}
        </span>
      </div>

      <div className="chips">
        {parts(r.currency_pairs).map((p) => <span key={p} className="chip fx">{p}</span>)}
        {r.qualified && r.qualified !== "Yes" && <span className={`chip ${r.qualified === "Out" ? "out" : "warn"}`} title={r.qualify_reason}>{r.qualified}: {r.qualify_reason}</span>}
        {r.warm_route && <span className="chip own">Warm: {r.warm_route}</span>}
        {r.main_bank && <Src className="chip" href={bankUrl(r)} title="Open where this bank is named">{r.main_bank}{r.bank_type ? ` · ${r.bank_type}` : ""}</Src>}
        {r.facility_ends && <Src className="chip trig" href={r.accounts_url} title={r.facility_ends_evidence}>Facility ends {r.facility_ends}</Src>}
        {r.fx_today && <Src className="chip fx" href={r.fx_today_url} title={r.fx_today_evidence}>{r.fx_today}</Src>}
        {r.own_bank_client && <span className="chip own">Existing client</span>}
        {r.pe_backed && <span className="chip warn">PE-backed</span>}
        {r.family_run && <span className="chip">Family-run</span>}
        {parts(r.triggers).map((t) => <span key={t} className="chip trig">{t}</span>)}
      </div>
      {r.when_to_call && <div className="when">When to call: {r.when_to_call}{r.planning_window_now === "yes" ? " · planning window now" : ""}</div>}

      {[r.fact_1, r.fact_2].filter(Boolean).map((fact) => (
        <div key={fact} className="fact"><Src href={factUrl(r, fact)}>{fact}</Src></div>
      ))}
      {r.main_currency && (
        <div className="when">Currency: {r.main_currency} · {r.currency_direction} · {r.currency_confidence} confidence</div>
      )}

      {(r.opener || r.call_angle) && (
        <div className="angle">
          <span>{r.opener || r.call_angle}</span>
          <button className="btn-sm" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
        </div>
      )}

      <button className="more-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? "Less" : "More detail"}</button>
      {open && (
        <dl className="details">
          {details.map(([k, v, href]) => <div key={k}><dt>{k}</dt><dd><Src href={href}>{v}</Src></dd></div>)}
        </dl>
      )}
    </article>
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
.btn-primary{margin-top:16px;width:100%;padding:11px;border-radius:9px;border:none;background:linear-gradient(135deg,#10B981,#059669);color:#fff;font:700 14px 'Inter',sans-serif;cursor:pointer}
.btn-primary:disabled{opacity:.5;cursor:default}
.input{padding:8px 12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:rgba(255,255,255,.85);font:13px 'Inter',sans-serif;outline:none}
.input:focus{border-color:rgba(16,185,129,.5)}
select.input option{background:#0F141F}
.gate{min-height:calc(100vh - 52px);display:grid;place-items:center;padding:24px 16px}
.gate-card{width:100%;max-width:380px;padding:28px;border-radius:14px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08)}
.gate-title{font-size:20px;font-weight:800;color:#F8FAFC}
.gate-sub{font-size:13px;color:rgba(255,255,255,.4);margin:6px 0 20px}
.gate-label{display:block;font-size:12px;font-weight:600;color:rgba(255,255,255,.5);margin-bottom:6px}
.gate-card .input{width:100%;font-size:15px;padding:11px 14px}
.gate-error{margin-top:10px;font-size:13px;color:#F87171}
.stats{display:flex;border-bottom:1px solid rgba(255,255,255,.05);padding:0 40px;overflow-x:auto}
.stat{padding:14px 24px 14px 0;margin-right:24px;border-right:1px solid rgba(255,255,255,.05);display:flex;align-items:center;gap:10px;white-space:nowrap}
.stat:last-child{border-right:none}
.stat-n{font-size:22px;font-weight:800;line-height:1}
.stat-l{font-size:11px;font-weight:600;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.04em;display:block}
.stat-s{font-family:'JetBrains Mono',monospace;font-size:9px;color:rgba(255,255,255,.2);display:block}
.controls{padding:14px 40px;border-bottom:1px solid rgba(255,255,255,.05);display:flex;flex-direction:column;gap:12px}
.tabs{display:flex;gap:3px;flex-wrap:wrap}
.tab{padding:6px 12px;border-radius:7px;border:1px solid rgba(255,255,255,.07);background:none;color:rgba(255,255,255,.45);font:600 12px 'Inter',sans-serif;cursor:pointer}
.tab.on{background:rgba(16,185,129,.12);border-color:rgba(16,185,129,.3);color:#10B981}
.tab-n{font-family:'JetBrains Mono',monospace;font-size:10px;opacity:.7;margin-left:4px}
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.search{flex:1 1 240px;min-width:0}
.check{display:flex;align-items:center;gap:6px;font-size:12px;color:rgba(255,255,255,.6);cursor:pointer;white-space:nowrap}
.check input{accent-color:#10B981}
.export{margin-left:auto}
.list{max-width:1200px;margin:0 auto;padding:20px 40px 80px;display:flex;flex-direction:column;gap:12px}
.card{padding:16px 18px;border-radius:12px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07)}
.card-top{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline}
.card-name{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0}
.rank{font-family:'JetBrains Mono',monospace;font-size:11px;color:rgba(255,255,255,.3)}
.co{font-size:15px;font-weight:700;color:#F8FAFC;overflow-wrap:anywhere}
.site{font-size:12px;color:rgba(255,255,255,.4)}
.figures{display:flex;gap:14px;font-size:12px;color:rgba(255,255,255,.45);flex-wrap:wrap}
.figures b{color:#F8FAFC;font-weight:700}
.contact{margin-top:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.person{font-weight:700;color:#F8FAFC}
.role{font-size:13px;color:rgba(255,255,255,.5)}
.badge{font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:2px 7px;border-radius:10px;border:1px solid}
.links{display:flex;gap:12px;font-size:12px;margin-left:auto}
.chips{margin-top:10px;display:flex;gap:6px;flex-wrap:wrap}
.chip{font-size:11px;padding:3px 8px;border-radius:6px;background:rgba(255,255,255,.05);color:rgba(255,255,255,.6)}
.chip.fx{background:rgba(99,102,241,.12);color:#A5B4FC;font-family:'JetBrains Mono',monospace}
.chip.trig{background:rgba(245,158,11,.1);color:#FBBF24}
.chip.own{background:rgba(16,185,129,.12);color:#34D399}
.chip.warn{background:rgba(244,114,182,.1);color:#F9A8D4}
.chip.out{background:rgba(248,113,113,.12);color:#FCA5A5}
.when{margin-top:8px;font-size:12px;color:rgba(255,255,255,.4)}
.fact{margin-top:8px;font-size:12.5px;color:rgba(255,255,255,.75);padding-left:10px;border-left:2px solid rgba(251,191,36,.6)}
.angle{margin-top:10px;padding:10px 12px;border-radius:8px;background:rgba(16,185,129,.05);border:1px solid rgba(16,185,129,.12);font-size:13px;color:rgba(255,255,255,.75);display:flex;gap:12px;align-items:flex-start;justify-content:space-between}
.more-btn{margin-top:10px;background:none;border:none;color:rgba(255,255,255,.4);font:600 12px 'Inter',sans-serif;cursor:pointer;padding:0}
.more-btn:hover{color:#fff}
a.src{color:inherit;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px}
a.src:hover{text-decoration-style:solid}
a.chip.src{text-decoration:none}
a.chip.src:hover{filter:brightness(1.25)}
.details{margin-top:10px;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px 20px}
.details dt{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:rgba(255,255,255,.3)}
.details dd{font-size:12.5px;color:rgba(255,255,255,.7);overflow-wrap:anywhere}
.empty{padding:40px;text-align:center;color:rgba(255,255,255,.35)}
.more{align-self:center}
@media(max-width:700px){.tb,.stats,.controls,.list{padding-left:16px;padding-right:16px}.tb-tag,.tb-time{display:none}.links{margin-left:0}.export{margin-left:0}}
`;
