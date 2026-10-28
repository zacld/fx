import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { CONTACT_GROUPS, ROLE_GROUPS, SORTS, companyPath, detailSections, numberFromPath, roleGroup, sourceDocuments, bankUrl, contactGroup, factUrl, filterRows, fxShare, googleFd, isNew, isOut, money, parts, sortContacted, sortRows, toCsv, wallet } from "./format.js";

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
const GROUP_NOTE = { Confirmed: "finance contact verified or confirmed", Guess: "likely or best guess — check before calling",
                     "No one named": "no finance person found yet" };
const day = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");

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
      {data ? <Accounts data={data} password={password} /> : (
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

function Accounts({ data, password }) {
  const rows = data.rows || [];
  const [filters, setFilters] = useState({ section: "", view: "", query: "", contact: "", role: "", fdOnly: false, pair: "",
                                            triggersOnly: false, showOut: false, newOnly: false, fxLossOnly: false });
  const [sort, setSort] = useState("hot");
  const [shown, setShown] = useState(PAGE);
  const [contacted, setContacted] = useState(data.contacted || {});
  const [notes, setNotes] = useState(data.notes || {});
  const [saveError, setSaveError] = useState("");
  const set = (patch) => { setFilters((f) => ({ ...f, ...patch })); setShown(PAGE); };

  // A company's own page at /accounts/<number>; the browser's back button returns to the list where it was.
  const [pageNo, setPageNo] = useState(() => numberFromPath(window.location.pathname));
  const [listScroll, setListScroll] = useState(0);
  useEffect(() => {
    const onPop = () => setPageNo(numberFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => { window.scrollTo(0, pageNo ? 0 : listScroll); }, [pageNo]);   // eslint-disable-line react-hooks/exhaustive-deps
  const openCompany = useCallback((number) => {
    setListScroll(window.scrollY);
    window.history.pushState({ fromList: true }, "", companyPath(number));
    setPageNo(number);
  }, []);
  const backToList = useCallback(() => {
    if (window.history.state?.fromList) window.history.back();
    else { window.history.pushState(null, "", "/accounts"); setPageNo(""); }
  }, []);

  // Saves a change for one company ({contacted} or {notes}) to the site's store; the server's copy comes back.
  const save = useCallback(async (number, change) => {
    const res = await fetch(API, { method: "POST", headers: { authorization: `Bearer ${password}`, "content-type": "application/json" },
                                   body: JSON.stringify({ company_number: number, ...change }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    if (body.contacted) setContacted(body.contacted);
    if (body.notes) setNotes(body.notes);
  }, [password]);

  // Marks a company contacted (off the list, into Contacted) or back; shown at once, undone if the save fails.
  const mark = useCallback(async (number, on) => {
    const before = contacted;
    const next = { ...contacted };
    if (on) next[number] = { at: new Date().toISOString() }; else delete next[number];
    setContacted(next);
    setSaveError("");
    try { await save(number, { contacted: on }); } catch (e) {
      setContacted(before);
      setSaveError(`Couldn't save that (${e.message}) — try again.`);
    }
  }, [contacted, save]);

  // Saves a company's notes; true when saved (the editor then closes), false with the reason shown when not.
  const saveNote = useCallback(async (number, text) => {
    setSaveError("");
    try { await save(number, { notes: text }); return true; } catch (e) {
      setSaveError(`Couldn't save the note (${e.message}) — your text is still in the box.`);
      return false;
    }
  }, [save]);

  const ctx = { ...filters, madeAt: data.made_at, contacted, notes };
  const pairs = useMemo(() => [...new Set(rows.flatMap((r) => parts(r.currency_pairs)))].sort(), [rows]);
  const visible = useMemo(() => {
    const matched = filterRows(rows, ctx);
    return filters.view === "contacted" ? sortContacted(matched, contacted) : sortRows(matched, sort);
  }, [rows, filters, sort, contacted, notes, data.made_at]);   // eslint-disable-line react-hooks/exhaustive-deps
  const open = rows.filter((r) => !contacted[r.company_number]);
  const groupCounts = useMemo(() => {
    const base = filterRows(rows, { ...ctx, contact: "" });
    return Object.fromEntries(["", ...CONTACT_GROUPS].map((g) => [g, g ? base.filter((r) => contactGroup(r) === g).length : base.length]));
  }, [rows, filters, contacted, data.made_at]);   // eslint-disable-line react-hooks/exhaustive-deps
  const roleCounts = useMemo(() => {
    const base = filterRows(rows, { ...ctx, role: "" });
    return Object.fromEntries(ROLE_GROUPS.map((g) => [g, base.filter((r) => roleGroup(r) === g).length]));
  }, [rows, filters, contacted, notes, data.made_at]);   // eslint-disable-line react-hooks/exhaustive-deps
  const contactedCount = rows.length - open.length;
  const stats = [
    { n: open.length, l: "Accounts", s: "Not yet contacted", c: "#6366F1" },
    { n: open.filter((r) => contactGroup(r) === "Confirmed").length, l: "Confirmed contact", s: "Verified or confirmed", c: "#10B981" },
    { n: open.filter((r) => r.recent_fx_loss).length, l: "Recent FX loss", s: "Accounts filed in the last 6 months", c: "#F87171" },
    { n: open.filter((r) => isNew(r, data.made_at)).length, l: "New", s: "Added by the latest scan", c: "#38BDF8" },
    { n: contactedCount, l: "Contacted", s: "Moved off the list", c: "#A5B4FC" },
    { n: open.filter((r) => r.triggers).length, l: "With triggers", s: "New owner, charges, directors", c: "#F59E0B" },
  ];
  // Headings between groups: contact groups in the hottest order, job roles in the role order.
  const groupOf = filters.view === "contacted" ? null
    : sort === "hot" && !filters.contact ? contactGroup : sort === "role" && !filters.role ? roleGroup : null;

  const exportCsv = () => {
    const blob = new Blob([toCsv(visible.map((r) => ({ ...r, notes: notes[r.company_number]?.text || "" })))], { type: "text/csv;charset=utf-8" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `fx-accounts-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (pageNo) {
    const r = rows.find((x) => x.company_number === pageNo);
    return (
      <CompanyPage r={r} number={pageNo} madeAt={data.made_at} contactedAt={contacted[pageNo]?.at} onMark={mark}
                   note={notes[pageNo]} onSaveNote={(text) => saveNote(pageNo, text)} onBack={backToList} saveError={saveError} />
    );
  }

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
          {["", ...(data.sections || [])].map((s) => {
            const on = !filters.view && filters.section === s;
            return (
              <button key={s || "all"} role="tab" aria-selected={on} className={`tab${on ? " on" : ""}`}
                      onClick={() => set({ section: s, view: "" })}>
                {s || "All"} <span className="tab-n">{s ? open.filter((r) => r.section === s).length : open.length}</span>
              </button>
            );
          })}
          <button role="tab" aria-selected={filters.view === "contacted"} className={`tab contacted-tab${filters.view === "contacted" ? " on" : ""}`}
                  onClick={() => set({ section: "", view: "contacted" })}>
            Contacted <span className="tab-n">{contactedCount}</span>
          </button>
        </div>
        <div className="groups" role="group" aria-label="Finance contact">
          <span className="groups-l">Finance contact</span>
          {["", ...CONTACT_GROUPS].map((g) => (
            <button key={g || "any"} aria-pressed={filters.contact === g} className={`grp${filters.contact === g ? " on" : ""}`}
                    title={GROUP_NOTE[g] || "Everyone"} onClick={() => set({ contact: g })}>
              {g || "All"} <span className="tab-n">{groupCounts[g]}</span>
            </button>
          ))}
        </div>
        <div className="filters">
          <input className="input search" placeholder="Search company, person, niche, bank…" value={filters.query}
                 onChange={(e) => set({ query: e.target.value })} aria-label="Search" />
          <select className="input" value={filters.pair} onChange={(e) => set({ pair: e.target.value })} aria-label="Currency pair">
            <option value="">Any currency</option>
            {pairs.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select className="input" value={filters.role} onChange={(e) => set({ role: e.target.value })} aria-label="Job role">
            <option value="">Any job role</option>
            {ROLE_GROUPS.map((g) => <option key={g} value={g} disabled={!roleCounts[g]}>{g} ({roleCounts[g]})</option>)}
          </select>
          <select className="input" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort" disabled={filters.view === "contacted"}>
            {Object.entries(SORTS).map(([k, { label }]) => <option key={k} value={k}>Sort: {label}</option>)}
          </select>
          <label className="check"><input type="checkbox" checked={filters.newOnly} onChange={(e) => set({ newOnly: e.target.checked })} /> New</label>
          <label className="check"><input type="checkbox" checked={filters.fxLossOnly} onChange={(e) => set({ fxLossOnly: e.target.checked })} /> Recent FX loss</label>
          <label className="check"><input type="checkbox" checked={filters.fdOnly} onChange={(e) => set({ fdOnly: e.target.checked })} /> FD named</label>
          <label className="check"><input type="checkbox" checked={filters.triggersOnly} onChange={(e) => set({ triggersOnly: e.target.checked })} /> Triggers</label>
          <label className="check"><input type="checkbox" checked={filters.showOut} onChange={(e) => set({ showOut: e.target.checked })} /> Show qualified out ({rows.filter(isOut).length})</label>
          <button className="btn-sm export" onClick={exportCsv} disabled={!visible.length}>Export CSV ({visible.length})</button>
        </div>
      </div>

      <div className="list">
        {saveError && <div className="save-error" role="alert">{saveError}</div>}
        {visible.slice(0, shown).map((r, i, list) => {
          const group = groupOf ? groupOf(r) : "";
          const heading = groupOf && (i === 0 || groupOf(list[i - 1]) !== group);
          return (
            <Fragment key={r.company_number || r.rank}>
              {heading && (groupOf === contactGroup
                ? <h2 className="group-h">{group} <span>{groupCounts[group]} · {GROUP_NOTE[group]}</span></h2>
                : <h2 className="group-h">{group} <span>{roleCounts[group]}</span></h2>)}
              <Account r={r} isNew={isNew(r, data.made_at)} contactedAt={contacted[r.company_number]?.at} onMark={mark}
                       note={notes[r.company_number]} onSaveNote={(text) => saveNote(r.company_number, text)} onOpen={openCompany} />
            </Fragment>
          );
        })}
        {!visible.length && <div className="empty">{filters.view === "contacted" ? "Nobody marked contacted yet — use the Contacted button on a company." : "No accounts match these filters."}</div>}
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

// Zac's notes on a company: shown on the card, edited in place, kept on the site (any device).
function Notes({ note, onSave }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note?.text || "");
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (!editing) setText(note?.text || ""); }, [note, editing]);
  const save = async () => {
    setSaving(true);
    const ok = await onSave(text.trim());
    setSaving(false);
    if (ok) setEditing(false);
  };
  if (editing) {
    return (
      <div className="notes">
        <textarea className="input notes-in" rows={3} maxLength={4000} autoFocus value={text} aria-label="Notes"
                  placeholder="Who you spoke to, what they said, next step…" onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save(); if (e.key === "Escape") setEditing(false); }} />
        <div className="notes-btns">
          <button className="btn-sm contacted" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save note"}</button>
          <button className="btn-sm" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
        </div>
      </div>
    );
  }
  return note?.text ? (
    <div className="notes has">
      <div className="notes-h"><span>Notes · {day(note.at)}</span><button className="more-btn" onClick={() => setEditing(true)}>Edit</button></div>
      <p>{note.text}</p>
    </div>
  ) : <button className="more-btn add-note" onClick={() => setEditing(true)}>+ Add note</button>;
}

// Opens the company's page on a plain click; a middle/ctrl-click opens it in a new tab like any link.
function CompanyLink({ r, onOpen, className = "co" }) {
  if (!r.company_number) return <span className={className}>{r.company_name}</span>;
  return (
    <a href={companyPath(r.company_number)} className={className} title="Open this company's page"
       onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); onOpen(r.company_number); } }}>
      {r.company_name}
    </a>
  );
}

const siteUrl = (w) => (w.startsWith("http") ? w : `https://${w}`);
const siteLabel = (w) => w.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

function ContactedButton({ number, contactedAt, onMark }) {
  if (!number) return null;
  return contactedAt
    ? <span className="done">Contacted {day(contactedAt)} <button className="btn-sm" onClick={() => onMark(number, false)}>Undo</button></span>
    : <button className="btn-sm contacted" onClick={() => onMark(number, true)} title="Move this company to Contacted">Contacted</button>;
}

function FxFigure({ r }) {
  return r.fx_gain_loss_gbp
    ? <Src href={r.fx_gain_loss_url} title="Open the accounts at the FX line"><b>{money(r.fx_gain_loss_gbp)}</b> FX {Number(r.fx_gain_loss_gbp) < 0 ? "loss" : "gain"}{fxShare(r) && ` (${fxShare(r).replace(" of turnover", "")})`}</Src>
    : null;
}

function ContactLine({ r }) {
  const conf = r.finance_contact_confidence;
  return (
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
      {r.no_fd_likely && (
        <div className="no-fd" title={r.no_fd_likely}>
          <b>Probably no FD</b> — {r.no_fd_likely}.
          {r.lead_director && <> Decision-maker: <b>{r.lead_director}</b>{r.lead_director_occupation ? ` (${r.lead_director_occupation})` : ""}.</>}
        </div>
      )}
    </div>
  );
}

function Chips({ r }) {
  return (
    <div className="chips">
      {r.recent_fx_loss && <Src className="chip loss" href={r.fx_gain_loss_url} title={r.recent_fx_loss}>Recent FX loss</Src>}
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
  );
}

// When to call, the two strongest facts (each linked to its record), the currency line and the opener.
function CallPrep({ r }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(r.opener || r.call_angle || ""); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* no clipboard */ }
  };
  return (
    <>
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
    </>
  );
}

const Details = ({ rows }) => (
  <dl className="details">
    {rows.map(([k, v, href]) => <div key={k}><dt>{k}</dt><dd><Src href={href}>{v}</Src></dd></div>)}
  </dl>
);

function Account({ r, isNew: fresh, contactedAt, onMark, note, onSaveNote, onOpen }) {
  const [open, setOpen] = useState(false);
  return (
    <article className="card">
      <div className="card-top">
        <div className="card-name">
          <span className="rank">#{r.rank}</span>
          {fresh && <span className="new">New</span>}
          <CompanyLink r={r} onOpen={onOpen} />
          {r.trading_as && <span className="site">t/a {r.trading_as}</span>}
          {r.website && <a className="site" href={siteUrl(r.website)} target="_blank" rel="noreferrer">{siteLabel(r.website)}</a>}
        </div>
        <div className="card-r">
          <div className="figures">
            {r.turnover_gbp && <span><b>{money(r.turnover_gbp)}</b> turnover</span>}
            {wallet(r) && <span><b>{wallet(r)}</b> FX a year</span>}
            <FxFigure r={r} />
          </div>
          <ContactedButton number={r.company_number} contactedAt={contactedAt} onMark={onMark} />
        </div>
      </div>
      <ContactLine r={r} />
      <Chips r={r} />
      <CallPrep r={r} />
      <Notes note={note} onSave={onSaveNote} />
      <div className="card-foot">
        <button className="more-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? "Less" : "More detail"}</button>
        {r.company_number && <a className="more-btn" href={companyPath(r.company_number)} onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onOpen(r.company_number); } }}>Open company page →</a>}
      </div>
      {open && <Details rows={detailSections(r).flatMap(([, rows]) => rows)} />}
    </article>
  );
}

// One company: everything the finder knows, each fact linked to the filing or charge it came from, with notes and
// the Contacted button.
function CompanyPage({ r, number, madeAt, contactedAt, onMark, note, onSaveNote, onBack, saveError }) {
  useEffect(() => { document.title = r ? `${r.company_name} · Accounts` : "Accounts"; return () => { document.title = "Accounts"; }; }, [r]);
  if (!r) {
    return (
      <main className="page">
        <button className="btn-sm" onClick={onBack}>← All accounts</button>
        <div className="empty">Company {number} isn't in the current account list.</div>
      </main>
    );
  }
  const figures = [
    ["Turnover", money(r.turnover_gbp), r.accounts_url, r.turnover_period_end && `accounts to ${r.turnover_period_end}`],
    ["FX a year (estimate)", wallet(r), "", r.fx_wallet_basis],
    ["FX gain/loss", r.fx_gain_loss_gbp ? `${money(r.fx_gain_loss_gbp)} ${Number(r.fx_gain_loss_gbp) < 0 ? "loss" : "gain"}` : "", r.fx_gain_loss_url,
     [fxShare(r), r.fx_gain_loss_prior_gbp && `prior year ${money(r.fx_gain_loss_prior_gbp)}`].filter(Boolean).join(" · ")],
    ["Growth", r.turnover_growth, r.accounts_url, ""],
    ["Overseas sales", r.overseas_turnover_share, r.accounts_url, ""],
    ["Cash / borrowings", [money(r.cash_gbp), money(r.bank_borrowings_gbp)].filter(Boolean).join(" / "), r.accounts_url, ""],
  ].filter(([, v]) => v);
  return (
    <main className="page">
      <button className="btn-sm" onClick={onBack}>← All accounts</button>
      {saveError && <div className="save-error" role="alert">{saveError}</div>}
      <header className="pg-head">
        <div>
          <div className="card-name">
            <span className="rank">#{r.rank}</span>
            {isNew(r, madeAt) && <span className="new">New</span>}
            {r.section && <span className="chip">{r.section}</span>}
          </div>
          <h1 className="pg-title">{r.company_name}</h1>
          <div className="pg-sub">
            {r.trading_as && <span>t/a {r.trading_as}</span>}
            {r.company_number && <a href={r.companies_house_url} target="_blank" rel="noreferrer">Companies House {r.company_number}</a>}
            {r.website && <a href={siteUrl(r.website)} target="_blank" rel="noreferrer">{siteLabel(r.website)}</a>}
            {r.fx_niche && <span>{r.fx_niche}</span>}
          </div>
        </div>
        <ContactedButton number={r.company_number} contactedAt={contactedAt} onMark={onMark} />
      </header>

      {figures.length > 0 && (
        <div className="pg-figs">
          {figures.map(([label, value, href, sub]) => (
            <div className="fig" key={label}>
              <div className="fig-l">{label}</div>
              <div className="fig-v"><Src href={href}>{value}</Src></div>
              {sub && <div className="fig-s">{sub}</div>}
            </div>
          ))}
        </div>
      )}

      <div className="pg-grid">
        <section className="panel">
          <h2 className="panel-h">Finance contact</h2>
          <ContactLine r={r} />
          {r.finance_contact_evidence && <p className="panel-p">{r.finance_contact_evidence}</p>}
          {r.lead_director && <p className="panel-p">Lead director: {[r.lead_director, r.lead_director_occupation].filter(Boolean).join(" — ")}</p>}
        </section>
        <section className="panel">
          <h2 className="panel-h">Notes</h2>
          <Notes note={note} onSave={onSaveNote} />
        </section>
      </div>

      <section className="panel">
        <h2 className="panel-h">Why call</h2>
        <Chips r={r} />
        <CallPrep r={r} />
      </section>

      {detailSections(r).map(([title, rows]) => (
        <section className="panel" key={title}>
          <h2 className="panel-h">{title}</h2>
          <Details rows={rows} />
        </section>
      ))}

      <section className="panel">
        <h2 className="panel-h">Source documents</h2>
        <ul className="docs">
          {sourceDocuments(r).map(([label, url]) => <li key={url}><a href={url} target="_blank" rel="noreferrer">{label} ↗</a></li>)}
        </ul>
      </section>
    </main>
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
.chip.loss{background:rgba(248,113,113,.14);color:#FCA5A5;font-weight:600}
.new{font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:2px 7px;border-radius:10px;background:rgba(56,189,248,.15);color:#7DD3FC}
.card-r{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.btn-sm.contacted{border-color:rgba(16,185,129,.35);color:#34D399}
.btn-sm.contacted:hover{background:rgba(16,185,129,.12)}
.done{display:flex;align-items:center;gap:8px;font-size:12px;color:#A5B4FC}
.groups{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.groups-l{font-size:11px;font-weight:600;color:rgba(255,255,255,.35);text-transform:uppercase;letter-spacing:.06em;margin-right:4px}
.grp{padding:5px 11px;border-radius:14px;border:1px solid rgba(255,255,255,.1);background:none;color:rgba(255,255,255,.55);font:600 12px 'Inter',sans-serif;cursor:pointer}
.grp.on{background:rgba(56,189,248,.12);border-color:rgba(56,189,248,.35);color:#7DD3FC}
.contacted-tab{margin-left:8px}
.group-h{margin-top:10px;font-size:13px;font-weight:800;color:#F8FAFC;letter-spacing:.02em}
.group-h:first-of-type{margin-top:0}
.group-h span{font-size:11px;font-weight:500;color:rgba(255,255,255,.35);margin-left:6px}
.notes{margin-top:10px;display:flex;flex-direction:column;gap:8px}
.notes.has{padding:10px 12px;border-radius:8px;background:rgba(165,180,252,.06);border:1px solid rgba(165,180,252,.15);gap:4px}
.notes-h{display:flex;justify-content:space-between;align-items:center;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:rgba(165,180,252,.7)}
.notes-h .more-btn{margin-top:0;text-transform:none;letter-spacing:0}
.notes p{font-size:13px;color:rgba(255,255,255,.8);white-space:pre-wrap;overflow-wrap:anywhere}
.notes-in{width:100%;resize:vertical;min-height:70px;line-height:1.45}
.notes-btns{display:flex;gap:8px}
.add-note{display:block}
.card-foot{display:flex;gap:16px;align-items:center}
a.more-btn{text-decoration:none;margin-top:10px}
a.co:hover{color:#34D399}
.page{max-width:1100px;margin:0 auto;padding:20px 40px 80px;display:flex;flex-direction:column;gap:14px;align-items:stretch}
.page>.btn-sm:first-child{align-self:flex-start}
.pg-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
.pg-title{font-size:24px;font-weight:800;color:#F8FAFC;margin-top:6px;overflow-wrap:anywhere}
.pg-sub{display:flex;gap:14px;flex-wrap:wrap;font-size:13px;color:rgba(255,255,255,.45);margin-top:4px}
.pg-figs{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}
.fig{padding:12px 14px;border-radius:10px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07)}
.fig-l{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:rgba(255,255,255,.35)}
.fig-v{font-size:18px;font-weight:800;color:#F8FAFC;margin-top:2px}
.fig-s{font-size:11px;color:rgba(255,255,255,.4);margin-top:2px}
.pg-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
.panel{padding:16px 18px;border-radius:12px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07);min-width:0}
.panel-h{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.45)}
.panel .contact{margin-top:8px}
.panel-p{margin-top:8px;font-size:12.5px;color:rgba(255,255,255,.6);overflow-wrap:anywhere}
.panel .details{margin-top:8px}
.docs{list-style:none;margin-top:8px;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px 20px;font-size:13px}
.no-fd{flex-basis:100%;font-size:12.5px;color:rgba(255,255,255,.65);padding:6px 10px;border-radius:7px;background:rgba(245,158,11,.07);border:1px solid rgba(245,158,11,.18)}
.no-fd b{color:#FBBF24;font-weight:700}
.save-error{padding:10px 12px;border-radius:8px;background:rgba(248,113,113,.1);color:#FCA5A5;font-size:13px}
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
@media(max-width:700px){.tb,.stats,.controls,.list,.page{padding-left:16px;padding-right:16px}.tb-logo{font-size:0;gap:0}.tb-mark{font-size:12px}.tb-r{gap:6px}.tb .btn-sm{padding:6px 9px}.tb-tag,.tb-time{display:none}.links{margin-left:0}.export{margin-left:0}}
`;
