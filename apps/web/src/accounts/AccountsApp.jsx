import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { searchAllowance, statusLines, LOSS_SORTS, filterLosses, lossGrew, lossRows, sortLosses, CONTACT_GROUPS, ROLE_GROUPS, SORTS, askFor, chCompanyUrl, monthLabel, filedWhen, filingRow, filterFilings, sortFilings, isGroupFiling, turnoverSearch, fxFacts, fxGroup, fxScore, companyPath, contactClues, presentedContact, detailSections, numberFromPath, roleGroup, sourceDocuments, bankUrl, contactGroup, factUrl, filterRows, fxShare, googleFd, isNew, isOut, money, parts, sortRows, toCsv, wallet } from "./format.js";
import { emailDraft } from "./email.js";
import { applyEmail } from "../../api/accounts.mjs";
import { CHANNELS, RESPONSES, STATES, applyContact, followUp, sortFollowUps, touchesOf } from "./followups.js";

// The standing account list from the company finder (lead-sourcer), behind a
// password: the list is fetched from /api/accounts, which checks it.
const API = "/api/accounts";
const PW_KEY = "fx-accounts-password";
const PAGE = 50;
const EMAILS_KEY = "fx-email-generator";   // where the Email generator tab kept its companies before they moved to the site

const remembered = () => { try { return sessionStorage.getItem(PW_KEY) || ""; } catch { return ""; } };
const remember = (pw) => { try { pw ? sessionStorage.setItem(PW_KEY, pw) : sessionStorage.removeItem(PW_KEY); } catch { /* private mode */ } };

const ago = (iso) => {
  if (!iso) return "";
  const h = Math.floor((Date.now() - new Date(iso)) / 3600000);
  return h < 1 ? "under an hour ago" : h < 48 ? `${h}h ago` : `${Math.floor(h / 24)} days ago`;
};

const CONF_COLOUR = { Verified: "#10B981", Confirmed: "#38BDF8", Likely: "#F59E0B", Guess: "rgba(255,255,255,.4)" };
const GROUP_NOTE = { Confirmed: "finance contact verified or confirmed", Likely: "a likely finance lead — check before calling",
                     "Ask for the FD": "no finance contact confirmed — ask for the Finance Director by title" };
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
  const [contacted, setContacted] = useState(data.contacted || {});
  // Companies contacted but no longer in the latest scan stay on the Contacted tab (their follow-ups still matter),
  // shown with what the marks remember.
  const rows = useMemo(() => {
    const listed = data.rows || [];
    const known = new Set(listed.map((r) => r.company_number));
    const dropped = Object.entries(contacted).filter(([n]) => !known.has(n)).map(([n, mark]) => ({
      company_number: n, company_name: mark.name || `Company ${n}`, rank: 99999, dropped: true,
      companies_house_url: `https://find-and-update.company-information.service.gov.uk/company/${n}`,
    }));
    return [...listed, ...dropped];
  }, [data.rows, contacted]);
  const [filters, setFilters] = useState({ section: "", view: "", query: "", contact: "", role: "", fdOnly: false, pair: "",
                                            triggersOnly: false, showOut: false, newOnly: false, fxLossOnly: false });
  const [sort, setSort] = useState("hot");
  const [shown, setShown] = useState(PAGE);
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
  // One save at a time, in click order: two quick clicks would otherwise race on the server's read-modify-write.
  const queue = useRef(Promise.resolve());
  const save = useCallback((number, change) => {
    const run = queue.current.catch(() => {}).then(async () => {
      const res = await fetch(API, { method: "POST", headers: { authorization: `Bearer ${password}`, "content-type": "application/json" },
                                     body: JSON.stringify({ company_number: number, ...change }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (body.contacted) setContacted(body.contacted);
      if (body.notes) setNotes(body.notes);
      if (body.emails) setEmails(body.emails);
    });
    queue.current = run;
    return run;
  }, [password]);

  // A follow-up change for one company ({contacted, channel} logs a touch, {contacted: false} takes it off the
  // contacted list, {response}, {follow_up_at}): shown at once, undone if the save fails.
  const contact = useCallback(async (number, change) => {
    const before = contacted;
    setContacted(applyContact(contacted, number, change));
    setSaveError("");
    try { await save(number, change); } catch (e) {
      setContacted(before);
      setSaveError(`Couldn't save that (${e.message}) — try again.`);
    }
  }, [contacted, save]);

  // Saves a company's notes; true when saved (the editor then closes), false with the reason shown when not.
  // The Email generator tab's companies: kept on the site (any device), newest first; an edit is saved when its box
  // loses focus. Drafts kept in this browser before they moved to the site are moved over once.
  const [emails, setEmails] = useState(data.emails || {});
  const emailItems = useMemo(() => Object.entries(emails).map(([number, e]) => ({ number, ...e }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at))), [emails]);
  const saveEmail = useCallback(async (number, email) => {
    setSaveError("");
    try { await save(number, { email }); return true; } catch (e) {
      setSaveError(`Couldn't save the email (${e.message}) — try again.`);
      return false;
    }
  }, [save]);
  const toEmail = useCallback((row) => {
    setEmails((e) => applyEmail(e, row.company_number, { row }, new Date().toISOString()));
    saveEmail(row.company_number, { row });
    if (numberFromPath(window.location.pathname)) { window.history.pushState(null, "", "/accounts"); setPageNo(""); }
    setListScroll(0);
    setFilters((f) => ({ ...f, section: "", view: "email" }));
    window.scrollTo(0, 0);
  }, [saveEmail]);
  const editEmail = useCallback((number, text) => {
    setEmails((e) => applyEmail(e, number, { text }, new Date().toISOString()));
    return saveEmail(number, { text });
  }, [saveEmail]);
  const removeEmail = useCallback((number) => {
    setEmails((e) => applyEmail(e, number, null));
    return saveEmail(number, null);
  }, [saveEmail]);
  useEffect(() => {
    let old = [];
    try { old = JSON.parse(localStorage.getItem(EMAILS_KEY) || "[]"); } catch { return; }
    if (!Array.isArray(old) || !old.length) return;
    (async () => {
      for (const it of [...old].reverse()) {
        if (!it?.number || !it.row || (data.emails || {})[it.number]) continue;
        await save(it.number, { email: { row: it.row } }).catch(() => {});
        if (it.text) await save(it.number, { email: { text: it.text } }).catch(() => {});
      }
      try { localStorage.removeItem(EMAILS_KEY); } catch { /* storage off */ }
    })();
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

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
    return filters.view === "contacted" ? sortFollowUps(matched, contacted) : sortRows(matched, sort);
  }, [rows, filters, sort, contacted, notes, data.made_at]);   // eslint-disable-line react-hooks/exhaustive-deps
  const open = rows.filter((r) => !contacted[r.company_number]);
  const listedNumbers = useMemo(() => new Set((data.rows || []).map((r) => r.company_number)), [data.rows]);
  const groupCounts = useMemo(() => {
    const base = filterRows(rows, { ...ctx, contact: "" });
    return Object.fromEntries(["", ...CONTACT_GROUPS].map((g) => [g, g ? base.filter((r) => contactGroup(r) === g).length : base.length]));
  }, [rows, filters, contacted, data.made_at]);   // eslint-disable-line react-hooks/exhaustive-deps
  const roleCounts = useMemo(() => {
    const base = filterRows(rows, { ...ctx, role: "" });
    return Object.fromEntries(ROLE_GROUPS.map((g) => [g, base.filter((r) => roleGroup(r) === g).length]));
  }, [rows, filters, contacted, notes, data.made_at]);   // eslint-disable-line react-hooks/exhaustive-deps
  const contactedCount = rows.length - open.length;
  const followUpsDue = rows.filter((r) => ["overdue", "due", "replied"].includes(followUp(contacted[r.company_number], r)?.state)).length;
  const stats = [
    { n: open.length, l: "Accounts", s: "Not yet contacted", c: "#6366F1" },
    { n: open.filter((r) => fxScore(r) >= 50).length, l: "Strong FX proof", s: "Forwards, FX loss, regions… in their filings", c: "#A5B4FC" },
    { n: open.filter((r) => contactGroup(r) === "Confirmed").length, l: "Confirmed contact", s: "Verified or confirmed", c: "#10B981" },
    { n: open.filter((r) => r.recent_fx_loss).length, l: "Recent FX loss", s: "Accounts filed in the last 6 months", c: "#F87171", view: "losses" },
    { n: open.filter((r) => isNew(r, data.made_at)).length, l: "New", s: "Added by the latest scan", c: "#38BDF8" },
    { n: followUpsDue, l: "Follow-ups due", s: `Today or overdue · ${contactedCount} contacted`, c: followUpsDue ? "#F87171" : "#A5B4FC" },
    { n: open.filter((r) => r.triggers).length, l: "With triggers", s: "New owner, charges, directors", c: "#F59E0B" },
  ];
  // Headings between groups: follow-up state on the Contacted tab, FX proof bands in the hottest order, contact
  // groups in the confirmed-first order, job roles in the role order.
  const stateOf = (r) => STATES[followUp(contacted[r.company_number], r)?.state] || "";
  const hasFxScores = rows.some((r) => r.filed_fx_score !== undefined);   // lists made before the score existed: no headings
  const groupOf = filters.view === "contacted" ? stateOf
    : sort === "hot" && hasFxScores ? fxGroup : sort === "contactFirst" && !filters.contact ? contactGroup
    : sort === "role" && !filters.role ? roleGroup : null;

  const exportCsv = () => {
    const blob = new Blob([toCsv(visible.map((r) => ({ ...r, notes: notes[r.company_number]?.text || "", email_draft: emailDraft(r).text })))], { type: "text/csv;charset=utf-8" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `fx-accounts-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (pageNo) {
    const r = rows.find((x) => x.company_number === pageNo);
    return (
      <CompanyPage r={r} number={pageNo} madeAt={data.made_at} mark={contacted[pageNo]} onContact={contact}
                   note={notes[pageNo]} onSaveNote={(text) => saveNote(pageNo, text)} onBack={backToList} saveError={saveError} onEmail={toEmail} />
    );
  }

  return (
    <main>
      <StatusStrip status={data.status} />
      <div className="stats">
        {stats.map(({ n, l, s, c, view }) => {
          const inner = <><div className="stat-n" style={{ color: c }}>{n}</div>
            <div><span className="stat-l">{l}</span><span className="stat-s">{s}</span></div></>;
          return view
            ? <button className="stat stat-go" key={l} onClick={() => set({ section: "", view })} title="Open the FX losses tab">{inner}</button>
            : <div className="stat" key={l}>{inner}</div>;
        })}
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
            {followUpsDue > 0 && <span className="due-n" title="Follow-ups due today or overdue">{followUpsDue} due</span>}
          </button>
          <button role="tab" aria-selected={filters.view === "filings"} className={`tab filings-tab${filters.view === "filings" ? " on" : ""}`}
                  title="Companies of £20m+ whose newly filed accounts show FX" onClick={() => set({ section: "", view: "filings" })}>
            Recent FX filings
          </button>
          <button role="tab" aria-selected={filters.view === "losses"} className={`tab losses-tab${filters.view === "losses" ? " on" : ""}`}
                  title="Companies whose latest accounts show a loss on currency" onClick={() => set({ section: "", view: "losses" })}>
            FX losses
          </button>
          <button role="tab" aria-selected={filters.view === "email"} className={`tab email-tab${filters.view === "email" ? " on" : ""}`}
                  title="The Investec email for each company you send here" onClick={() => set({ section: "", view: "email" })}>
            Email generator <span className="tab-n">{emailItems.length}</span>
          </button>
        </div>
        {!["filings", "email", "losses"].includes(filters.view) && <>
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
        </>}
      </div>

      {filters.view === "losses" ? <FxLosses password={password} listRows={rows} contacted={contacted} onContact={contact} onOpen={openCompany} onEmail={toEmail} />
       : filters.view === "email" ? <EmailGenerator items={emailItems} onChange={editEmail} onRemove={removeEmail} onOpen={openCompany} />
       : filters.view === "filings" ? <Filings password={password} listed={listedNumbers} onOpen={openCompany} onEmail={toEmail} /> : (
      <div className="list">
        {saveError && <div className="save-error" role="alert">{saveError}</div>}
        {visible.slice(0, shown).map((r, i, list) => {
          const group = groupOf ? groupOf(r) : "";
          const heading = groupOf && (i === 0 || groupOf(list[i - 1]) !== group);
          return (
            <Fragment key={r.company_number || r.rank}>
              {heading && (groupOf === contactGroup
                ? <h2 className="group-h">{group} <span>{groupCounts[group]} · {GROUP_NOTE[group]}</span></h2>
                : groupOf === roleGroup ? <h2 className="group-h">{group} <span>{roleCounts[group]}</span></h2>
                : <h2 className="group-h">{group} <span>{list.filter((x) => groupOf(x) === group).length}</span></h2>)}
              <Account r={r} isNew={isNew(r, data.made_at)} mark={contacted[r.company_number]} onContact={contact}
                       note={notes[r.company_number]} onSaveNote={(text) => saveNote(r.company_number, text)} onOpen={openCompany} onEmail={toEmail} />
            </Fragment>
          );
        })}
        {!visible.length && <div className="empty">{filters.view === "contacted" ? "Nobody marked contacted yet — use the Contacted button on a company." : "No accounts match these filters."}</div>}
        {visible.length > shown && (
          <button className="btn-sm more" onClick={() => setShown((n) => n + PAGE)}>Show more ({visible.length - shown} left)</button>
        )}
      </div>
      )}
    </main>
  );
}

// The Recent FX filings tab: companies of £20m+ whose accounts, filed online in the last year, show FX — read from
// Companies House's bulk accounts files each morning (lead-sourcer/sourcer/filings.py). Loaded when first opened.
function Filings({ password, listed, onOpen, onEmail }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [strongOnly, setStrongOnly] = useState(false);
  const [lossOnly, setLossOnly] = useState(false);
  const [movedOnly, setMovedOnly] = useState(false);
  const [order, setOrder] = useState("newest");
  const [shown, setShown] = useState(PAGE);
  // The index lists the months filed (a year runs to ~15,000 companies, so each month is fetched on its own).
  const [month, setMonth] = useState("");
  const [monthRows, setMonthRows] = useState({});
  const get = useCallback(async (query) => {
    const res = await fetch(`${API}?view=filings${query}`, { headers: { authorization: `Bearer ${password}` }, cache: "no-store" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  }, [password]);
  useEffect(() => {
    let live = true;
    get("").then((body) => { if (live) { setData(body); setMonth(body.months?.[0]?.month || ""); } })
      .catch((e) => { if (live) setError(e.message === "Failed to fetch" ? "Couldn't reach the site — check your connection." : e.message); });
    return () => { live = false; };
  }, [get]);
  useEffect(() => {
    if (!month || monthRows[month]) return;
    let live = true;
    get(`&month=${month}`).then((body) => { if (live) setMonthRows((m) => ({ ...m, [month]: body.rows || [] })); })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [month, monthRows, get]);
  const all = data?.rows || monthRows[month] || [];   // data.rows: the first, single-item version
  const rows = useMemo(() => sortFilings(filterFilings(all, { query, strongOnly, lossOnly, movedOnly }), order),
                       [all, query, strongOnly, lossOnly, movedOnly, order]);
  if (error) return <div className="list"><div className="empty">{error}</div></div>;
  if (!data || (month && !monthRows[month] && !data.rows)) return <div className="list"><div className="empty">Loading recent FX filings…</div></div>;
  return (
    <div className="list">
      {data.months?.length > 0 && (
        <div className="tabs filings-months" role="tablist" aria-label="Month filed">
          {data.months.map(({ month: m, count }) => (
            <button key={m} role="tab" aria-selected={m === month} className={`tab${m === month ? " on" : ""}`}
                    onClick={() => { setMonth(m); setShown(PAGE); }}>
              {monthLabel(m)} <span className="tab-n">{count}</span>
            </button>
          ))}
        </div>
      )}
      <div className="filters filings-bar">
        <input className="input search" placeholder="Search company, currency, region…" value={query}
               onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }} aria-label="Search filings" />
        <select className="input" value={order} onChange={(e) => { setOrder(e.target.value); setShown(PAGE); }} aria-label="Order">
          <option value="newest">Newest filed first</option>
          <option value="strongest">Strongest FX proof first (owned abroad lower)</option>
        </select>
        <label className="check"><input type="checkbox" checked={strongOnly} onChange={(e) => setStrongOnly(e.target.checked)} /> Strong FX proof ({all.filter((r) => r.filed_fx_score >= 50).length})</label>
        <label className="check"><input type="checkbox" checked={lossOnly} onChange={(e) => setLossOnly(e.target.checked)} /> FX loss ({all.filter((r) => Number(r.fx_gain_loss_gbp) < 0).length})</label>
        <label className="check"><input type="checkbox" checked={movedOnly} onChange={(e) => setMovedOnly(e.target.checked)} /> Moved up from small ({all.filter((r) => r.moved_up).length})</label>
        <span className="muted">{rows.length} of {all.length} · scanned {ago(data.made_at)}</span>
      </div>
      <p className="filings-note">Companies of £{Math.round((data.min_turnover || 20e6) / 1e6)}m+ turnover whose accounts filed online in the last year
        show FX, by the month they filed{data.count ? ` (${data.count.toLocaleString()} in all)` : ""}. Paper (scanned) filings aren't in Companies House's files, so they're found by the main list instead.</p>
      {rows.slice(0, shown).map((r) => <FilingCard key={r.company_number} r={r} listed={listed.has(r.company_number)} onOpen={onOpen} onEmail={onEmail} />)}
      {!rows.length && <div className="empty">{all.length ? "No filings match these filters." : "No FX filings found yet."}</div>}
      {rows.length > shown && <button className="btn-sm more" onClick={() => setShown((n) => n + PAGE)}>Show more ({rows.length - shown} left)</button>}
    </div>
  );
}

function FilingCard({ r, listed, onOpen, onEmail }) {
  return (
    <article className="card">
      <div className="card-top">
        <div className="card-name">
          <span className="new filed">Filed {filedWhen(r.filed)}</span>
          {listed
            ? <a className="co" href={companyPath(r.company_number)} onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onOpen(r.company_number); } }}>{r.company_name}</a>
            : <a className="co" href={chCompanyUrl(r.company_number)} target="_blank" rel="noreferrer"
                 title="Open on Companies House (by company number)">{r.company_name}</a>}
          {isGroupFiling(r) && <span className="new group" title={r.also_filed ? `Also filed by ${r.also_filed}` : "Consolidated group accounts"}>Group</span>}
          <a className="site" href={chCompanyUrl(r.company_number)} target="_blank" rel="noreferrer">{r.company_number}</a>
        </div>
        <div className="figures">
          {r.turnover_gbp ? <span><b>{money(r.turnover_gbp)}</b> {r.turnover_basis === "group" ? "group " : ""}turnover</span>
            : r.size_estimate ? <span className="estimate" title={r.size_estimate_basis}>Size <b>{r.size_estimate}</b> <i>estimate</i></span>
            : <span className="muted">Turnover not stated</span>}
          {r.period_end && <span className="muted">year to {filedWhen(r.period_end)}</span>}
        </div>
      </div>
      <FxStrip r={filingRow(r)} />
      {r.size_estimate && !r.turnover_gbp && <div className="filing-note">No turnover filed: size {r.size_estimate_basis}.</div>}
      {r.hmrc_trade && <div className="filing-note customs">{r.hmrc_trade}</div>}
      {(r.incumbent_bank || r.owner || r.directors) && (
        <div className="filing-research">
          {r.incumbent_bank && <div><span className="fxl">Bank</span> <Src href={r.incumbent_bank_url}>{r.incumbent_bank}</Src>
            {r.lenders && <span className="muted"> · also {r.lenders}</span>}</div>}
          {r.owner && <div><span className="fxl">Owner</span> {r.owner}</div>}
          {r.run_from_abroad && <div className="abroad"><span className="fxl">Owned abroad</span> {r.run_from_abroad}</div>}
          {r.directors && <div><span className="fxl">Directors</span> {r.directors}{r.director_count > 5 ? ` +${r.director_count - 5} more` : ""}</div>}
        </div>
      )}
      {r.triggers && <div className="chips">{r.triggers.split(" | ").map((t) => <span className="chip trig" key={t}>{t}</span>)}</div>}
      {r.fx_mentions?.length > 0 && (
        <details className="fx-mentions">
          <summary>What the accounts say about currency and trade abroad ({r.fx_mention_count || r.fx_mentions.length} mention{(r.fx_mention_count || r.fx_mentions.length) === 1 ? "" : "s"})</summary>
          <ul>{r.fx_mentions.map((m) => <li key={m}>“{m}”</li>)}</ul>
        </details>
      )}
      <div className="chips">
        {listed ? <span className="chip own">On your Accounts list</span> : <span className="chip">Not on your list yet</span>}
        {r.moved_up && <span className="chip trig" title="From the company's filing history on Companies House">{r.moved_up}</span>}
        {r.bank_debt && <span className="chip" title="From the filed accounts">{r.bank_debt}</span>}
        {r.group_parent
          ? <span className="chip" title={r.size_estimate_basis || ""}>Files no turnover — sized by its group, {r.group_parent}</span>
          : isGroupFiling(r) && <span className="chip">Group of companies{r.turnover_basis === "group" ? " — consolidated figures" : ""}{r.also_filed ? `; also filed by ${r.also_filed}` : ""}</span>}
        {r.group_check === "pending" && <span className="chip warn" title="No turnover filed; its UK parent's accounts are read on the next scan">No turnover filed — checking its group</span>}
        {r.accounts_regime && <span className="chip" title="The size regime the accounts were prepared under">Filed as {r.accounts_regime === "small" ? "a small company" : "medium-sized"}</span>}
        {r.auditor && <span className="chip">Auditor {r.auditor}</span>}
        {r.bankers && <span className="chip">Bankers {r.bankers}</span>}
        <a className="chip" href={r.accounts_url} target="_blank" rel="noreferrer">Filing history ↗</a>
        {r.fd_search_url && <a className="chip" href={r.fd_search_url} target="_blank" rel="noreferrer" title="Who's the finance director? A Google search">Google the FD ↗</a>}
        {!r.turnover_gbp && <a className="chip" href={turnoverSearch(r.company_name)} target="_blank" rel="noreferrer"
                                title="Google their turnover: press, the group's accounts, their site (check it's not an estimate)">Search turnover ↗</a>}
      </div>
      <div className="card-foot"><EmailButton r={filingRow(r)} onEmail={onEmail} /></div>
    </article>
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

// "Contacted" asks how (phone, email, LinkedIn, in person), then moves the company to the Contacted tab.
function ContactedButton({ number, name, mark, onContact }) {
  const [choosing, setChoosing] = useState(false);
  if (!number) return null;
  if (mark) {
    const f = followUp(mark);
    return <span className={`state st-${f.state}`}>{STATES[f.state]}</span>;
  }
  if (!choosing) {
    return <button className="btn-sm contacted" onClick={() => setChoosing(true)} title="Log how you contacted them and move them to Contacted">Contacted</button>;
  }
  return (
    <span className="channels" role="group" aria-label="How did you contact them?">
      <span className="channels-l">How?</span>
      {Object.entries(CHANNELS).map(([k, label]) => (
        <button key={k} className="btn-sm contacted" onClick={() => { setChoosing(false); onContact(number, { contacted: true, channel: k, company_name: name }); }}>{label}</button>
      ))}
      <button className="btn-sm" onClick={() => setChoosing(false)} aria-label="Cancel">×</button>
    </span>
  );
}

const dayLabel = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : "");
const whenLabel = (f) => f.inDays === null ? "" : f.inDays < 0 ? `${-f.inDays} day${f.inDays === -1 ? "" : "s"} overdue`
  : f.inDays === 0 ? "today" : f.inDays === 1 ? "tomorrow" : `in ${f.inDays} days`;

// Where a contacted company stands: touches so far, the suggested next step and when, a copy-ready line, and buttons
// to log the next touch, record a reply or meeting, or move the date. Reminders only — nothing is sent.
function FollowUpPanel({ r, mark, onContact }) {
  const [copied, setCopied] = useState(false);
  const f = followUp(mark, r);
  if (!f) return null;
  const number = r.company_number;
  const copy = async () => { try { await navigator.clipboard.writeText(f.line); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* no clipboard */ } };
  return (
    <div className={`follow st-${f.state}`}>
      <div className="follow-h">
        <span className={`state st-${f.state}`}>{STATES[f.state]}</span>
        <span className="follow-next"><b>{f.action}</b>{f.nextDay && ` — ${dayLabel(f.nextDay)}${whenLabel(f) ? ` (${whenLabel(f)})` : ""}`}</span>
      </div>
      <div className="follow-touches">
        {f.touches} touch{f.touches === 1 ? "" : "es"}: {touchesOf(mark).map((t) => `${CHANNELS[t.channel] || "Contacted"} ${day(t.at)}`).join(" · ")}
      </div>
      {f.line && (
        <div className="angle">
          <span>{f.line}</span>
          <button className="btn-sm" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
        </div>
      )}
      <div className="follow-btns">
        <span className="channels-l">Log a touch</span>
        {Object.entries(CHANNELS).map(([k, label]) => (
          <button key={k} className="btn-sm" onClick={() => onContact(number, { contacted: true, channel: k, company_name: r.company_name })}>{label}</button>
        ))}
      </div>
      <div className="follow-btns">
        <span className="channels-l">Outcome</span>
        {Object.entries(RESPONSES).map(([k, label]) => (
          <button key={k} className={`btn-sm${mark.response === k ? " on" : ""}`} aria-pressed={mark.response === k}
                  onClick={() => onContact(number, { response: mark.response === k ? "" : k })}>{label}</button>
        ))}
        <label className="follow-date">Next follow-up
          <input className="input" type="date" value={f.nextDay || ""} onChange={(e) => onContact(number, { follow_up_at: e.target.value })} />
        </label>
        <button className="more-btn undo" onClick={() => onContact(number, { contacted: false })} title="Take it off the contacted list">Remove from contacted</button>
      </div>
    </div>
  );
}

function FxFigure({ r }) {
  return r.fx_gain_loss_gbp
    ? <Src href={r.fx_gain_loss_url} title="Open the accounts at the FX line"><b>{money(r.fx_gain_loss_gbp)}</b> FX {Number(r.fx_gain_loss_gbp) < 0 ? "loss" : "gain"}{fxShare(r) && ` (${fxShare(r).replace(" of turnover", "")})`}</Src>
    : null;
}

// What their own filings say about FX, first on the card: currencies, how they do FX (forwards with their size),
// the FX gain/loss, sales by region, sensitivity, balances — each linked to its page, the quote on hover.
function FxStrip({ r, full = false }) {
  const facts = fxFacts(r);
  if (!facts.length) return null;
  return (
    <div className={`fxstrip${full ? " full" : ""}`}>
      {r.filed_fx_score !== undefined && (
        <span className="fxscore" title={r.filed_fx ? r.filed_fx.split(" | ").join("\n") : "Nothing about FX in their filings yet"}>
          FX proof {fxScore(r)}
        </span>
      )}
      {facts.map(([label, value, href, quote]) => (
        <div className="fxfact" key={label}>
          <span className="fxl">{label}</span>
          <Src href={href} title={quote || undefined}>{value}</Src>
          {full && quote && quote !== value && <div className="fxq">{quote}</div>}
        </div>
      ))}
    </div>
  );
}

function ContactLine({ r }) {
  const conf = r.finance_contact_confidence;
  return (
    <div className="contact">
      {presentedContact(r) ? (
        <>
          <span className="person">{r.finance_contact}</span>
          <span className="role">{r.finance_contact_role}</span>
          {conf && <span className="badge" style={{ color: CONF_COLOUR[conf], borderColor: CONF_COLOUR[conf] }}>{conf}</span>}
        </>
      ) : <span className="person ask">{askFor(r)}</span>}
      <span className="links">
        {presentedContact(r) && r.finance_contact_linkedin
          ? <a href={r.finance_contact_linkedin} target="_blank" rel="noreferrer">LinkedIn profile</a>
          : r.linkedin_search_url && <a href={r.linkedin_search_url} target="_blank" rel="noreferrer">LinkedIn search</a>}
        {r.company_name && <a href={googleFd(r)} target="_blank" rel="noreferrer">Check on Google</a>}
      </span>
      {!presentedContact(r) && contactClues(r).length > 0 && (
        <div className="clues" title="Research clues: named in the register or accounts, but nothing says they run finance">
          Clues: {contactClues(r).join(" · ")}
        </div>
      )}
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
      {r.dropped && <span className="chip warn" title="Contacted earlier; the latest scan didn't list it (its follow-ups are kept)">Not in the latest scan</span>}
      {r.recent_fx_loss && <Src className="chip loss" href={r.fx_gain_loss_url} title={r.recent_fx_loss}>Recent FX loss</Src>}
      {parts(r.currency_pairs).map((p) => <span key={p} className="chip fx">{p}</span>)}
      {r.qualified && r.qualified !== "Yes" && <span className={`chip ${r.qualified === "Out" ? "out" : "warn"}`} title={r.qualify_reason}>{r.qualified}: {r.qualify_reason}</span>}
      {r.warm_route && <span className="chip own">Warm: {r.warm_route}</span>}
      {r.main_bank && <Src className="chip" href={bankUrl(r)} title="Open where this bank is named">{r.main_bank}{r.bank_type ? ` · ${r.bank_type}` : ""}</Src>}
      {r.facility_ends && <Src className="chip trig" href={r.accounts_url} title={r.facility_ends_evidence}>Facility ends {r.facility_ends}</Src>}
      {r.own_bank_client && <span className="chip own">Existing client</span>}
      {r.pe_backed && <span className="chip warn">PE-backed</span>}
      {r.run_from_abroad && <span className="chip warn" title={r.run_from_abroad}>Owned abroad: pitch the UK team</span>}
      {r.family_run && <span className="chip">Family-run</span>}
      {parts(r.triggers).map((t) => <span key={t} className="chip trig">{t}</span>)}
    </div>
  );
}

// The FX losses tab: every company whose latest accounts show a loss on currency — the main list's (with its finance
// contact) and the Recent FX filings list's not on it yet — biggest first, each linked to the accounts it came from.
const LOSS_MINS = [[0, "Any size"], [25000, "£25k+"], [50000, "£50k+"], [100000, "£100k+"], [250000, "£250k+"], [1000000, "£1m+"]];
function FxLosses({ password, listRows, contacted, onContact, onOpen, onEmail }) {
  const [filingLosses, setFilingLosses] = useState(null);
  const [error, setError] = useState("");
  const [min, setMin] = useState(50000);
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState(false);
  const [unhedged, setUnhedged] = useState(false);
  const [grew, setGrew] = useState(false);
  const [order, setOrder] = useState("biggest");
  const [shown, setShown] = useState(PAGE);
  useEffect(() => {
    let live = true;
    fetch(`${API}?view=losses`, { headers: { authorization: `Bearer ${password}` }, cache: "no-store" })
      .then(async (res) => { const body = await res.json().catch(() => ({})); if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`); return body; })
      .then((body) => { if (live) setFilingLosses(body.rows || []); })
      .catch((e) => { if (live) { setError(e.message === "Failed to fetch" ? "Couldn't reach the site — check your connection." : e.message); setFilingLosses([]); } });
    return () => { live = false; };
  }, [password]);
  const all = useMemo(() => lossRows(listRows.filter((r) => !contacted[r.company_number]), filingLosses || []), [listRows, contacted, filingLosses]);
  const rows = useMemo(() => sortLosses(filterLosses(all, { min, query, recentDays: recent ? 183 : 0, unhedged, grew }), order),
                       [all, min, query, recent, unhedged, grew, order]);
  const reset = (fn) => (v) => { fn(v); setShown(PAGE); };
  if (filingLosses === null) return <div className="list"><div className="empty">Loading FX losses…</div></div>;
  return (
    <div className="list">
      {error && <div className="save-error" role="alert">Recent FX filings' losses couldn't load ({error}); showing your Accounts list's only.</div>}
      <div className="filters filings-bar">
        <input className="input search" placeholder="Search company, contact, currency, bank…" value={query}
               onChange={(e) => reset(setQuery)(e.target.value)} aria-label="Search FX losses" />
        <select className="input" value={min} onChange={(e) => reset(setMin)(Number(e.target.value))} aria-label="Loss at least">
          {LOSS_MINS.map(([v, label]) => <option key={v} value={v}>Loss {label}</option>)}
        </select>
        <select className="input" value={order} onChange={(e) => reset(setOrder)(e.target.value)} aria-label="Order">
          {Object.entries(LOSS_SORTS).map(([k, { label }]) => <option key={k} value={k}>Sort: {label}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={recent} onChange={(e) => reset(setRecent)(e.target.checked)} /> Filed in the last 6 months</label>
        <label className="check" title="No forward contracts, options or FX provider named in their accounts"><input type="checkbox" checked={unhedged} onChange={(e) => reset(setUnhedged)(e.target.checked)} /> No hedging named</label>
        <label className="check"><input type="checkbox" checked={grew} onChange={(e) => reset(setGrew)(e.target.checked)} /> Worse than last year</label>
        <span className="muted">{rows.length.toLocaleString()} of {all.length.toLocaleString()} with an FX loss</span>
        <button className="btn-sm export" onClick={() => exportLosses(rows)} disabled={!rows.length}>Export CSV ({rows.length})</button>
      </div>
      <p className="filings-note">Companies whose latest filed accounts show a loss on currency (exchange differences), from your Accounts list and the
        Recent FX filings scan. Each figure links to the accounts it came from; figures that failed the sense checks are left out. Companies you've
        marked contacted are in the Contacted tab.</p>
      {rows.slice(0, shown).map((r) => <LossCard key={r.company_number} r={r} onOpen={onOpen} onEmail={onEmail} onContact={onContact} />)}
      {!rows.length && <div className="empty">No FX losses match these filters.</div>}
      {rows.length > shown && <button className="btn-sm more" onClick={() => setShown((n) => n + PAGE)}>Show more ({rows.length - shown} left)</button>}
    </div>
  );
}

// The FX losses shown, for a spreadsheet: the loss and its context, the finance contact, and the email draft.
const LOSS_EXPORT = ["company_name", "company_number", "on_list", "fx_loss_gbp", "fx_prior_gbp", "share_of_turnover", "turnover_gbp",
  "filed", "hedging", "currency", "turnover_regions", "incumbent_bank", "finance_contact", "finance_contact_role",
  "finance_contact_confidence", "accounts_url", "email_draft"];
function exportLosses(rows) {
  const out = rows.map((r) => ({
    company_name: r.company_name, company_number: r.company_number, on_list: r.onList ? "yes" : "",
    fx_loss_gbp: Math.round(r.loss), fx_prior_gbp: r.prior ?? "", share_of_turnover: r.share !== null ? `${(r.share * 100).toFixed(1)}%` : "",
    turnover_gbp: r.turnover_gbp || "", filed: r.filedOn, hedging: r.fx_forwards || r.fx_today || "none named in the accounts",
    currency: r.currencies_in_accounts || r.main_currency || "", turnover_regions: r.turnover_regions || "",
    incumbent_bank: (r.incumbent_bank || "").split(":")[0], finance_contact: r.finance_contact || "",
    finance_contact_role: r.finance_contact_role || "", finance_contact_confidence: r.finance_contact_confidence || "",
    accounts_url: r.fx_gain_loss_url || r.accounts_url || "", email_draft: emailDraft(r).text,
  }));
  const blob = new Blob([toCsv(out, LOSS_EXPORT)], { type: "text/csv;charset=utf-8" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `fx-losses-${new Date().toISOString().slice(0, 10)}.csv` });
  a.click();
  URL.revokeObjectURL(a.href);
}

function LossCard({ r, onOpen, onEmail, onContact }) {
  const priorLine = r.prior === null ? "" : `last year ${r.prior < 0 ? "a loss of " + money(-r.prior) : r.prior > 0 ? "a gain of " + money(r.prior) : "nil"}`;
  return (
    <article className="card loss-card">
      <div className="card-top">
        <div className="card-name">
          {r.onList
            ? <a className="co" href={companyPath(r.company_number)} onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onOpen(r.company_number); } }}>{r.company_name}</a>
            : <a className="co" href={chCompanyUrl(r.company_number)} target="_blank" rel="noreferrer" title="Open on Companies House">{r.company_name}</a>}
          {r.onList ? <span className="chip own">On your Accounts list</span> : <span className="chip">From Recent FX filings</span>}
          {lossGrew(r) && <span className="chip warn">Worse than last year</span>}
        </div>
        <div className="loss-fig">
          <Src href={r.fx_gain_loss_url || r.accounts_url} title={r.fx_gain_loss_evidence || "Open the accounts"}><b>−{money(r.loss)}</b> FX loss</Src>
          <span className="muted">{[r.share !== null ? `${(r.share * 100).toFixed(1)}% of ${money(r.turnover_gbp)} turnover` : r.size_estimate,
            priorLine].filter(Boolean).join(" · ")}</span>
        </div>
      </div>
      <div className="loss-facts">
        <span><span className="fxl">Filed</span> {r.accounts_filed_on ? filedWhen(r.accounts_filed_on.slice(0, 10)) : r.filed ? filedWhen(r.filed) : "—"}</span>
        <span><span className="fxl">Hedging</span> {r.fx_forwards || r.fx_today || <em>none named in the accounts</em>}</span>
        {(r.main_currency || r.currencies_in_accounts) && <span><span className="fxl">Currency</span> {r.currencies_in_accounts || r.main_currency}</span>}
        {r.turnover_regions && <span><span className="fxl">Sales</span> {r.turnover_regions}</span>}
        {r.incumbent_bank && <span><span className="fxl">Bank</span> {r.incumbent_bank.split(":")[0]}</span>}
      </div>
      <div className="loss-facts">
        {r.finance_contact
          ? <span><span className="fxl">Finance</span> {r.finance_contact}{r.finance_contact_role ? ` · ${r.finance_contact_role}` : ""}{r.finance_contact_confidence ? ` (${r.finance_contact_confidence})` : ""}</span>
          : <span><span className="fxl">Finance</span> <em>no one confirmed</em>{(r.fd_search_url || r.company_name) && <> · <a href={r.fd_search_url || googleFd(r)} target="_blank" rel="noreferrer">Google the FD ↗</a></>}</span>}
        {r.run_from_abroad && <span className="muted">{r.run_from_abroad}</span>}
      </div>
      <div className="card-foot">
        {r.onList && <a className="more-btn" href={companyPath(r.company_number)} onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onOpen(r.company_number); } }}>Open company page →</a>}
        <EmailButton r={r} onEmail={onEmail} />
        {r.onList && <span className="loss-contacted"><ContactedButton number={r.company_number} name={r.company_name} mark={null} onContact={onContact} /></span>}
      </div>
    </article>
  );
}

// Each data feed's last run — ok, stale (older than it should be) or failed, linked to the run's log — and the
// contact searches left this month: a broken run shows here instead of passing unnoticed.
function StatusStrip({ status }) {
  const lines = statusLines(status);
  if (lines.every((l) => l.level === "unknown")) return null;
  const searches = searchAllowance(status);
  return (
    <div className="status-strip">
      {lines.map((l) => (
        <span key={l.job} className={`st st-${l.level}`} title={l.note || ""}>
          <span className="st-dot" />{l.label}: {l.run && l.level !== "ok" ? <a href={l.run} target="_blank" rel="noreferrer">{l.text}</a> : l.text}
        </span>
      ))}
      {searches && <span className="st st-info" title="Web searches used to confirm finance contacts">Searches left this month: {searches}</span>}
    </div>
  );
}

// A button at the foot of a card: takes the company to the Email generator tab.
function EmailButton({ r, onEmail }) {
  return <button className="more-btn email-go" onClick={() => onEmail(r)} title="Draft the Investec email for this company in the Email generator tab">Email generator →</button>;
}

// The Email generator tab: each company taken there, newest first, with the Investec master cold email filled in from
// its filings (email.js) in an editable box — copy it, fill the gaps, send it yourself. Nothing is sent from here.
function EmailGenerator({ items, onChange, onRemove, onOpen }) {
  if (!items.length) {
    return <div className="list"><div className="empty">No companies here yet — press “Email generator →” at the bottom of a company’s card.</div></div>;
  }
  return <div className="list">{items.map((it) => <EmailItem key={it.number} it={it} onChange={onChange} onRemove={onRemove} onOpen={onOpen} />)}</div>;
}

function EmailItem({ it, onChange, onRemove, onOpen }) {
  const draft = useMemo(() => emailDraft(it.row || {}), [it.row]);
  const saved = it.text ?? draft.text;
  const [text, setText] = useState(saved);
  useEffect(() => { setText(saved); }, [saved]);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* no clipboard */ }
  };
  const keep = () => { if (text !== saved) onChange(it.number, text === draft.text ? null : text); };
  const r = it.row || {};
  return (
    <article className="card email-card">
      <div className="card-top">
        <div className="card-name">
          {r.company_number && r.rank
            ? <a className="co" href={companyPath(r.company_number)} onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onOpen(r.company_number); } }}>{r.company_name}</a>
            : <a className="co" href={chCompanyUrl(r.company_number || it.number)} target="_blank" rel="noreferrer">{r.company_name}</a>}
          {r.finance_contact && <span className="muted">{r.finance_contact}{r.finance_contact_role ? ` · ${r.finance_contact_role}` : ""}</span>}
        </div>
        <div className="email-btns">
          <button className="btn-sm contacted" onClick={copy}>{copied ? "Copied" : "Copy email"}</button>
          {text !== draft.text && <button className="btn-sm" onClick={() => { setText(draft.text); onChange(it.number, null); }} title="Back to the generated draft">Reset</button>}
          <button className="btn-sm" onClick={() => onRemove(it.number)}>Remove</button>
        </div>
      </div>
      <textarea className="input email-edit" rows={16} value={text} aria-label={`Email to ${r.company_name}`}
                onChange={(e) => setText(e.target.value)} onBlur={keep} />
      {draft.gaps.length > 0 && <div className="email-gaps">Fill in: {draft.gaps.join(" · ")}</div>}
      {draft.basis.length > 0 && <div className="email-basis">From: {draft.basis.join(" · ")}</div>}
    </article>
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
        <div className="when">Currency: {[r.main_currency, r.currency_direction, r.currency_confidence && `${r.currency_confidence} confidence`].filter(Boolean).join(" · ")}</div>
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

function Account({ r, isNew: fresh, mark, onContact, note, onSaveNote, onOpen, onEmail }) {
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
            {r.turnover_gbp
              ? <Src href={r.turnover_url || r.accounts_url} title={r.turnover_source || "Open the accounts"}><b>{money(r.turnover_gbp)}</b> {r.turnover_basis === "group" ? "group " : ""}turnover</Src>
              : r.turnover_check && <span className="muted" title={r.turnover_check}>{/not disclosed/.test(r.turnover_check) ? "Turnover not disclosed" : "Turnover: check accounts"}</span>}
            {wallet(r) && <span><b>{wallet(r)}</b> FX a year</span>}
            <FxFigure r={r} />
          </div>
          <ContactedButton number={r.company_number} name={r.company_name} mark={mark} onContact={onContact} />
        </div>
      </div>
      <FxStrip r={r} />
      <ContactLine r={r} />
      {mark && <FollowUpPanel r={r} mark={mark} onContact={onContact} />}
      <Chips r={r} />
      <CallPrep r={r} />
      <Notes note={note} onSave={onSaveNote} />
      <div className="card-foot">
        <button className="more-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? "Less" : "More detail"}</button>
        {r.company_number && <a className="more-btn" href={companyPath(r.company_number)} onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onOpen(r.company_number); } }}>Open company page →</a>}
        <EmailButton r={r} onEmail={onEmail} />
      </div>
      {open && <Details rows={detailSections(r).flatMap(([, rows]) => rows)} />}
    </article>
  );
}

// One company: everything the finder knows, each fact linked to the filing or charge it came from, with notes and
// the Contacted button.
function CompanyPage({ r, number, madeAt, mark, onContact, note, onSaveNote, onBack, saveError, onEmail }) {
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
    ["Turnover", r.turnover_gbp ? money(r.turnover_gbp) : r.turnover_check, r.turnover_url || r.accounts_url,
     [r.turnover_basis && `${r.turnover_basis} figure`, r.turnover_period_end && `accounts to ${r.turnover_period_end}`,
      r.turnover_source].filter(Boolean).join(" · ")],
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
        <ContactedButton number={r.company_number} name={r.company_name} mark={mark} onContact={onContact} />
      </header>
      {mark && (
        <section className="panel">
          <h2 className="panel-h">Follow-up</h2>
          <FollowUpPanel r={r} mark={mark} onContact={onContact} />
        </section>
      )}

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

      {fxFacts(r).length > 0 && (
        <section className="panel">
          <h2 className="panel-h">FX in their accounts</h2>
          <FxStrip r={r} full />
        </section>
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

      <div className="card-foot"><EmailButton r={r} onEmail={onEmail} /></div>

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
.groups{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.groups-l{font-size:11px;font-weight:600;color:rgba(255,255,255,.35);text-transform:uppercase;letter-spacing:.06em;margin-right:4px}
.grp{padding:5px 11px;border-radius:14px;border:1px solid rgba(255,255,255,.1);background:none;color:rgba(255,255,255,.55);font:600 12px 'Inter',sans-serif;cursor:pointer}
.grp.on{background:rgba(56,189,248,.12);border-color:rgba(56,189,248,.35);color:#7DD3FC}
.contacted-tab{margin-left:8px}
.filings-tab{margin-left:4px}
.filings-bar{margin-bottom:10px}
.filings-months{margin-bottom:10px}
.estimate i{font-style:normal;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#FBBF24;margin-left:4px}
.filing-note{margin-top:8px;font-size:12px;color:rgba(255,255,255,.55)}
.filing-note.customs{color:#A5B4FC}
.filing-research{margin-top:8px;font-size:12.5px;color:rgba(255,255,255,.7);display:grid;gap:3px}
.filing-research .fxl{display:inline-block;min-width:68px}
.fx-mentions{margin-top:8px;font-size:12px;color:rgba(255,255,255,.6)}
.fx-mentions summary{cursor:pointer;color:rgba(255,255,255,.5)}
.fx-mentions ul{margin:6px 0 0;padding-left:18px}
.fx-mentions li{margin:3px 0;line-height:1.45}
.filings-note{font-size:12px;color:rgba(255,255,255,.45);margin:0 0 12px}
.new.group{background:rgba(165,180,252,.14);color:#A5B4FC}
.new.filed{background:rgba(56,189,248,.12);color:#7DD3FC}
.fxstrip{margin-top:10px;display:flex;gap:6px 14px;flex-wrap:wrap;align-items:baseline;padding:8px 10px;border-radius:9px;background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.14);font-size:12.5px}
.fxstrip.full{flex-direction:column;gap:10px;padding:12px 14px}
.fxscore{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;color:#A5B4FC;padding:2px 7px;border-radius:6px;background:rgba(99,102,241,.16);cursor:help}
.fxfact{color:#E2E8F0;min-width:0;overflow-wrap:anywhere}
.fxl{font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:rgba(165,180,252,.7);margin-right:6px}
.fxq{margin-top:3px;font-size:12px;color:rgba(255,255,255,.45);font-style:italic}
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
.person.ask{color:#A5B4FC}
.clues{flex-basis:100%;font-size:12.5px;color:rgba(255,255,255,.55)}
.due-n{margin-left:6px;font-size:10px;font-weight:800;padding:1px 6px;border-radius:9px;background:rgba(248,113,113,.18);color:#FCA5A5}
.channels{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.channels-l{font-size:11px;font-weight:600;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.05em}
.state{font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;padding:3px 8px;border-radius:10px;white-space:nowrap;background:rgba(165,180,252,.12);color:#A5B4FC}
.state.st-overdue{background:rgba(248,113,113,.16);color:#FCA5A5}
.state.st-due,.state.st-replied{background:rgba(245,158,11,.16);color:#FBBF24}
.state.st-booked{background:rgba(16,185,129,.16);color:#34D399}
.state.st-closed,.state.st-nurture{background:rgba(255,255,255,.06);color:rgba(255,255,255,.5)}
.follow{margin-top:10px;padding:10px 12px;border-radius:9px;background:rgba(165,180,252,.04);border:1px solid rgba(165,180,252,.14);display:flex;flex-direction:column;gap:8px}
.follow.st-overdue{border-color:rgba(248,113,113,.3)}
.follow.st-due,.follow.st-replied{border-color:rgba(245,158,11,.3)}
.panel .follow{margin-top:8px}
.follow-h{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px;color:rgba(255,255,255,.75)}
.follow-next b{color:#F8FAFC}
.follow-touches{font-size:12px;color:rgba(255,255,255,.45)}
.follow .angle{margin-top:0}
.follow-btns{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.btn-sm.on{background:rgba(16,185,129,.15);border-color:rgba(16,185,129,.4);color:#34D399}
.follow-date{display:flex;align-items:center;gap:6px;font-size:12px;color:rgba(255,255,255,.5);margin-left:6px}
.follow-date .input{padding:4px 8px;font-size:12px;color-scheme:dark}
.more-btn.undo{margin:0 0 0 auto}
.save-error{padding:10px 12px;border-radius:8px;background:rgba(248,113,113,.1);color:#FCA5A5;font-size:13px}
.when{margin-top:8px;font-size:12px;color:rgba(255,255,255,.4)}
.fact{margin-top:8px;font-size:12.5px;color:rgba(255,255,255,.75);padding-left:10px;border-left:2px solid rgba(251,191,36,.6)}
.email-go{color:#a5b4fc}
.status-strip{display:flex;flex-wrap:wrap;gap:6px 18px;padding:8px 40px;font-size:12px;color:rgba(255,255,255,.6);border-bottom:1px solid rgba(255,255,255,.06)}
.status-strip a{color:inherit;text-decoration:underline}
.st{display:inline-flex;align-items:center;gap:6px}
.st-dot{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.3)}
.st-ok .st-dot{background:#10B981}
.st-stale{color:#fbbf24}.st-stale .st-dot{background:#fbbf24}
.st-failed{color:#f87171;font-weight:600}.st-failed .st-dot{background:#f87171}
.st-info{color:rgba(255,255,255,.45)}
.stat-go{cursor:pointer;text-align:left;font:inherit;color:inherit;background:none;border:0}
.stat-go:hover{background:rgba(255,255,255,.03)}
.loss-contacted{margin-left:auto}
@media (max-width:640px){.status-strip{padding:8px 16px}}
.loss-fig{display:flex;flex-direction:column;align-items:flex-end;gap:2px;font-size:13px;text-align:right}
.loss-fig b{color:#f87171;font-size:16px}
.loss-facts{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:8px;font-size:13px;color:rgba(255,255,255,.75)}
.loss-facts em{color:rgba(255,255,255,.45)}
.email-btns{display:flex;gap:8px;flex-wrap:wrap}
.email-edit{width:100%;box-sizing:border-box;margin-top:10px;padding:12px;font:14px/1.55 inherit;font-family:inherit;resize:vertical;white-space:pre-wrap}
.email-gaps{margin-top:8px;font-size:12px;color:#fbbf24}
.email-basis{margin-top:4px;font-size:11px;color:rgba(255,255,255,.45)}
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
