import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { FILINGS_SECTION } from "./ranking.js";
import { FIT, SIMPLE_COLUMNS, NEW_LEAD_DAYS, addedOn, newLead, setKnownLei, setKnownOwnerSearch, setKnownParents, foreignOwned, elsewhere, keyPoints, ownership, OWNERSHIP_LABEL, financeSeat, ukNamed, timelyReason, filedIso, leadLine, setKnownSites, setKnownSignals, movesByCurrency, outreachPlan, outreachWhyLine, letterAddressee, OUTREACH, siteOf, setKnownGroups, groupOf, groupName, peBackedOf, industryOf, INDUSTRIES, collapseGroups, nicheTiers, withLeadScores, SHEET_COLUMNS, SIZE_SCALE, parseMoney, regionBars, sizePosition, turnoverYears, COGNISM_COLUMNS, COGNISM_COMPANY_COLUMNS, cognismCompanyRows, EXPORT_FIELDS, cognismRow, checklistLine, leadChecklist, reasonsNotToProgress, CALL_RULES, CALL_TODAY_MAX, callToday, companyAndFd, searchAllowance, statusLines, LOSS_SORTS, filterLosses, lossGrew, lossRows, sortLosses, CONTACT_GROUPS, ROLE_GROUPS, SORTS, askFor, chCompanyUrl, monthLabel, filedWhen, filingRow, filterFilings, sortFilings, isGroupFiling, turnoverSearch, fxFacts, fxGroup, fxScore, companyPath, contactClues, presentedContact, detailSections, numberFromPath, roleGroup, sourceDocuments, bankUrl, contactGroup, factUrl, filterRows, fxShare, googleFd, isNew, isOut, money, parts, sortRows, wallet } from "./format.js";
import { pitchFor, pitchLine } from "./pitch.js";
import { TEMPLATES, fillTemplate, stepTemplate } from "./templates.js";
import { GRID_COLUMNS, ROLES, SEQUENCE, START_PER_DAY, callScript, gridCells, nextStep, plan, sequenceRank, todayQueue } from "./sequence.js";
import { firstName } from "./email.js";
import { columnsFor, downloadSheet } from "./xlsx.js";
import { emailDraft } from "./email.js";
import { VERDICT_REASONS, applyEmail } from "../../api/accounts.mjs";
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
  // Every other lead we've scanned, ranked (leads/ranked: the Recent FX filings list's companies not on this list, and
  // the absurd ones — banks, funds, FX providers, dissolved — qualified Out on both).
  const [ranked, setRanked] = useState({ rows: [], ruled_out: {}, niches: [] });
  useEffect(() => {
    let live = true;
    fetch(`${API}?view=ranked`, { headers: { authorization: `Bearer ${password}` }, cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null)).then((body) => { if (live && body) { setKnownGroups(body.group_of); setKnownLei(body.gleif_of); setRanked(body); } }).catch(() => {});
    return () => { live = false; };
  }, [password]);
  const baseRows = useMemo(() => {
    const out = ranked.ruled_out || {};
    const onList = new Set((data.rows || []).map((r) => r.company_number));
    const relabel = ranked.niche_of || {};
    const listed = [...(data.rows || []).map((r) => (relabel[r.company_number] !== undefined ? { ...r, fx_niche: relabel[r.company_number] } : r))
      .map((r) => (out[r.company_number] && r.qualified !== "Out" ? { ...r, qualified: "Out", qualify_reason: out[r.company_number] } : r)),
      ...(ranked.rows || []).filter((r) => !onList.has(r.company_number))
        .map((r, i) => ({ ...filingRow(r), rank: 100000 + i, companies_house_url: chCompanyUrl(r.company_number) }))];
    const known = new Set(listed.map((r) => r.company_number));
    const dropped = Object.entries(contacted).filter(([n]) => !known.has(n)).map(([n, mark]) => ({
      company_number: n, company_name: mark.name || `Company ${n}`, rank: 99999, dropped: true,
      companies_house_url: `https://find-and-update.company-information.service.gov.uk/company/${n}`,
    }));
    return [...listed, ...dropped];
  }, [data.rows, contacted, ranked]);
  // The lead score's inputs: each measured niche's tier and each company's recent alerts (?view=signals).
  const [signals, setSignals] = useState({ niches: {}, signals: {} });
  useEffect(() => {
    let live = true;
    fetch(`${API}?view=signals`, { headers: { authorization: `Bearer ${password}` }, cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null)).then((body) => {
        if (live && body) { setKnownSites(body.websites); setKnownOwnerSearch(body.owners_search); setKnownParents(body.parents_of); setKnownSignals(body.signals); setSignals(body); }
      }).catch(() => {});
    return () => { live = false; };
  }, [password]);
  // The pound's moves (official ECB rates, /api/market — public): a company's own currency moving is a reason to call.
  const [moves, setMoves] = useState({});
  useEffect(() => {
    let live = true;
    fetch("/api/market", { cache: "no-store" }).then((res) => (res.ok ? res.json() : null))
      .then((body) => { if (live && body) setMoves(movesByCurrency(body)); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const leadCtx = useMemo(() => ({ niches: nicheTiers(signals.niches), signals: signals.signals || {}, moves, madeAt: data.made_at }),
                          [signals, moves, data.made_at]);
  // Zac's Good lead / Not a fit verdicts: declared before the rows that read them
  const [verdicts, setVerdicts] = useState(data.verdicts || {});
  const [lists, setLists] = useState(data.lists || {});   // Zac's call / chocolate-mailing / email lists
  const allRows = useMemo(() => withLeadScores(baseRows.map((r) => (verdicts[r.company_number]?.verdict === "not_fit"
    ? { ...r, qualified: "Out", qualify_reason: `Not a fit: ${verdicts[r.company_number].reason || "your review"}` } : r)), leadCtx),
  [baseRows, leadCtx, verdicts]);
  // Companies with "UK" in the name live in their own tab only (contacted ones stay in Contacted).
  const ukRows = useMemo(() => allRows.filter(ukNamed), [allRows]);
  // Owned from abroad (an American parent, a German group …): their own tab too (Zac, 16 Nov 2026: "if it's owned by an
  // American company or something like that put it in a different section"); `signals` brings the owner search's answers
  const foreignRows = useMemo(() => allRows.filter((r) => !ukNamed(r) && foreignOwned(r)), [allRows, signals]);
  const rows = useMemo(() => allRows.filter((r) => !elsewhere(r) || contacted[r.company_number]), [allRows, contacted, signals]);
  const [filters, setFilters] = useState({ section: "", view: "", query: "", contact: "", role: "", fdOnly: false, pair: "",
                                            triggersOnly: false, showOut: false, newOnly: false, fxLossOnly: false, oneGroup: true,
                                            peOnly: false, newFdOnly: false, industry: "", ownership: "", lookalikeOnly: false });
  const [sort, setSort] = useState("lead");
  // Sheet (a dense, sortable grid) or Cards; remembered in this browser
  const [layout, setLayout] = useState(() => { try { return localStorage.getItem("fx-layout") || "sheet"; } catch { return "sheet"; } });
  const pickLayout = (v) => { setLayout(v); try { localStorage.setItem("fx-layout", v); } catch { /* storage off */ } };
  const [shown, setShown] = useState(PAGE);
  const [notes, setNotes] = useState(data.notes || {});
  const [checks, setChecks] = useState(data.checks || {});
  const [saveError, setSaveError] = useState("");
  const set = (patch) => { setFilters((f) => ({ ...f, ...patch })); setShown(PAGE); };
  // When the Alerts tab was last opened (this browser): the banner counts hot alerts newer than that.
  const [alertsSeen, setAlertsSeen] = useState(() => { try { return localStorage.getItem("fx-alerts-seen") || ""; } catch { return ""; } });
  useEffect(() => {
    if (filters.view !== "alerts") return;
    const now = new Date().toISOString().slice(0, 19);
    try { localStorage.setItem("fx-alerts-seen", now); } catch { /* private window */ }
    setAlertsSeen(now);
  }, [filters.view]);   // eslint-disable-line react-hooks/exhaustive-deps

  // A company's own page at /accounts/<number>; the browser's back button returns to the list where it was.
  const [pageNo, setPageNo] = useState(() => numberFromPath(window.location.pathname));
  const [listScroll, setListScroll] = useState(0);
  useEffect(() => {
    const onPop = () => setPageNo(numberFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  // The company page's long text (quoted evidence, wallet basis, directors…): kept apart from the list, loaded when opened
  const [details, setDetails] = useState({});
  useEffect(() => {
    if (!pageNo || details[pageNo]) return undefined;
    let live = true;
    fetch(`${API}?view=details&company=${encodeURIComponent(pageNo)}`, { headers: { authorization: `Bearer ${password}` }, cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => { if (live && body) setDetails((d) => ({ ...d, [pageNo]: body.details || {} })); }).catch(() => {});
    return () => { live = false; };
  }, [pageNo, password]);   // eslint-disable-line react-hooks/exhaustive-deps
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
      if (body.checks) setChecks(body.checks);
      if (body.emails) setEmails(body.emails);
      if (body.lists) setLists(body.lists);
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

  // The lead checklist's "CRM checked" tick: shown at once, undone if the save fails.
  const setCrm = useCallback(async (number, value) => {
    setSaveError("");
    const before = checks;
    setChecks((c) => { const next = { ...c }; if (value) next[number] = { crm: new Date().toISOString() }; else delete next[number]; return next; });
    try { await save(number, { crm_checked: value }); } catch (e) {
      setChecks(before);
      setSaveError(`Couldn't save the CRM tick (${e.message}).`);
    }
  }, [save, checks]);

  // Zac's review of a lead (Good lead / Not a fit + reason): shown at once, undone if the save fails. Not a fit drops it
  // from every list like "qualified Out"; the daily ranking measures each source and niche against these.
  const setVerdict = useCallback(async (number, verdict, reason = "") => {
    setSaveError("");
    const before = verdicts;
    setVerdicts((v) => { const next = { ...v }; if (verdict) next[number] = { verdict, ...(reason ? { reason } : {}), at: new Date().toISOString() }; else delete next[number]; return next; });
    try { await save(number, { verdict: verdict || null, ...(reason ? { reason } : {}) }); } catch (e) {
      setVerdicts(before);
      setSaveError(`Couldn't save the verdict (${e.message}).`);
    }
  }, [save, verdicts]);
  const setList = useCallback(async (number, list, missing = false) => {
    setSaveError("");
    const before = lists;
    setLists((l) => {
      const next = { ...l };
      if (list) next[number] = { list, at: l[number]?.list === list ? l[number].at : new Date().toISOString(), ...(missing ? { missing: true } : {}) };
      else delete next[number];
      return next;
    });
    try { await save(number, { list: list || null, ...(missing ? { missing: true } : {}) }); } catch (e) {
      setLists(before);
      setSaveError(`Couldn't save the list (${e.message}).`);
    }
  }, [save, lists]);
  const setSequence = useCallback(async (number, seq) => {
    setSaveError("");
    const before = lists;
    setLists((l) => (l[number] ? { ...l, [number]: seq ? { ...l[number], seq } : (({ seq: _s, ...rest }) => rest)(l[number]) } : l));
    try { await save(number, { sequence: seq }); } catch (e) {
      setLists(before);
      setSaveError(`Couldn't save the sequence (${e.message}).`);
    }
  }, [save, lists]);
  const todayDue = useMemo(() => { const q = todayQueue(allRows, lists, { perDay: 0 }); return q.calls.length + q.emails.length + q.linkedin.length; }, [allRows, lists]);
  const verdictCtx = useMemo(() => ({ verdicts, setVerdict, lists, setList, setSequence, moves }), [verdicts, setVerdict, lists, setList, setSequence, moves]);

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
    if (filters.view === "contacted") return sortFollowUps(matched, contacted);
    const sorted = sortRows(matched, sort);
    return filters.oneGroup ? collapseGroups(sorted) : sorted;   // one row per group, its best lead standing for it
  }, [rows, filters, sort, contacted, notes, data.made_at, ranked]);   // eslint-disable-line react-hooks/exhaustive-deps
  const open = rows.filter((r) => !contacted[r.company_number]);
  const listedNumbers = useMemo(() => new Set(allRows.filter((r) => !r.dropped).map((r) => r.company_number)), [allRows]);
  const groupCounts = useMemo(() => {
    const base = filterRows(rows, { ...ctx, contact: "" });
    return Object.fromEntries(["", ...CONTACT_GROUPS].map((g) => [g, g ? base.filter((r) => contactGroup(r) === g).length : base.length]));
  }, [rows, filters, contacted, data.made_at]);   // eslint-disable-line react-hooks/exhaustive-deps
  const roleCounts = useMemo(() => {
    const base = filterRows(rows, { ...ctx, role: "" });
    return Object.fromEntries(ROLE_GROUPS.map((g) => [g, base.filter((r) => roleGroup(r) === g).length]));
  }, [rows, filters, contacted, notes, data.made_at]);   // eslint-disable-line react-hooks/exhaustive-deps
  const ownCounts = useMemo(() => {
    const counts = {};
    for (const r of filterRows(rows, { ...ctx, ownership: "" })) { const k = ownership(r).status; counts[k] = (counts[k] || 0) + 1; }
    return counts;
  }, [rows, filters, contacted, notes, data.made_at]);   // eslint-disable-line react-hooks/exhaustive-deps
  const industryCounts = useMemo(() => {
    const counts = {};
    for (const r of filterRows(rows, { ...ctx, industry: "" })) counts[industryOf(r)] = (counts[industryOf(r)] || 0) + 1;
    return counts;
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
    const out = visible.map((r) => ({ ...r, company_and_fd: companyAndFd(r), industry: industryOf(r), finance_decided: financeSeat(r).verdict, ...(() => { const o = ownership(r); return { ownership: OWNERSHIP_LABEL[o.status], ultimate_owner: o.owner, owner_country: o.country }; })(), what_to_pitch: pitchLine(r), my_list: LIST_NAMES[lists[r.company_number]?.list] || "",
      lead_checklist: checklistLine(leadChecklist(r, checks)), reasons_not_to_progress: reasonsNotToProgress(r).map((x) => x.text).join(" | "), notes: notes[r.company_number]?.text || "", email_draft: emailDraft(r).text }));
    downloadSheet(out, columnsFor(EXPORT_FIELDS, { company_and_fd: "Company – Finance Director" }, NUMBER_FIELDS), `fx-accounts-${new Date().toISOString().slice(0, 10)}.xlsx`, "Accounts");
  };

  if (pageNo) {
    const found = allRows.find((x) => x.company_number === pageNo);
    const r = found && details[pageNo] ? { ...found, ...details[pageNo] } : found;
    return (
      <VerdictContext.Provider value={verdictCtx}>
      <CompanyPage r={r} number={pageNo} madeAt={data.made_at} mark={contacted[pageNo]} onContact={contact}
                   note={notes[pageNo]} onSaveNote={(text) => saveNote(pageNo, text)} onBack={backToList} saveError={saveError} onEmail={toEmail}
                   checks={checks} onCrm={setCrm} />
      </VerdictContext.Provider>
    );
  }

  return (
    <VerdictContext.Provider value={verdictCtx}>
    <main>
      <StatusStrip status={data.status} />
      <AlertBanner summary={signals.alerts_summary} seen={alertsSeen} onOpen={() => set({ section: "", view: "alerts" })} />
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
          <button role="tab" aria-selected={filters.view === "outreach"} className={`tab outreach-tab${filters.view === "outreach" ? " on" : ""}`}
                  title={`The top ${OUTREACH.letters} for the Investec letter, then the rest: cold call (something timely to say) or email sequence`}
                  onClick={() => set({ section: "", view: "outreach" })}>
            Outreach <span className="tab-n">{OUTREACH.letters}</span>
          </button>
          <button role="tab" aria-selected={filters.view === "alerts"} className={`tab alerts-tab${filters.view === "alerts" ? " on" : ""}`}
                  title="New finance directors, refinancing, new owners, charges to FX providers — from Companies House, every 3 hours"
                  onClick={() => set({ section: "", view: "alerts" })}>
            Alerts
          </button>
          <button role="tab" aria-selected={filters.view === "hits"} className={`tab hits-tab${filters.view === "hits" ? " on" : ""}`}
                  title="Filed lately with an FX loss — and a new finance director, buying companies or a private-equity deal"
                  onClick={() => set({ section: "", view: "hits" })}>
            Hit list <span className="tab-n">{open.filter((r) => r.lead_flags?.hit && !isOut(r)).length}</span>
          </button>
          <button role="tab" aria-selected={filters.view === "today"} className={`tab${filters.view === "today" ? " on" : ""}`}
                  title="The day's sequence work across your lists: calls, emails, LinkedIn, and the companies to start today"
                  onClick={() => set({ section: "", view: "today" })}>
            Today <span className="tab-n">{todayDue}</span>
          </button>
          {Object.entries(LIST_NAMES).map(([key, name]) => (
            <button key={key} role="tab" aria-selected={filters.view === `list-${key}`} className={`tab${filters.view === `list-${key}` ? " on" : ""}`}
                    title={`Your ${name.toLowerCase()} — sent here from any card's “+ ${name}” button`}
                    onClick={() => set({ section: "", view: `list-${key}` })}>
              {name} <span className="tab-n">{Object.values(lists).filter((v) => v.list === key).length}</span>
            </button>
          ))}
          <button role="tab" aria-selected={filters.view === "simple"} className={`tab${filters.view === "simple" ? " on" : ""}`}
                  title="The same leads as a plain P&L-style sheet: company, Companies House number, type of company and the filed figures"
                  onClick={() => set({ section: "", view: "simple" })}>
            Simplified dash
          </button>
          <button role="tab" aria-selected={filters.view === "new"} className={`tab${filters.view === "new" ? " on" : ""}`}
                  title="Companies that joined the lists in the last 7 days (the finder's new finds and fresh FX filings), best lead score first"
                  onClick={() => set({ section: "", view: "new" })}>
            New leads <span className="tab-n">{rows.filter((r) => !contacted[r.company_number] && !isOut(r) && newLead(r, 7)).length}</span>
          </button>
          <button role="tab" aria-selected={filters.view === "foreign"} className={`tab${filters.view === "foreign" ? " on" : ""}`}
                  title="Owned by a company or person abroad (the accounts, the LEI register, Companies House or the owner search say so) — kept here, out of every other list"
                  onClick={() => set({ section: "", view: "foreign" })}>
            Foreign-owned <span className="tab-n">{foreignRows.filter((r) => !contacted[r.company_number] && !isOut(r)).length}</span>
          </button>
          <button role="tab" aria-selected={filters.view === "uk"} className={`tab${filters.view === "uk" ? " on" : ""}`}
                  title="Companies with “UK” in their name — usually a foreign group's UK arm; kept here, out of every other list"
                  onClick={() => set({ section: "", view: "uk" })}>
            UK in name <span className="tab-n">{ukRows.filter((r) => !contacted[r.company_number] && !isOut(r)).length}</span>
          </button>
          <button role="tab" aria-selected={filters.view === "fit"} className={`tab${filters.view === "fit" ? " on" : ""}`}
                  title={`The right companies, whatever the news: FX proof and FX pain, £20m–£300m, a good niche, ownership — Fit ${FIT.min}+, best first`}
                  onClick={() => set({ section: "", view: "fit" })}>
            Best fit <span className="tab-n">{open.filter((r) => (r.lead_fit || 0) >= FIT.min && !isOut(r)).length}</span>
          </button>
          <button role="tab" aria-selected={filters.view === "now"} className={`tab${filters.view === "now" ? " on" : ""}`}
                  title={`Companies that fit (Fit ${FIT.min}+) with a reason to call now — a new FD, a deal, funding, a fresh filing, a customs or bank change — most timely first`}
                  onClick={() => set({ section: "", view: "now" })}>
            Call now <span className="tab-n">{open.filter((r) => (r.lead_fit || 0) >= FIT.min && (r.lead_timing || 0) > 0 && !isOut(r)).length}</span>
          </button>
          <button role="tab" aria-selected={filters.view === "shy"} className={`tab${filters.view === "shy" ? " on" : ""}`}
                  title="Sectors payment firms often won't take — scrap, bullion, mining, waste, fuel, vehicles, tobacco… where a bank can win"
                  onClick={() => set({ section: "", view: "shy" })}>
            Hard to broker <span className="tab-n">{open.filter((r) => ranked.shy_of?.[r.company_number] && !isOut(r)).length}</span>
          </button>
          <button role="tab" aria-selected={filters.view === "money"} className={`tab money-tab${filters.view === "money" ? " on" : ""}`}
                  title="Just bought by private equity, buying companies, just funded, a new overseas owner"
                  onClick={() => set({ section: "", view: "money" })}>
            New money
          </button>
          <button role="tab" aria-selected={filters.view === "calls"} className={`tab calls-tab${filters.view === "calls" ? " on" : ""}`}
                  title={`Today's ${CALL_TODAY_MAX}: £20m–£300m, strong FX proof, a recent FX loss or a trigger — confirmed contacts first`}
                  onClick={() => set({ section: "", view: "calls" })}>
            Call today
          </button>
          {["", ...(data.sections || []), ...(ranked.rows?.length ? [FILINGS_SECTION] : [])].map((s) => {
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
          <button role="tab" aria-selected={filters.view === "niches"} className={`tab niches-tab${filters.view === "niches" ? " on" : ""}`}
                  title="Which niches prove FX most often, and how their leads score" onClick={() => set({ section: "", view: "niches" })}>
            Niches
          </button>
          <button role="tab" aria-selected={filters.view === "email"} className={`tab email-tab${filters.view === "email" ? " on" : ""}`}
                  title="The Investec email for each company you send here" onClick={() => set({ section: "", view: "email" })}>
            Email generator <span className="tab-n">{emailItems.length}</span>
          </button>
        </div>
        {!["filings", "email", "losses", "calls", "alerts", "niches", "hits", "money", "shy", "outreach", "fit", "now", "uk", "foreign", "today", "new", "simple"].includes(filters.view) && !filters.view?.startsWith("list-") && <>
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
          <select className="input" value={filters.industry} onChange={(e) => set({ industry: e.target.value })} aria-label="Industry">
            <option value="">Any industry</option>
            {INDUSTRIES.filter((g) => industryCounts[g]).sort((a, b) => industryCounts[b] - industryCounts[a])
              .map((g) => <option key={g} value={g}>{g} ({industryCounts[g]})</option>)}
          </select>
          <select className="input" value={filters.ownership} onChange={(e) => set({ ownership: e.target.value })} aria-label="Ownership"
                  title="Who owns it at the top: the accounts' ultimate parent, else the register's chain of owners">
            <option value="">Any owner</option>
            {Object.entries(OWNERSHIP_LABEL).map(([k, label]) => <option key={k} value={k}>{label} ({ownCounts[k] || 0})</option>)}
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
          <label className="check" title="Like Global Charter, the best lead so far: UK-owned, £20m–£100m, an FX loss of £50k+, no hedging named, still growing"><input type="checkbox" checked={filters.lookalikeOnly} onChange={(e) => set({ lookalikeOnly: e.target.checked })} /> Like Global Charter</label>
          <label className="check" title="A private-equity owner anywhere up the chain, a PE house or fund named in the accounts, or buyout-style debt"><input type="checkbox" checked={filters.peOnly} onChange={(e) => set({ peOnly: e.target.checked })} /> PE-backed</label>
          <label className="check" title="A new finance director: appointed (accounts, alerts, news) or being hired (job adverts)"><input type="checkbox" checked={filters.newFdOnly} onChange={(e) => set({ newFdOnly: e.target.checked })} /> New FD</label>
          <label className="check"><input type="checkbox" checked={filters.showOut} onChange={(e) => set({ showOut: e.target.checked })} /> Show qualified out ({rows.filter(isOut).length})</label>
          <label className="check" title="Companies in the same group (one top UK parent) shown once, as the group's best lead"><input type="checkbox" checked={filters.oneGroup} onChange={(e) => set({ oneGroup: e.target.checked })} /> One per group</label>
          <div className="seg" role="group" aria-label="Layout">
            {[["sheet", "Sheet"], ["cards", "Cards"]].map(([v, label]) => (
              <button key={v} aria-pressed={layout === v} className={layout === v ? "on" : ""} onClick={() => pickLayout(v)}>{label}</button>
            ))}
          </div>
          <button className="btn-sm export" onClick={exportCsv} disabled={!visible.length}>Export Excel ({visible.length})</button>
          <button className="btn-sm" onClick={() => downloadCognism(visible, "accounts")} disabled={!visible.length}
                  title="Company, domain, postcode and the finance contact's first / last name — the columns Cognism matches on">Export for Cognism</button>
          <button className="btn-sm" onClick={() => downloadCognismCompanies(visible, "accounts")} disabled={!cognismCompanyRows(visible).length}
                  title="Only companies with a confirmed website, one row each — upload as a company list in Cognism, then search people by job title">
            Cognism company list ({cognismCompanyRows(visible).length})</button>
        </div>
        </>}
      </div>

      {filters.view === "outreach" ? <Outreach rows={rows} contacted={contacted} password={password} onOpen={openCompany} onContact={contact} onEmail={toEmail} />
       : filters.view === "hits" ? <HitList rows={open} onOpen={openCompany} onContact={contact} onEmail={toEmail} />
       : filters.view?.startsWith("list-") ? <MyLists which={filters.view.slice(5)} rows={allRows} lists={lists} onOpen={openCompany} onContact={contact} onEmail={toEmail} />
       : filters.view === "today" ? <Today rows={allRows} lists={lists} onOpen={openCompany} />
       : filters.view === "simple" ? <SimpleDash rows={rows} onOpen={openCompany} contacted={contacted} />
       : filters.view === "new" ? <FitTiming mode="new" rows={rows.filter((r) => !contacted[r.company_number])} onOpen={openCompany} onContact={contact} onEmail={toEmail} />
       : filters.view === "foreign" ? <FitTiming mode="foreign" rows={foreignRows.filter((r) => !contacted[r.company_number])} onOpen={openCompany} onContact={contact} onEmail={toEmail} />
       : filters.view === "uk" ? <FitTiming mode="uk" rows={ukRows.filter((r) => !contacted[r.company_number])} onOpen={openCompany} onContact={contact} onEmail={toEmail} />
       : filters.view === "fit" || filters.view === "now" ? <FitTiming mode={filters.view} rows={open} onOpen={openCompany} onContact={contact} onEmail={toEmail} />
       : filters.view === "shy" ? <HardToBroker rows={open} shyOf={ranked.shy_of || {}} onOpen={openCompany} onContact={contact} onEmail={toEmail} />
       : filters.view === "money" ? <NewMoney password={password} listed={listedNumbers} onOpen={openCompany} rows={rows} />
       : filters.view === "alerts" ? <Alerts password={password} listed={listedNumbers} onOpen={openCompany} />
       : filters.view === "calls" ? <CallToday password={password} listRows={open} lead={leadCtx} contacted={contacted} onContact={contact} onOpen={openCompany} onEmail={toEmail}
                                             checks={checks} onCrm={setCrm} />
       : filters.view === "losses" ? <FxLosses password={password} listRows={rows} contacted={contacted} onContact={contact} onOpen={openCompany} onEmail={toEmail} />
       : filters.view === "niches" ? <Niches measured={signals.niches || {}} madeAt={signals.niches_made_at} learned={ranked.niches || []} verdicts={ranked.verdicts}
                                             headings={signals.headings || []} onPick={(name) => set({ section: "", view: "", query: name })} />
       : filters.view === "email" ? <EmailGenerator items={emailItems} onChange={editEmail} onRemove={removeEmail} onOpen={openCompany} />
       : filters.view === "filings" ? <Filings password={password} listed={listedNumbers} onOpen={openCompany} onEmail={toEmail} /> : (
      <div className="list">
        {saveError && <div className="save-error" role="alert">{saveError}</div>}
        {layout === "sheet" && visible.length > 0 && (
          <SheetView rows={visible.slice(0, shown)} onOpen={openCompany} contacted={contacted} />
        )}
        {layout !== "sheet" && visible.slice(0, shown).map((r, i, list) => {
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
    </VerdictContext.Provider>
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
  const [band, setBand] = useState(false);
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
  const all = (data?.rows || monthRows[month] || []).filter((r) => !elsewhere(r));   // data.rows: the first, single-item version; "UK" names have their own tab
  const rows = useMemo(() => sortFilings(filterFilings(all, { query, strongOnly, lossOnly, movedOnly, band }), order),
                       [all, query, strongOnly, lossOnly, movedOnly, band, order]);
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
        <button className={`btn-sm${band ? " on" : ""}`} aria-pressed={band} onClick={() => { setBand(!band); setShown(PAGE); }}
                title="Only companies whose filed (or group) turnover is £20m–£300m — the desk's sweet spot">
          £20m–£300m only</button>
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
      <KeyPoints r={filingRow(r)} />
      <details className="more-detail"><summary>More detail</summary>
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
      </details>
      <div className="card-foot"><EmailButton r={filingRow(r)} onEmail={onEmail} /></div>
    </article>
  );
}

// The card's four key points (keyPoints in format.js): why now, FX, who decides, what to pitch — plus the score.
function KeyPoints({ r }) {
  const points = keyPoints(r, pitchLine(r).split(" · ").slice(0, 2).join(" · "));
  return (
    <ul className="key-points">
      {points.map(([label, text, href]) => <li key={label}><span className="kp-l">{label}</span>
        <span>{text}{href && <> <a href={href} target="_blank" rel="noreferrer" title="Google: who owns it?">Who owns it? ↗</a></>}</span></li>)}
      {r.lead_score !== undefined && <li><span className="kp-l">Score</span>{r.lead_score}{r.lead_fit !== undefined ? ` · Fit ${r.lead_fit} · Now ${r.lead_timing}` : ""}</li>}
    </ul>
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
      <span className="chip" title={`Sector code ${(r.sic || r.sic_codes || "").toString() || "not known"}`}>{industryOf(r)}</span>
      {peBackedOf(r) && <span className="chip warn" title={peBackedOf(r).why}>PE-backed: {peBackedOf(r).name}</span>}
      {(() => { const seat = financeSeat(r); return seat.lean !== "uk-owned" && <span className={`chip${seat.lean === "abroad" ? " warn" : ""}`} title={seat.signs.map((x) => x.text).join("\n")}>{seat.verdict}</span>; })()}
      {r.lead_flags?.newFd && <span className="chip trig" title={r.lead_flags.fdWhy}>New FD</span>}
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
  const [band, setBand] = useState(false);
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
  const all = useMemo(() => lossRows(listRows.filter((r) => !contacted[r.company_number]), (filingLosses || []).filter((r) => !elsewhere(r))), [listRows, contacted, filingLosses]);
  const rows = useMemo(() => sortLosses(filterLosses(all, { min, query, recentDays: recent ? 183 : 0, unhedged, grew, band }), order),
                       [all, min, query, recent, unhedged, grew, band, order]);
  const reset = (fn) => (v) => { fn(v); setShown(PAGE); };
  if (filingLosses === null) return <div className="list"><div className="empty">Loading FX losses…</div></div>;
  return (
    <div className="list">
      {error && <div className="save-error" role="alert">Recent FX filings' losses couldn't load ({error}); showing your Accounts list's only.</div>}
      <div className="filters filings-bar">
        <input className="input search" placeholder="Search company, contact, currency, bank…" value={query}
               onChange={(e) => reset(setQuery)(e.target.value)} aria-label="Search FX losses" />
        <button className={`btn-sm${band ? " on" : ""}`} aria-pressed={band} onClick={() => reset(setBand)(!band)}
                title="Only companies whose filed (or group) turnover is £20m–£300m — the desk's sweet spot">
          £20m–£300m only</button>
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
        <button className="btn-sm export" onClick={() => exportLosses(rows)} disabled={!rows.length}>Export Excel ({rows.length})</button>
        <button className="btn-sm" onClick={() => downloadCognism(rows, "fx-losses")} disabled={!rows.length}>Export for Cognism</button>
        <button className="btn-sm" onClick={() => downloadCognismCompanies(rows, "fx-losses")} disabled={!cognismCompanyRows(rows).length}>Cognism company list ({cognismCompanyRows(rows).length})</button>
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
const LOSS_EXPORT = ["company_and_fd", "reasons_not_to_progress", "company_name", "company_number", "on_list", "fx_loss_gbp", "fx_prior_gbp", "share_of_turnover", "turnover_gbp",
  "filed", "hedging", "currency", "turnover_regions", "incumbent_bank", "finance_contact", "finance_contact_role",
  "finance_contact_confidence", "accounts_url", "email_draft"];
function exportLosses(rows) {
  const out = rows.map((r) => ({
    company_and_fd: companyAndFd(r), reasons_not_to_progress: reasonsNotToProgress(r).map((x) => x.text).join(" | "),
    company_name: r.company_name, company_number: r.company_number, on_list: r.onList ? "yes" : "",
    fx_loss_gbp: Math.round(r.loss), fx_prior_gbp: r.prior ?? "", share_of_turnover: r.share !== null ? `${(r.share * 100).toFixed(1)}%` : "",
    turnover_gbp: r.turnover_gbp || "", filed: r.filedOn, hedging: r.fx_forwards || r.fx_today || "none named in the accounts",
    currency: r.currencies_in_accounts || r.main_currency || "", turnover_regions: r.turnover_regions || "",
    incumbent_bank: (r.incumbent_bank || "").split(":")[0], finance_contact: r.finance_contact || "",
    finance_contact_role: r.finance_contact_role || "", finance_contact_confidence: r.finance_contact_confidence || "",
    accounts_url: r.fx_gain_loss_url || r.accounts_url || "", email_draft: emailDraft(r).text,
  }));
  downloadSheet(out, columnsFor(LOSS_EXPORT, { company_and_fd: "Company – Finance Director", fx_loss_gbp: "FX loss (£)", fx_prior_gbp: "Prior year (£)", turnover_gbp: "Turnover (£)" }, NUMBER_FIELDS),
                `fx-losses-${new Date().toISOString().slice(0, 10)}.xlsx`, "FX losses");
}

// The list as a sheet: a dense grid, sticky header and company column, row numbers, click a header to sort (again
// to reverse), click a company to open its page. The same rows and filters as the cards.
function SheetView({ rows, onOpen, contacted, columns = SHEET_COLUMNS }) {
  const [by, setBy] = useState("");
  const [desc, setDesc] = useState(false);
  const sorted = useMemo(() => {
    if (!by) return rows;
    const col = columns.find(([k]) => k === by);
    const key = col[3];
    const out = [...rows].sort((a, b) => { const x = key(a), y = key(b); return x < y ? -1 : x > y ? 1 : 0; });
    return desc ? out.reverse() : out;
  }, [rows, by, desc, columns]);
  const sortBy = (k) => { if (by === k) setDesc(!desc); else { setBy(k); setDesc(false); } };
  const open = (n) => (e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onOpen(n); } };
  return (
    <div className="sheet-wrap">
      <table className="sheet">
        <thead>
          <tr>
            <th className="rownum" aria-label="Row" />
            {columns.map(([k, header, , , num]) => (
              <th key={k} className={`${num ? "num" : ""}${k === "company" ? " sticky-col" : ""}`} aria-sort={by === k ? (desc ? "descending" : "ascending") : "none"}>
                <button onClick={() => sortBy(k)}>{header}{by === k ? (desc ? " ▾" : " ▴") : ""}</button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={r.company_number || i} className={contacted[r.company_number] ? "done" : ""}>
              <td className="rownum">{i + 1}</td>
              {columns.map(([k, , value, , num]) => {
                const v = value(r);
                return k === "company"
                  ? <td key={k} className="sticky-col"><a href={companyPath(r.company_number)} onClick={open(r.company_number)}>{v}</a></td>
                  : <td key={k} className={`${num ? "num" : ""}${(k === "fxloss" || k === "fx") && Number(r.fx_gain_loss_gbp) < 0 ? " neg" : ""}${(k === "fxloss" || k === "fx") && Number(r.fx_gain_loss_gbp) > 0 ? " pos" : ""}`}
                        title={typeof v === "string" && v.length > 28 ? v : undefined}>{v}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The Simplified dash: the Accounts list's own leads (not contacted, not out — the same filtering, nothing re-scored)
// as a P&L-style sheet with a search, an industry filter and an Excel export of exactly what's shown.
function SimpleDash({ rows, onOpen, contacted }) {
  const [query, setQuery] = useState("");
  const [industry, setIndustry] = useState("");
  const base = useMemo(() => rows.filter((r) => !contacted[r.company_number] && !isOut(r) && !r.dropped)
    .sort((a, b) => (b.lead_score || 0) - (a.lead_score || 0)), [rows, contacted]);
  const counts = {};
  for (const r of base) { const k = industryOf(r); counts[k] = (counts[k] || 0) + 1; }
  const q = query.trim().toLowerCase();
  const list = base.filter((r) => (!industry || industryOf(r) === industry)
    && (!q || `${r.company_name} ${r.company_number}`.toLowerCase().includes(q)));
  const exportList = () => downloadSheet(list.map((r) => Object.fromEntries(SIMPLE_COLUMNS.map(([k, , , , , out]) => [k, out(r)]))),
    SIMPLE_COLUMNS.map(([k, header, , , numeric]) => ({ key: k, header, number: Boolean(numeric) && !["growth", "margin"].includes(k) })),
    `simplified-dash-${new Date().toISOString().slice(0, 10)}.xlsx`, "Simplified dash");
  return (
    <div className="list">
      <div className="filters filings-bar">
        <input type="search" placeholder="Search company or number" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search" />
        <select value={industry} onChange={(e) => setIndustry(e.target.value)} aria-label="Type of company">
          <option value="">Any type of company ({base.length})</option>
          {Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => <option key={k} value={k}>{k} ({n})</option>)}
        </select>
        <span className="muted">{list.length} companies · figures from their latest filed accounts · click a header to sort</span>
        <button className="btn-sm export" onClick={exportList} disabled={!list.length}>Export Excel ({list.length})</button>
      </div>
      <SheetView rows={list} onOpen={onOpen} contacted={contacted} columns={SIMPLE_COLUMNS} />
    </div>
  );
}

// Zint-style figures on the company page: where its size sits against the desk's band, turnover this year v last,
// sales by region, the FX gain/loss this year v last, and the balance sheet. Plain SVG; every bar labelled and
// titled (hover) — one series each, so no legend; gains and losses on the diverging pair (blue / red).
const fmtShort = (n) => money(n);
function SizeBar({ r }) {
  const value = Number(r.turnover_gbp) || Number(r.turnover_foreign_gbp) || 0;
  const x = sizePosition(value);
  const [lo, hi] = [sizePosition(20e6), sizePosition(300e6)];
  const ticks = [1e6, 1e7, 1e8, 1e9];
  return (
    <figure className="viz">
      <figcaption>Company size <span>turnover on a £1m–£1bn scale · shaded: the desk's £20m–£300m band</span></figcaption>
      <svg viewBox="0 0 400 54" className="viz-svg" role="img" aria-label={`Turnover ${money(value)} against the £20m–£300m band`}>
        <rect x="0" y="18" width="400" height="10" rx="5" className="track" />
        <rect x={lo * 400} y="18" width={(hi - lo) * 400} height="10" className="band"><title>£20m–£300m: the desk's sweet spot</title></rect>
        {ticks.map((t) => <text key={t} x={sizePosition(t) * 400} y="46" className="tick" textAnchor={t === 1e6 ? "start" : t === 1e9 ? "end" : "middle"}>{money(t).replace(".0", "")}</text>)}
        {x !== null && <g><circle cx={x * 400} cy="23" r="7" className="marker"><title>{`${money(value)}${r.turnover_gbp ? "" : " (estimate)"}`}</title></circle>
          <text x={Math.min(Math.max(x * 400, 30), 370)} y="11" className="lbl" textAnchor="middle">{money(value)}{r.turnover_gbp ? "" : " est."}</text></g>}
      </svg>
    </figure>
  );
}

function Bars({ title, note, items, diverging = false }) {
  // items: [{label, value}] — horizontal bars from a shared zero
  const shown = items.filter((i) => Number.isFinite(i.value) && i.value !== 0);
  if (!shown.length) return null;
  const max = Math.max(...shown.map((i) => Math.abs(i.value)));
  const hasNeg = diverging && shown.some((i) => i.value < 0);
  const zero = hasNeg ? 240 : 110;   // gains and losses: a label column, then bars either side of zero
  const span = hasNeg ? 115 : 250;
  const rowH = 26;
  return (
    <figure className="viz">
      <figcaption>{title}{note && <span>{note}</span>}</figcaption>
      <svg viewBox={`0 0 400 ${shown.length * rowH + 6}`} className="viz-svg" role="img" aria-label={title}>
        {hasNeg && <line x1={zero} x2={zero} y1="0" y2={shown.length * rowH + 6} className="axis" />}
        {shown.map((i, n) => {
          const w = Math.max(2, (Math.abs(i.value) / max) * span);
          const y = n * rowH + 4;
          const neg = i.value < 0;
          const x = neg ? zero - w : zero;
          return (
            <g key={i.label}>
              <text x={hasNeg ? 4 : zero - 8} y={y + 13} className="cat" textAnchor={hasNeg ? "start" : "end"}>{i.label}</text>
              <rect x={x} y={y + 2} width={w} height="16" rx="4" className={diverging ? (neg ? "neg" : "pos") : "bar"}><title>{`${i.label}: ${neg ? "−" : ""}${fmtShort(Math.abs(i.value))}`}</title></rect>
              {/* a loss's figure sits just right of zero, clear of the labels */}
              <text x={neg ? zero + 6 : x + w + 6} y={y + 14} className="val" textAnchor="start">{neg ? "−" : ""}{fmtShort(Math.abs(i.value))}</text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

function FinanceCharts({ r }) {
  const years = turnoverYears(r);
  const regions = regionBars(r).slice(0, 6);
  const fx = Number(r.fx_gain_loss_gbp);
  const fxPrior = Number(r.fx_gain_loss_prior_gbp);
  const balance = [["Cash", Number(r.cash_gbp)], ["Bank borrowings", Number(r.bank_borrowings_gbp)], ["Net assets", Number(r.net_assets_gbp)]]
    .map(([label, value]) => ({ label, value }));
  return (
    <section className="panel viz-grid">
      <SizeBar r={r} />
      <Bars title="Turnover" note={years.growth !== null ? `${years.growth > 0 ? "+" : ""}${years.growth}% on last year` : "this year"}
            items={[{ label: "Last year", value: years.prior }, { label: "This year", value: years.now }]} />
      <Bars title="Sales by region" note="from the turnover note" items={regions.map((x) => ({ label: x.region, value: x.value }))} />
      <Bars title="FX gain / loss" note="blue gain · red loss" diverging
            items={[{ label: "Last year", value: Number.isFinite(fxPrior) ? fxPrior : 0 }, { label: "This year", value: Number.isFinite(fx) ? fx : 0 }]} />
      <Bars title="Balance sheet" note="latest accounts" items={balance} diverging />
    </section>
  );
}

// The Alerts tab: what changed at the companies on your lists (tools/ch_alerts.py, every 3 hours from Companies
// House's streaming feeds) — hot ones first — and new leads found by a charge to an FX provider or for trade finance.
const ALERT_FILTERS = [["", "All"], ["hot", "Hot"], ["new_fd", "New FD"], ["pe", "Private equity"], ["money", "Money in"], ["charges", "Banks & charges"],
  ["owners", "Owners & deals"], ["directors", "Directors"], ["customs", "Customs"], ["abroad", "Expanding abroad"], ["hiring", "Hiring"],
  ["trouble", "Hold off"]];
const ALERT_GROUPS = {
  money: /^(shares_allotted|articles_changed|funding_round|news_funding)$/, charges: /charge|bank_switch/,
  owners: /owner|auditor_changed|year_end_changed/, customs: /^(new_trader|new_import|new_export|trade_up)$/,
  trouble: /^(insolvency|petition)$/, directors: /director/, pe: /^(pe_buyout|news_pe|new_owner_pe|pe_debt)$/,
};
const alertMatches = (a, f) => !f || (f === "hot" ? a.hot : f === "new_fd" ? /^(new|news|hiring)_fd$/.test(a.kind)
  : f === "abroad" ? a.kind === "news_abroad" : f === "hiring" ? a.kind === "hiring" : ALERT_GROUPS[f]?.test(a.kind));
const alertSource = (a) => (/companieshouse|company-information/.test(a.url || "") ? "Companies House ↗"
  : /uktradeinfo/.test(a.url || "") ? "HMRC lists ↗" : /thegazette/.test(a.url || "") ? "The Gazette ↗"
  : /^hiring/.test(a.kind) ? "Job advert ↗" : /^news/.test(a.kind) ? "Article ↗" : "Source ↗");
function Alerts({ password, listed, onOpen }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [mineOnly, setMineOnly] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(`${API}?view=alerts`, { headers: { authorization: `Bearer ${password}` }, cache: "no-store" })
      .then(async (res) => { const body = await res.json().catch(() => ({})); if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`); return body; })
      .then((body) => { if (live) setData(body); })
      .catch((e) => { if (live) { setError(e.message); setData({ items: [], discoveries: [] }); } });
    return () => { live = false; };
  }, [password]);
  const items = useMemo(() => (data?.items || []).filter((a) => alertMatches(a, filter) && (!mineOnly || a.tracked))
    .sort((a, b) => (b.hot ? 1 : 0) - (a.hot ? 1 : 0) || String(b.at).localeCompare(String(a.at))), [data, filter, mineOnly]);
  if (!data) return <div className="list"><div className="empty">Loading alerts…</div></div>;
  const open = (a) => (e) => { if (listed.has(a.company_number) && e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onOpen(a.company_number); } };
  return (
    <div className="list">
      {error && <div className="save-error" role="alert">Alerts couldn't load ({error}).</div>}
      <div className="filters filings-bar">
        <div className="groups" role="group" aria-label="Alert kind">
          {ALERT_FILTERS.map(([k, label]) => (
            <button key={k || "all"} aria-pressed={filter === k} className={`grp${filter === k ? " on" : ""}`} onClick={() => setFilter(k)}>{label}</button>
          ))}
        </div>
        <label className="check"><input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} /> On my lists only</label>
        <span className="muted">{items.length} alerts{data.made_at ? ` · checked ${filedWhen(String(data.made_at).slice(0, 10))}` : ""}</span>
      </div>
      {(data.discoveries || []).length > 0 && (
        <p className="filings-note">New leads found: <b>{data.discoveries.length}</b> companies not on the lists — a charge to an FX
          provider or for trade finance, a new finance director or a move abroad in the news, a King's Award or UK Export Finance
          backing, or a treasury / FX / export job advert. The finder checks them (size, FX proof, finance contact) in its next run.</p>
      )}
      <div className="sheet-wrap">
        <table className="sheet alerts-sheet">
          <thead><tr><th>When</th><th>Alert</th><th>Company</th><th>Detail</th></tr></thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id} className={a.hot ? "hot" : ""}>
                <td className="num">{a.at ? filedWhen(String(a.at).slice(0, 10)) : ""}</td>
                <td><span className={`chip${a.hot ? " warn" : ALERT_GROUPS.trouble.test(a.kind) ? " out" : ""}`}>{a.title}</span></td>
                <td><a href={listed.has(a.company_number) ? companyPath(a.company_number) : a.url} onClick={open(a)}
                       target={listed.has(a.company_number) ? undefined : "_blank"} rel="noreferrer">{a.company_name || a.company_number}</a>
                  {!a.tracked && <span className="muted"> · new lead</span>}</td>
                <td>{a.detail} <a href={a.url} target="_blank" rel="noreferrer" className="muted">{alertSource(a)}</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!items.length && <div className="empty">No alerts yet — they arrive every 3 hours once the Companies House streaming key is set.</div>}
    </div>
  );
}

// The Call today tab: the day's shortlist (format.js callToday) across your Accounts list and the Recent FX filings
// list — each pick says why today, who to ask for, and links to its accounts. Contacted companies drop off.
function CallToday({ password, listRows, lead, contacted, onContact, onOpen, onEmail, checks, onCrm }) {
  const [filingRows, setFilingRows] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    fetch(`${API}?view=calls`, { headers: { authorization: `Bearer ${password}` }, cache: "no-store" })
      .then(async (res) => { const body = await res.json().catch(() => ({})); if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`); return body; })
      .then((body) => { if (live) setFilingRows(body.rows || []); })
      .catch((e) => { if (live) { setError(e.message === "Failed to fetch" ? "Couldn't reach the site — check your connection." : e.message); setFilingRows([]); } });
    return () => { live = false; };
  }, [password]);
  const rows = useMemo(() => callToday(listRows, (filingRows || []).filter((r) => !contacted[r.company_number]), { lead }),
                       [listRows, filingRows, contacted, lead]);
  if (filingRows === null) return <div className="list"><div className="empty">Picking today's calls…</div></div>;
  return (
    <div className="list">
      {error && <div className="save-error" role="alert">The Recent FX filings list couldn't load ({error}); today's picks are from your Accounts list only.</div>}
      <div className="filters filings-bar">
        <span className="muted">Today's {rows.length}: turnover £20m–£300m, filed FX proof {CALL_RULES.minScore}+, and an FX loss of
          £{CALL_RULES.minLoss / 1000}k+ filed in the last 6 months or a trigger. Highest lead score first. Mark one Contacted and the next moves up.</span>
        <button className="btn-sm export" onClick={() => exportCalls(rows, checks)} disabled={!rows.length}>Export Excel ({rows.length})</button>
        <button className="btn-sm" onClick={() => downloadCognism(rows, "call-today")} disabled={!rows.length}>Export for Cognism</button>
        <button className="btn-sm" onClick={() => downloadCognismCompanies(rows, "call-today")} disabled={!cognismCompanyRows(rows).length}>Cognism company list ({cognismCompanyRows(rows).length})</button>
      </div>
      {rows.map((r, i) => <CallCard key={r.company_number} r={r} n={i + 1} onOpen={onOpen} onEmail={onEmail} onContact={onContact} checks={checks} onCrm={onCrm} />)}
      {!rows.length && <div className="empty">Nothing meets today's rules — try the FX losses or Recent FX filings tabs.</div>}
    </div>
  );
}

// The Niches tab: each niche's measured FX hit rate (tools/niche_hits.py) beside how its leads score (leads/ranked) —
// which niches are worth the time. Clicking a niche searches the list for it.
// Your verdicts (Good lead / Not a fit), measured by the daily ranking: where good leads come from.
function VerdictLearnings({ v }) {
  if (!v?.reviewed) return <p className="filings-note">Mark leads "Good lead" or "Not a fit" as you review them: each morning's ranking measures which sources, niches and score bands give good leads.</p>;
  const table = (title, list) => list.length > 0 && (
    <div className="verdict-table"><b>{title}</b>
      {list.slice(0, 8).map((g) => <div key={g.key}><span className="num">{g.good_share}%</span> good ({g.good}/{g.reviewed}) · {g.key}</div>)}
    </div>);
  return (
    <div className="panel verdict-panel">
      <b>Your verdicts: {v.reviewed} leads reviewed</b>
      {Object.keys(v.reasons).length > 0 && <span className="muted"> — not a fit: {Object.entries(v.reasons).map(([k, n]) => `${k} ${n}`).join(", ")}</span>}
      <div className="verdict-tables">{table("By source", v.source)}{table("By lead score", v.band)}{table("By niche", v.niche)}{table("Hard to broker", v.sector)}</div>
    </div>
  );
}

function Niches({ measured, madeAt, learned, headings, onPick, verdicts }) {
  const [by, setBy] = useState("score");
  const learnedBy = Object.fromEntries(learned.map((n) => [n.niche, n]));
  const rows = Object.values(measured).filter((m) => m?.name).map((m) => ({ ...m, ...(learnedBy[m.name] || {}) }));
  const key = { score: (r) => -(r.score || 0), avg: (r) => -(r.avg || 0), leads: (r) => -(r.leads || 0), open: (r) => -(r.open_share || 0) }[by];
  rows.sort((a, b) => key(a) - key(b));
  const pct = (v) => (v === undefined ? "" : `${Math.round(v * (v > 1 ? 1 : 100))}%`);
  if (!rows.length) return <div className="list"><div className="empty">No niche measurement yet — it arrives with the next "Niche hits" run.</div></div>;
  return (
    <div className="list">
      <VerdictLearnings v={verdicts} />
      <div className="filters filings-bar">
        <select className="input" value={by} onChange={(e) => setBy(e.target.value)} aria-label="Sort niches">
          <option value="score">Sort: measured score (FX hit rate × open)</option>
          <option value="avg">Sort: average lead score</option>
          <option value="leads">Sort: most leads</option>
          <option value="open">Sort: most still open (no hedging named)</option>
        </select>
        <span className="muted">{rows.length} niches · measured {madeAt ? filedWhen(madeAt.slice(0, 10)) : ""} · hit rate = share of the niche's
          full / medium / group-accounts companies whose filings prove FX; open = of those, none naming forwards or an FX provider</span>
      </div>
      <div className="sheet-wrap">
        <table className="sheet">
          <thead><tr><th>Niche</th><th>Kind</th><th className="num">FX hit rate</th><th className="num">Open</th><th className="num">Score</th>
            <th>Verdict</th><th className="num">Leads</th><th className="num">Avg lead score</th><th className="num" title="Leads with a Fit of 60+">Fit 60+</th><th className="num">£20–300m</th><th className="num">FX loss</th><th className="num">Ruled out</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className={r.verdict === "drop" ? "muted-row" : ""}>
                <td><button className="linkish" onClick={() => onPick(r.name)} title="Show its companies">{r.name}</button></td>
                <td>{r.kind}</td><td className="num">{r.hit_rate}%</td><td className="num">{pct(r.open_share)}</td><td className="num">{r.score}</td>
                <td>{r.verdict === "drop" ? "Skipped by the finder" : r.verdict === "few" ? "Too few to tell" : ""}</td>
                <td className="num">{r.leads ?? ""}</td><td className="num">{r.avg ?? ""}</td><td className="num">{r.strong ?? ""}</td>
                <td className="num">{r.band ?? ""}</td><td className="num">{r.loss ?? ""}</td><td className="num">{r.ruled_out || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {headings.some((h) => !h.covered) && (
        <p className="filings-note">Customs headings no goods niche covers yet, best first: {headings.filter((h) => !h.covered).slice(0, 12)
          .map((h) => `${h.heading} ${h.chapter} (${h.hit_rate}% prove FX, ${h.strong} companies)`).join(" · ")}</p>
      )}
    </div>
  );
}

// The Hit list tab (Zac, 12 Nov 2026): companies whose accounts, filed in the last 6 months, show an FX loss — and that
// have a new finance director, are buying companies, or just had a private-equity deal. Highest lead score first; a
// switch adds the same changes without the loss (filed lately). Every pick shows its reasons.
// The hot alerts on the dashboard: new since the Alerts tab was last opened, the latest few named; opens the tab.
function AlertBanner({ summary, seen, onOpen }) {
  const hot = summary?.hot || [];
  const fresh = hot.filter((a) => String(a.at || "") > (seen || ""));
  if (!hot.length) return null;
  const show = (fresh.length ? fresh : hot).slice(0, 3);
  return (
    <button className={`alert-banner${fresh.length ? " fresh" : ""}`} onClick={onOpen} title="Open the Alerts tab">
      <b>{fresh.length ? `${fresh.length} new hot alert${fresh.length === 1 ? "" : "s"}` : `${hot.length} hot alert${hot.length === 1 ? "" : "s"} this week`}</b>
      {show.map((a) => <span key={`${a.company_number}${a.at}${a.title}`} className="ab-item">{a.title}: {a.company_name || a.company_number}</span>)}
      <span className="ab-go">Alerts →</span>
    </button>
  );
}

// The outreach plan (format.js outreachPlan): the top OUTREACH.letters leads for the Investec letter (with the registered
// office to post it to), then the rest — cold call when there's something timely to say, else the email sequence — each
// by lead score, one per group. Marking a company Contacted (Letter / Phone / Email…) moves it out and the next one up.
const OUTREACH_LISTS = [
  ["letter", "Letter — top", "The Investec outreach letter: the best leads by lead score, one per group."],
  ["call", "Cold call", "Something happened you can talk about now — a moment, a recently filed FX loss, a new FD, a deal or a trigger."],
  ["email", "Email sequence", "A good fit with no news yet: the sequence warms them up until something happens."],
];
function Outreach({ rows, contacted, password, onOpen, onContact, onEmail }) {
  const [list, setList] = useState("letter");
  // From the database when the site has one (ranked there, a page at a time — api/db.mjs outreachPage); else the
  // same plan worked out here from the loaded list (format.js outreachPlan).
  const local = useMemo(() => outreachPlan(rows, { contacted }), [rows, contacted]);
  const [server, setServer] = useState(null);
  useEffect(() => {
    let live = true;
    fetch(`${API}?view=outreach&list=${list}&limit=200`, { headers: { authorization: `Bearer ${password}` }, cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null)).then((body) => { if (live) setServer(body?.rows ? body : null); })
      .catch(() => { if (live) setServer(null); });
    return () => { live = false; };
  }, [list, contacted, password]);
  const fromDb = Boolean(server && server.list === list);
  const plan = fromDb ? { ...Object.fromEntries(["letter", "call", "email"].map((k) => [k, { length: server.counts[k] }])),
                          held: { length: server.counts.held }, [list]: server.rows } : local;
  const shown = (fromDb ? server.rows : plan[list]) || [];
  const fullList = async () => {
    if (!fromDb) return shown;
    const all = [];
    for (let offset = 0; ; offset += 500) {
      const res = await fetch(`${API}?view=outreach&list=${list}&limit=500&offset=${offset}`, { headers: { authorization: `Bearer ${password}` }, cache: "no-store" });
      const body = res.ok ? await res.json() : null;
      all.push(...(body?.rows || []));
      if (!body?.rows || body.rows.length < 500) return all;
    }
  };
  const stamp = new Date().toISOString().slice(0, 10);
  const top = (r) => (r.lead_parts || []).slice(0, 3).map(([w]) => w).join(" · ");
  const exportList = async () => {
    const out = (await fullList()).map((r, i) => ({
      rank: i + 1, company_name: r.company_name, addressee: letterAddressee(r), address: r.registered_address || "",
      postcode: r.postcode || "", company_number: r.company_number, website: siteOf(r), lead_score: r.lead_score,
      why_now: r.why_now || "", why: top(r), justification: outreachWhyLine(r), group_companies: (r.group_members || []).map((m) => m.company_name).join("; "),
      turnover_gbp: r.turnover_gbp || "", companies_house_url: chCompanyUrl(r.company_number),
    }));
    const cols = list === "letter"
      ? ["rank", "company_name", "addressee", "address", "postcode", "company_number", "lead_score", "justification", "why_now", "website", "group_companies", "companies_house_url"]
      : ["rank", "company_name", "company_number", "website", "lead_score", "justification", "why_now", "addressee", "turnover_gbp", "group_companies", "companies_house_url"];
    downloadSheet(out, columnsFor(cols, { addressee: list === "letter" ? "Addressee" : "Ask for", why_now: "Why now", justification: "Why this list" },
      ["rank", "lead_score", "turnover_gbp"]), `outreach-${list}-${stamp}.xlsx`, OUTREACH_LISTS.find(([k]) => k === list)[1]);
  };
  return (
    <div className="list">
      <div className="filters filings-bar">
        <div className="groups" role="group" aria-label="Outreach list">
          {OUTREACH_LISTS.map(([k, label, hint]) => (
            <button key={k} aria-pressed={list === k} className={`grp${list === k ? " on" : ""}`} title={hint} onClick={() => setList(k)}>
              {k === "letter" ? `${label} ${OUTREACH.letters}` : label} <span className="tab-n">{plan[k]?.length ?? 0}</span>
            </button>
          ))}
        </div>
        <button className="btn-sm export" onClick={exportList} disabled={!shown.length}>Export Excel ({plan[list]?.length ?? shown.length})</button>
        {list !== "letter" && <button className="btn-sm" onClick={() => downloadCognismCompanies(shown, `outreach-${list}`)} disabled={!cognismCompanyRows(shown).length}>
          Cognism company list ({cognismCompanyRows(shown).length})</button>}
      </div>
      <p className="filings-note">{OUTREACH_LISTS.find(([k]) => k === list)[2]} Highest lead score first. Mark one Contacted
        {list === "letter" ? " → Letter once it's posted" : ""} and the next moves up. {plan.held.length} more leads are held back by a serious
        reason not to progress (outside £20m–£300m, no FX in the filings, a hold-off); contacted groups are left out.
        {fromDb && <span className="muted"> Ranked in the database{server.synced_at ? ` (copied ${filedWhen(server.synced_at.slice(0, 10))})` : ""}.</span>}</p>
      {shown.slice(0, 200).map((r, i) => (
        <article className="card loss-card" key={r.company_number}>
          <div className="card-top">
            <div className="card-name">
              <span className="call-n">{i + 1}</span>
              <a className="co" href={companyPath(r.company_number)} onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onOpen(r.company_number); } }}>{r.company_name}</a>
              {r.group_members?.length > 0 && <span className="chip" title={r.group_members.map((m) => m.company_name).join("; ")}>+{r.group_members.length} group companies</span>}
              {r.section && <span className="chip">{r.section}</span>}
            </div>
            <div className="loss-fig"><b className="call-turnover">{r.lead_score}</b><span className="muted">lead score</span></div>
          </div>
          {list === "letter"
            ? <p className="panel-p"><b>{letterAddressee(r)}</b>{r.registered_address ? ` · ${r.registered_address}${r.postcode ? `, ${r.postcode}` : ""}` : " · address: see Companies House"}</p>
            : r.why_now && <ul className="call-why"><li>{r.why_now}</li></ul>}
          <dl className="outreach-why">
            {(r.outreach_why || []).map((w) => <div key={w.label}><dt>{w.label}</dt><dd>{w.text}</dd></div>)}
          </dl>
          <div className="card-foot">
            <a className="more-btn" href={companyPath(r.company_number)} onClick={(e) => { e.preventDefault(); onOpen(r.company_number); }}>Open company page →</a>
            <EmailButton r={r} onEmail={onEmail} />
            <span className="loss-contacted"><ContactedButton number={r.company_number} name={r.company_name} mark={null} onContact={onContact} /></span>
            <VerdictButtons number={r.company_number} />
          </div>
        </article>
      ))}
      {!shown.length && <div className="empty">Nobody here yet.</div>}
    </div>
  );
}

function HitList({ rows, onOpen, onContact, onEmail }) {
  const [wider, setWider] = useState(false);
  const recentlyFiled = (r) => { const f = filedIso(r); return f && f >= new Date(Date.now() - 183 * 864e5).toISOString().slice(0, 10); };
  const list = rows.filter((r) => !isOut(r) && !r.dropped && (r.lead_flags?.hit ||
    (wider && recentlyFiled(r) && (r.lead_flags?.newFd || r.lead_flags?.buying || r.lead_flags?.pe))))
    .sort((a, b) => (b.lead_score || 0) - (a.lead_score || 0));
  const change = (r) => [r.lead_flags?.newFd && (r.new_fd_in_accounts || "New finance director"),
    r.lead_flags?.buying && `Buying: ${r.acquisitions || "see the ownership register"}`, r.lead_flags?.pe && "Private-equity deal"].filter(Boolean);
  const exportHits = () => downloadSheet(list.map((r, i) => ({
    rank: i + 1, company_name: r.company_name, company_number: r.company_number, lead_score: r.lead_score,
    fx_loss_gbp: Number(r.fx_gain_loss_gbp) < 0 ? -Number(r.fx_gain_loss_gbp) : "", accounts_filed: filedIso(r),
    change: change(r).join(" | "), acquisitions: r.acquisitions || "", new_fd: r.new_fd_in_accounts || "",
    turnover_gbp: r.turnover_gbp || "", lead_reasons: r.lead_reasons || "", accounts_url: r.accounts_url || "",
    companies_house_url: chCompanyUrl(r.company_number),
  })), columnsFor(["rank", "company_name", "company_number", "lead_score", "fx_loss_gbp", "accounts_filed", "change", "acquisitions",
    "new_fd", "turnover_gbp", "lead_reasons", "accounts_url", "companies_house_url"], { fx_loss_gbp: "FX loss (£)", turnover_gbp: "Turnover (£)" },
    ["rank", "lead_score", "fx_loss_gbp", "turnover_gbp"]), `hit-list-${new Date().toISOString().slice(0, 10)}.xlsx`, "Hit list");
  return (
    <div className="list">
      <div className="filters filings-bar">
        <span className="muted">{list.length} companies: accounts filed in the last 6 months with an FX loss of £50k+, and a new finance
          director, buying companies or a private-equity deal{wider ? " — or one of those changes with a recent filing" : ""}. Highest lead score first.</span>
        <label className="check"><input type="checkbox" checked={wider} onChange={(e) => setWider(e.target.checked)} /> Also without an FX loss</label>
        <button className="btn-sm export" onClick={exportHits} disabled={!list.length}>Export Excel ({list.length})</button>
      </div>
      {list.slice(0, 200).map((r, i) => (
        <article className="card loss-card" key={r.company_number}>
          <div className="card-top">
            <div className="card-name">
              <span className="call-n">{i + 1}</span>
              <a className="co" href={companyPath(r.company_number)} onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onOpen(r.company_number); } }}>{r.company_name}</a>
              {r.section && <span className="chip">{r.section}</span>}
            </div>
            <div className="loss-fig">
              {Number(r.fx_gain_loss_gbp) < 0 && <b className="call-turnover">−{money(-Number(r.fx_gain_loss_gbp))}</b>}
              <span className="muted">FX {Number(r.fx_gain_loss_gbp) < 0 ? "loss" : "result"} · filed {filedWhen(filedIso(r))}</span>
            </div>
          </div>
          <ul className="call-why">{change(r).map((c) => <li key={c}>{c}</li>)}</ul>
          <LeadScore r={r} />
          {r.acquisitions_evidence && <p className="panel-p muted" title={r.acquisitions_evidence}>“{r.acquisitions_evidence.slice(0, 220)}{r.acquisitions_evidence.length > 220 ? "…" : ""}”</p>}
          <div className="card-foot">
            <a className="more-btn" href={companyPath(r.company_number)} onClick={(e) => { e.preventDefault(); onOpen(r.company_number); }}>Open company page →</a>
            <EmailButton r={r} onEmail={onEmail} />
            <span className="loss-contacted"><ContactedButton number={r.company_number} name={r.company_name} mark={null} onContact={onContact} /></span>
            <VerdictButtons number={r.company_number} />
          </div>
        </article>
      ))}
      {!list.length && <div className="empty">Nothing yet — the year's filings are being read again for purchases and finance directors (a day or two), and the ownership register's deals arrive each morning.</div>}
    </div>
  );
}

// Best fit (mode "fit": who to call at all — sorted by Fit) and Call now (mode "now": those that fit, with a reason to
// call now — sorted by Timing, then Fit). Each card shows that half's reasons; the export carries both.
function FitTiming({ mode, rows, onOpen, onContact, onEmail }) {
  const fresh = mode === "new";
  const [days, setDays] = useState(7);
  const foreign = mode === "foreign";
  const uk = mode === "uk" || foreign || fresh;
  const fitOnly = mode === "fit" || uk;
  const key = uk ? "lead_score" : fitOnly ? "lead_fit" : "lead_timing";
  const [industry, setIndustry] = useState("");
  const base = rows.filter((r) => !isOut(r) && !r.dropped && (!fresh || newLead(r, days)) && (uk || ((r.lead_fit || 0) >= FIT.min && (fitOnly || (r.lead_timing || 0) > 0))));
  const counts = {};
  for (const r of base) { const k = industryOf(r); counts[k] = (counts[k] || 0) + 1; }
  const list = base.filter((r) => !industry || industryOf(r) === industry)
    .sort((a, b) => (b[key] || 0) - (a[key] || 0) || (b.lead_score || 0) - (a.lead_score || 0));
  const half = (r, cat) => (r.lead_parts || []).filter(([, , c]) => c === cat);
  const line = (parts) => parts.map(([why, p]) => `${why} ${p > 0 ? "+" : "−"}${Math.abs(p)}`).join("; ");
  const exportList = () => downloadSheet(list.map((r, i) => ({
    rank: i + 1, company_name: r.company_name, company_number: r.company_number, added_on: addedOn(r), industry: industryOf(r), lead_fit: r.lead_fit,
    lead_timing: r.lead_timing, lead_score: r.lead_score, fit_reasons: line(half(r, "fit")), timing_reasons: line(half(r, "timing")),
    turnover_gbp: r.turnover_gbp || "", companies_house_url: chCompanyUrl(r.company_number),
  })), columnsFor(["rank", "company_name", "company_number", ...(fresh ? ["added_on"] : []), "industry", "lead_fit", "lead_timing", "lead_score", "fit_reasons", "timing_reasons",
    "turnover_gbp", "companies_house_url"], { lead_fit: "Fit", lead_timing: "Now", turnover_gbp: "Turnover (£)" },
    ["rank", "lead_fit", "lead_timing", "lead_score", "turnover_gbp"]), `${fresh ? "new-leads" : foreign ? "foreign-owned" : uk ? "uk-in-name" : fitOnly ? "best-fit" : "call-now"}-${new Date().toISOString().slice(0, 10)}.xlsx`,
    fresh ? "New leads" : foreign ? "Foreign-owned" : uk ? "UK in name" : fitOnly ? "Best fit" : "Call now");
  return (
    <div className="list">
      <div className="filters filings-bar">
        <span className="muted">{fresh
          ? `${list.length} companies new to the lists in the last ${days} days — the finder's new finds and fresh FX filings. Highest lead score first.`
          : foreign
          ? `${list.length} companies owned from abroad — ask whether FX is decided in the UK or by the parent. Out of every other list; highest lead score first.`
          : uk
          ? `${list.length} companies with “UK” in their name — usually a foreign group's UK arm (ask whether FX is run here or by the parent). Out of every other list; highest lead score first.`
          : fitOnly
          ? `${list.length} companies with Fit ${FIT.min}+ — the right company for the desk (FX proof and FX pain, size, niche, ownership), whatever the news. Best fit first.`
          : `${list.length} of those with a reason to call now — a new FD, a deal, funding, a fresh filing, a customs or bank change. Most timely first (moments fade over 120 days).`}</span>
        {fresh && <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Added in the last">
          {NEW_LEAD_DAYS.map((d) => <option key={d} value={d}>Last {d} days</option>)}
        </select>}
        <select value={industry} onChange={(e) => setIndustry(e.target.value)} aria-label="Industry">
          <option value="">Any industry ({base.length})</option>
          {Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => <option key={k} value={k}>{k} ({n})</option>)}
        </select>
        <button className="btn-sm export" onClick={exportList} disabled={!list.length}>Export Excel ({list.length})</button>
      </div>
      {list.slice(0, 200).map((r, i) => (
        <article className="card loss-card" key={r.company_number}>
          <div className="card-top">
            <div className="card-name">
              <span className="call-n">{i + 1}</span>
              <a className="co" href={companyPath(r.company_number)} onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onOpen(r.company_number); } }}>{r.company_name}</a>
              <span className="chip">{industryOf(r)}</span>
              {fresh && <span className="new">Added {addedOn(r)}</span>}
            </div>
            <div className="loss-fig">
              <b className="call-turnover">{uk ? `Score ${r.lead_score}` : fitOnly ? `Fit ${r.lead_fit}` : `Now ${r.lead_timing}`}</b>
              <span className="muted">{fitOnly ? `Now ${r.lead_timing || 0}` : `Fit ${r.lead_fit}`} · score {r.lead_score}</span>
            </div>
          </div>
          <ul className="call-why">{half(r, fitOnly ? "fit" : "timing").map(([why, p]) => <li key={why}>{why} <b>{p > 0 ? "+" : "−"}{Math.abs(p)}</b></li>)}</ul>
          {!fitOnly && <p className="panel-p muted">Fits because: {half(r, "fit").map(([w]) => w.replace(/ \(.*\)$/, "")).join(" · ")}</p>}
          <div className="card-foot">
            <a className="more-btn" href={companyPath(r.company_number)} onClick={(e) => { e.preventDefault(); onOpen(r.company_number); }}>Open company page →</a>
            <EmailButton r={r} onEmail={onEmail} />
            <span className="loss-contacted"><ContactedButton number={r.company_number} name={r.company_name} mark={null} onContact={onContact} /></span>
            <VerdictButtons number={r.company_number} />
          </div>
        </article>
      ))}
      {!list.length && <div className="empty">No company fits yet with these filters.</div>}
    </div>
  );
}

// Zac's review of a lead: Good lead, or Not a fit with a reason (stored as his own verdict — never a bank record).
const VerdictContext = createContext({ verdicts: {}, setVerdict: () => {} });
// Who owns it, up the chain, and where — with Google searches to check it (never fetched).
function OwnershipPanel({ r }) {
  const o = ownership(r);
  return (
    <section className="panel">
      <h2 className="panel-h">Ownership: {OWNERSHIP_LABEL[o.status]}{o.status === "foreign" ? ` (${o.country})` : ""}</h2>
      <p className="panel-p"><b>{o.chain.join(" → ")}</b></p>
      {o.says.length > 0 && <ul className="call-why">{o.says.map((x) => <li key={x.from}><b>{x.from}:</b> {x.status === "uk" ? "UK-owned" : x.status === "foreign" ? "Foreign-owned" : "Not known"}{x.owner ? ` — ${x.owner}` : ""}{x.status === "foreign" ? ` (${x.country})` : ""}{x.note ? ` (${x.note})` : ""}{x.quote ? <> — “{x.quote}”{x.url && <> <a href={x.url} target="_blank" rel="noreferrer">source ↗</a></>}</> : null}</li>)}</ul>}
      {o.source && <p className="muted panel-p">Answer from {o.source}.{r.ultimate_parent_evidence ? ` Accounts: “${r.ultimate_parent_evidence}”` : ""}</p>}
      <p className="panel-p">{o.searches.map(([label, url]) => <a key={url} className="chip" href={url} target="_blank" rel="noreferrer">{label} ↗</a>)}</p>
    </section>
  );
}

// Where finance decisions sit (control.js): the lean, every sign for and against with its points, and what to ask.
function SeatPanel({ r }) {
  const seat = financeSeat(r);
  const forUk = seat.signs.filter((x) => x.points > 0);
  const against = seat.signs.filter((x) => x.points < 0);
  return (
    <section className="panel">
      <h2 className="panel-h">Where finance decisions sit: {seat.verdict}</h2>
      <div className="score-groups open">
        {forUk.length > 0 && <div className="score-group"><h4>Decided in the UK</h4><ul>{forUk.map((x) => <li key={x.text}><span className="lead-p">+{x.points}</span>{x.text}</li>)}</ul></div>}
        {against.length > 0 && <div className="score-group"><h4>Run from abroad</h4><ul>{against.map((x) => <li key={x.text}><span className="lead-p neg">−{-x.points}</span>{x.text}</li>)}</ul></div>}
        {!seat.signs.length && <p className="muted panel-p">Nothing in the records points either way.</p>}
      </div>
      {seat.questions.length > 0 && <>
        <h4 className="panel-h">Ask on the call</h4>
        <ul className="call-why">{seat.questions.map((q) => <li key={q}>{q}</li>)}</ul>
      </>}
      <p className="muted panel-p">A lean from the register, the lender and the accounts' own words — check it with them, and against the CRM before calling.</p>
    </section>
  );
}

// What we can pitch them: Investec's products matched to the company's filed facts (pitch.js), each with its reason.
function PitchPanel({ r }) {
  const pitches = pitchFor(r);
  if (!pitches.length) return null;
  return (
    <section className="panel">
      <h2 className="panel-h">What we can pitch them</h2>
      <ul className="pitch-list">
        {pitches.map((p) => (
          <li key={p.key}><b>{p.name}</b> <span className="chip">{p.group}</span>
            <div>{p.why}</div>
            <div className="muted">{p.what}. <a href={p.source} target="_blank" rel="noreferrer">Investec page</a></div></li>
        ))}
      </ul>
      <p className="muted panel-p">Matched from the company's filed accounts and the public registers — check current rates and appetite with the desk before quoting.</p>
    </section>
  );
}

// The 18-step outreach sequence on a list card: start it (Day 0 = the cold email, or the gift landing), tick steps off,
// the next one due shown first; the whole plan folds open.
function SequencePanel({ r, which }) {
  const { setSequence } = useContext(VerdictContext);
  const [draft, setDraft] = useState(null);
  const today = new Date().toISOString().slice(0, 10);
  const seq = r.seq;
  if (!seq?.start) {
    return (
      <p className="panel-p seq-start">
        <button className="btn-sm" onClick={() => setSequence(r.company_number, { start: today, ...(which === "post" ? { gift: today } : {}), done: {} })}
                title="Day 0 is today: the cold email, or the day the gift is sent">Start sequence today</button>
        <span className="muted"> or Day 0 on </span>
        <input type="date" aria-label="Sequence Day 0" onChange={(e) => e.target.value && setSequence(r.company_number, { start: e.target.value, done: {} })} />
      </p>
    );
  }
  const steps = plan(seq);
  const next = nextStep(seq);
  const toggle = (step) => {
    const done = { ...(seq.done || {}) };
    if (done[step]) delete done[step]; else done[step] = today;
    setSequence(r.company_number, { ...seq, done });
  };
  const doneCount = Object.keys(seq.done || {}).length;
  return (
    <details className="seq">
      <summary>
        {next ? <><b className={`seq-when ${next.when}`}>{next.when === "overdue" ? "Overdue" : next.when === "today" ? "Today" : filedWhen(next.due)}</b>
          {" "}Step {next.step}: {next.label}</> : <b>Sequence finished</b>}
        <span className="muted"> · {doneCount}/{SEQUENCE.length} done · Day 0 {filedWhen(seq.start)}</span>
      </summary>
      {which === "post" && (
        <p className="panel-p">Gift sent on <input type="date" value={seq.gift || ""} onChange={(e) => setSequence(r.company_number, { ...seq, gift: e.target.value || undefined })} /></p>
      )}
      <ul className="seq-steps">
        {steps.map((s) => (
          <li key={s.step} className={s.done ? "done" : s.due < today ? "late" : ""}>
            <label><input type="checkbox" checked={Boolean(s.done)} onChange={() => toggle(s.step)} />
              <span className="seq-due">{filedWhen(s.due)}</span> <span className={`seq-kind ${s.kind}`}>{s.kind}</span> Step {s.step}: {s.label}</label>
            {s.kind === "email" && <button className="btn-link" onClick={() => setDraft(draft === s.step ? null : s.step)}>{draft === s.step ? "hide email" : "email"}</button>}
            {s.step === 1 && which !== "post" && <RolePicker r={r} seq={seq} />}
            {s.kind === "call" && !s.done && s.step === next?.step && <CallLine r={r} seq={seq} />}
            {draft === s.step && <StepEmail r={r} which={which} step={s.step} />}
          </li>
        ))}
      </ul>
      <button className="btn-link" onClick={() => { if (confirm("Clear this company's sequence?")) setSequence(r.company_number, null); }}>Clear sequence</button>
    </details>
  );
}

// Who got the first email: tick the Finance Director, Financial Controller and Finance Manager (Zac's rule of thumb —
// email the finance team, call the next day).
function RolePicker({ r, seq }) {
  const { setSequence } = useContext(VerdictContext);
  const roles = seq.roles || [];
  const flip = (k) => setSequence(r.company_number, { ...seq, roles: roles.includes(k) ? roles.filter((x) => x !== k) : [...roles, k].sort((a, b) => Object.keys(ROLES).indexOf(a) - Object.keys(ROLES).indexOf(b)) });
  return (
    <span className="role-pick"> emailed:
      {Object.entries(ROLES).map(([k, name]) => (
        <label key={k} className="check"><input type="checkbox" checked={roles.includes(k)} onChange={() => flip(k)} /> {name.split(" / ")[0]}</label>
      ))}
    </span>
  );
}

// The call after the email: who to ask for and the opening line.
function CallLine({ r, seq }) {
  const c = callScript(r, seq, firstName(r));
  return <div className="call-line"><b>{c.ask}</b>{c.emailed.length > 0 && <span className="muted"> · emailed: {c.emailed.join(", ")}</span>}<div>“{c.line}”</div></div>;
}

// Today: every list's sequence steps due today or overdue — calls (with who to ask for and the line), emails (the
// draft one click away), LinkedIn — then the companies to start today: email the FD, FC and finance manager today,
// call tomorrow. Best leads first; nothing is sent.
function Today({ rows, lists, onOpen }) {
  const { setList, setSequence } = useContext(VerdictContext);
  const q = useMemo(() => todayQueue(rows, lists, { fitMin: FIT.min, skip: (r) => isOut(r) || elsewhere(r) }), [rows, lists]);
  const today = new Date().toISOString().slice(0, 10);
  const link = (r) => <a className="co" href={companyPath(r.company_number)} onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onOpen(r.company_number); } }}>{r.company_name}</a>;
  const tick = (x) => setSequence(x.r.company_number, { ...x.seq, done: { ...(x.seq.done || {}), [x.step.step]: today } });
  const start = async (x) => {
    if (!x.list) await setList(x.r.company_number, "email");
    await setSequence(x.r.company_number, { start: today, done: {}, ...(x.list === "post" ? { gift: today } : {}) });
  };
  const Item = ({ x, children }) => (
    <article className="card loss-card">
      <div className="card-top"><div className="card-name">{link(x.r)} <span className="chip">{LIST_NAMES[x.list] || "Not on a list"}</span>
        {x.r.lead_score !== undefined && <span className="chip lead-chip">Score {x.r.lead_score}</span>}</div>
        {x.step && <div className="loss-fig"><b className={`seq-when ${x.step.when}`}>{x.step.when === "overdue" ? `Overdue (${filedWhen(x.step.due)})` : "Today"}</b>
          <span className="muted">Step {x.step.step}: {x.step.label}</span></div>}</div>
      {children}
    </article>
  );
  const Section = ({ title, items, render, empty }) => (
    <section className="today-sec"><h3 className="panel-h">{title} <span className="tab-n">{items.length}</span></h3>
      {items.length ? items.map(render) : <div className="empty">{empty}</div>}</section>
  );
  return (
    <div className="list">
      <div className="filters filings-bar"><span className="muted">The day's work: calls first (each the day after its email — ask if they saw it), then
        the emails due, then LinkedIn, then up to {START_PER_DAY} new companies to start — email the FD, FC and finance manager today, call tomorrow.</span></div>
      <Section title="Calls" items={q.calls} empty="No calls due." render={(x) => (
        <Item key={x.r.company_number} x={x}><CallLine r={x.r} seq={x.seq} />
          <div className="card-foot"><button className="btn-sm" onClick={() => tick(x)}>Done</button></div></Item>)} />
      <Section title="Emails" items={q.emails} empty="No emails due." render={(x) => (
        <Item key={x.r.company_number} x={x}>
          {x.step.step === 1 && x.list !== "post" && <p className="panel-p">Email the Finance Director, the Financial Controller and the Finance Manager.</p>}
          <details><summary className="btn-link">Draft</summary><StepEmail r={x.r} which={x.list} step={x.step.step} /></details>
          <div className="card-foot"><button className="btn-sm" onClick={() => tick(x)}>Sent</button></div></Item>)} />
      <Section title="LinkedIn" items={q.linkedin} empty="Nothing on LinkedIn today." render={(x) => (
        <Item key={x.r.company_number} x={x}><div className="card-foot"><button className="btn-sm" onClick={() => tick(x)}>Done</button></div></Item>)} />
      <Section title="Start today" items={q.start} empty="Nothing waiting — add companies to a list." render={(x) => (
        <Item key={x.r.company_number} x={x}>
          {pitchLine(x.r) && <p className="panel-p"><b>Pitch:</b> {pitchLine(x.r)}</p>}
          <LeadScore r={x.r} />
          <div className="card-foot"><button className="btn-sm" onClick={() => start(x)}
            title="Day 0 today: email the FD, FC and finance manager; the call to ask if they saw it is due tomorrow">
            {x.list === "post" ? "Gift sent today — start" : "Email today, call tomorrow"}</button></div></Item>)} />
    </div>
  );
}

// One email step's draft: the step's template (templates.js) filled from the company's records, editable, with Copy and
// where each filled part came from; any of the templates can be picked instead. Nothing is sent.
function StepEmail({ r, which, step }) {
  const { moves } = useContext(VerdictContext);
  const [key, setKey] = useState(stepTemplate(which, step));
  const filled = key ? fillTemplate(key, r, moves || {}) : null;
  const [text, setText] = useState(filled?.text || "");
  const [copied, setCopied] = useState(false);
  const pick = (k) => { setKey(k); setText(k ? fillTemplate(k, r, moves || {}).text : ""); };
  return (
    <div className="step-email">
      <select value={key} onChange={(e) => pick(e.target.value)} aria-label="Template">
        <option value="">{key ? "No template" : "No template for this step yet — pick one"}</option>
        {Object.entries(TEMPLATES).map(([k, t]) => <option key={k} value={k}>{t.name}</option>)}
      </select>
      {key && <>
        <textarea className="input email-edit" rows={12} value={text} onChange={(e) => setText(e.target.value)} aria-label={`Step ${step} email`} />
        <button className="btn-sm" onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* select by hand */ } }}>
          {copied ? "Copied" : "Copy"}</button>
        {/\[[^\]]+\]/.test(text) && <span className="muted"> Fill in the [brackets] before sending.</span>}
        <p className="muted panel-p">{filled?.sources.join(" · ")}</p>
      </>}
    </div>
  );
}

// My lists: the companies Zac put on his call, chocolate / mailing and email lists, newest first, each with an export
// (the mailing list's carries the addressee and registered office).
function MyLists({ which, rows, lists, onOpen, onContact, onEmail }) {
  const byNumber = useMemo(() => Object.fromEntries(rows.map((r) => [r.company_number, r])), [rows]);
  const { setList } = useContext(VerdictContext);
  const [missingOnly, setMissingOnly] = useState(false);
  const mine = Object.entries(lists).filter(([, v]) => v.list === which);
  const missingCount = mine.filter(([, v]) => v.missing).length;
  const today = new Date();
  const list = mine.filter(([, v]) => Boolean(v.missing) === missingOnly)
    .sort((a, b) => sequenceRank(a[1].seq, today).localeCompare(sequenceRank(b[1].seq, today)) || String(b[1].at).localeCompare(String(a[1].at)))
    .map(([n, v]) => ({ ...(byNumber[n] || { company_number: n, company_name: n }), added_at: v.at, missing: v.missing, seq: v.seq }));
  const due = mine.filter(([, v]) => !v.missing && ["overdue", "today"].includes(nextStep(v.seq, today)?.when)).length;
  const need = { call: "a number or the finance director's name", email: "an email address", post: "a name or address" }[which] || "the details";
  // Laid out like Zac's follow-up grid: account, number, name, title, CRM, then blank LinkedIn / email / mobile for him to
  // fill from Cognism on the bank's side (never stored here), Send out or Cold, the gift date and every step's date.
  const exportList = () => downloadSheet(list.map((r) => ({
    account_name: r.company_name, company_number: r.company_number, name: presentedContact(r) ? r.finance_contact : "",
    job_title: presentedContact(r) ? r.finance_contact_role || "" : askFor(r), crm: "", linkedin: "", email_address: "", mobile_number: "",
    send_out_or_cold: which === "post" ? "Send out" : "Cold", gift_send_out_date: r.seq?.gift || "", address: r.registered_address || "",
    postcode: r.postcode || "", what_to_pitch: pitchLine(r), ...gridCells(r.seq),
  })), columnsFor(["account_name", "company_number", "name", "job_title", "crm", "linkedin", "email_address", "mobile_number", "send_out_or_cold",
    "gift_send_out_date", "address", "postcode", "what_to_pitch", ...GRID_COLUMNS.map(([k]) => k)],
    { account_name: "Account Name", company_number: "Companies House Number", name: "Name", job_title: "Job Title", crm: "CRM", linkedin: "LinkedIn",
      email_address: "Email Address", mobile_number: "Mobile Number", send_out_or_cold: "Send Out or Cold", gift_send_out_date: "Gift Send Out Date",
      ...Object.fromEntries(GRID_COLUMNS) }, []), `${which}-list-${new Date().toISOString().slice(0, 10)}.xlsx`, LIST_NAMES[which]);
  return (
    <div className="list">
      <div className="filters filings-bar">
        <button className={`btn-sm${!missingOnly ? " on" : ""}`} aria-pressed={!missingOnly} onClick={() => setMissingOnly(false)}>
          Ready ({mine.length - missingCount}){due ? ` · ${due} due` : ""}</button>
        <button className={`btn-sm${missingOnly ? " on" : ""}`} aria-pressed={missingOnly} onClick={() => setMissingOnly(true)}
                title={`Companies where you couldn't find ${need}`}>Can't find info ({missingCount})</button>
        <button className="btn-sm export" onClick={exportList} disabled={!list.length}>Export Excel ({list.length})</button>
      </div>
      {list.map((r, i) => (
        <article className="card loss-card" key={r.company_number}>
          <div className="card-top">
            <div className="card-name">
              <span className="call-n">{i + 1}</span>
              <a className="co" href={companyPath(r.company_number)} onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onOpen(r.company_number); } }}>{r.company_name}</a>
              <span className="chip">{industryOf(r)}</span>
            </div>
            <div className="loss-fig"><span className="muted">added {filedWhen(String(r.added_at || "").slice(0, 10))}</span></div>
          </div>
          {which === "post" && <p className="panel-p"><b>{letterAddressee(r)}</b>{r.registered_address ? ` · ${r.registered_address}${r.postcode ? `, ${r.postcode}` : ""}` : " · address: see Companies House"}</p>}
          {pitchLine(r) && <p className="panel-p"><b>Pitch:</b> {pitchLine(r)}</p>}
          <LeadScore r={r} />
          {!r.missing && <SequencePanel r={r} which={which} />}
          <p className="panel-p">
            <button className="btn-sm" onClick={() => setList(r.company_number, which, !r.missing)}
                    title={r.missing ? "Found it — back to Ready" : `Couldn't find ${need} — park it under Can't find info`}>
              {r.missing ? "Found it — move to Ready" : "Can't find info"}</button>
          </p>
          <div className="card-foot">
            <a className="more-btn" href={companyPath(r.company_number)} onClick={(e) => { e.preventDefault(); onOpen(r.company_number); }}>Open company page →</a>
            <EmailButton r={r} onEmail={onEmail} />
            <span className="loss-contacted"><ContactedButton number={r.company_number} name={r.company_name} mark={null} onContact={onContact} /></span>
            <VerdictButtons number={r.company_number} />
          </div>
        </article>
      ))}
      {!list.length && <div className="empty">{missingOnly ? "Nothing parked here." : `Nothing on your ${LIST_NAMES[which].toLowerCase()} yet — use the “+ ${LIST_NAMES[which]}” button on any card or company page.`}</div>}
    </div>
  );
}

// Zac's own lists: call list, chocolate / mailing list, email list — one each company; clicking the chosen one again
// takes it off. Shown beside the verdict buttons wherever they are.
const LIST_NAMES = { call: "Call list", email: "Email list", post: "Mail list" };   // post: the chocolate / letter mailing
function ListButtons({ number }) {
  const { lists, setList } = useContext(VerdictContext);
  const on = lists?.[number]?.list;
  return (
    <span className="list-btns" role="group" aria-label="Add to a list">
      {Object.entries(LIST_NAMES).map(([key, name]) => (
        <button key={key} className={`btn-sm${on === key ? " on" : ""}`} aria-pressed={on === key}
                title={on === key ? `On your ${name.toLowerCase()} — click to take it off` : `Add to your ${name.toLowerCase()}`}
                onClick={() => setList(number, on === key ? null : key)}>{on === key ? "✓ " : "+ "}{name}</button>
      ))}
    </span>
  );
}

function VerdictButtons({ number }) {
  return <><ListButtons number={number} /><VerdictOnly number={number} /></>;
}
function VerdictOnly({ number }) {
  const { verdicts, setVerdict } = useContext(VerdictContext);
  const [asking, setAsking] = useState(false);
  const v = verdicts[number];
  if (v) {
    return (
      <span className={`verdict verdict-${v.verdict}`}>
        {v.verdict === "good" ? "Good lead" : `Not a fit${v.reason ? `: ${v.reason}` : ""}`}
        <button className="btn-link" onClick={() => setVerdict(number, null)} title="Clear your verdict">undo</button>
      </span>
    );
  }
  if (asking) {
    return (
      <span className="verdict">
        {VERDICT_REASONS.map((reason) => (
          <button key={reason} className="btn-sm" onClick={() => { setAsking(false); setVerdict(number, "not_fit", reason); }}>{reason}</button>
        ))}
        <button className="btn-link" onClick={() => setAsking(false)}>cancel</button>
      </span>
    );
  }
  return (
    <span className="verdict">
      <button className="btn-sm" onClick={() => setVerdict(number, "good")} title="A lead worth calling — counts towards measuring which sources and niches work">Good lead</button>
      <button className="btn-sm" onClick={() => setAsking(true)} title="Not a fit — drops it from the lists; pick why">Not a fit</button>
    </span>
  );
}

// The company's group (its top UK parent, from the ownership register) and the other group companies the list holds,
// when "One per group" folded them into this row.
function GroupChips({ r }) {
  const name = groupName(r), abroad = groupOf(r)?.abroad;
  const members = r.group_members || [];
  if (!name && !members.length && !abroad) return null;
  return (<>
    {name && <span className="chip" title={`Top UK parent: ${name} (${groupOf(r).top})${abroad ? ` — owned by ${abroad}` : ""}`}>Group: {name}</span>}
    {!name && abroad && <span className="chip" title="Its corporate owner is registered abroad">Owner abroad: {abroad}</span>}
    {members.length > 0 && <span className="chip" title={members.map((m) => m.company_name).join("\n")}>+{members.length} group compan{members.length === 1 ? "y" : "ies"}</span>}
  </>);
}

// The Hard to broker tab (Zac, 13 Nov 2026): leads in sectors payment firms often decline or restrict — scrap, bullion,
// jewellery, art, mining, metals, waste, fuel, vehicles, phones, tobacco, vapes, shipping, bloodstock, commodities —
// where a bank's FX desk can win. Tagged daily (sourcer/niches.broker_shy: customs records first, else the sector);
// never weapons, gambling, crypto, cannabis or adult. Grouped by sector, highest lead score first.
function HardToBroker({ rows, shyOf, onOpen, onContact, onEmail }) {
  const [sector, setSector] = useState("");
  const all = rows.filter((r) => shyOf[r.company_number] && !isOut(r) && !r.dropped)
    .sort((a, b) => (b.lead_score || 0) - (a.lead_score || 0));
  const counts = {};
  for (const r of all) counts[shyOf[r.company_number].niche] = (counts[shyOf[r.company_number].niche] || 0) + 1;
  const list = sector ? all.filter((r) => shyOf[r.company_number].niche === sector) : all;
  const exportShy = () => downloadSheet(list.map((r, i) => ({
    rank: i + 1, company_name: r.company_name, company_number: r.company_number, website: siteOf(r), lead_score: r.lead_score,
    sector: shyOf[r.company_number].niche, why_brokers_shy: shyOf[r.company_number].why, turnover_gbp: r.turnover_gbp || "",
    fx_loss_gbp: Number(r.fx_gain_loss_gbp) < 0 ? -Number(r.fx_gain_loss_gbp) : "", lead_reasons: r.lead_reasons || "",
    companies_house_url: chCompanyUrl(r.company_number),
  })), columnsFor(["rank", "company_name", "company_number", "website", "lead_score", "sector", "why_brokers_shy", "turnover_gbp",
    "fx_loss_gbp", "lead_reasons", "companies_house_url"], { why_brokers_shy: "Why brokers shy away", turnover_gbp: "Turnover (£)",
    fx_loss_gbp: "FX loss (£)" }, ["rank", "lead_score", "turnover_gbp", "fx_loss_gbp"]),
    `hard-to-broker-${new Date().toISOString().slice(0, 10)}.xlsx`, "Hard to broker");
  return (
    <div className="list">
      <div className="filters filings-bar">
        <span className="muted">{list.length} companies in sectors payment firms often decline or limit — where a bank's FX desk can win.
          Check Investec's own appetite for the sector before calling. Never weapons, gambling, crypto, cannabis or adult.</span>
        <select value={sector} onChange={(e) => setSector(e.target.value)} aria-label="Sector">
          <option value="">All sectors ({all.length})</option>
          {Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => <option key={k} value={k}>{k} ({n})</option>)}
        </select>
        <button className="btn-sm export" onClick={exportShy} disabled={!list.length}>Export Excel ({list.length})</button>
        <button className="btn-sm" onClick={() => downloadCognismCompanies(list, "hard-to-broker")} disabled={!cognismCompanyRows(list).length}>
          Cognism company list ({cognismCompanyRows(list).length})</button>
      </div>
      {list.slice(0, 200).map((r, i) => (
        <article className="card loss-card" key={r.company_number}>
          <div className="card-top">
            <div className="card-name">
              <span className="call-n">{i + 1}</span>
              <a className="co" href={companyPath(r.company_number)} onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onOpen(r.company_number); } }}>{r.company_name}</a>
              <span className="chip">{shyOf[r.company_number].niche}</span>
              {siteOf(r) && <a className="site" href={siteUrl(siteOf(r))} target="_blank" rel="noreferrer">{siteLabel(siteOf(r))}</a>}
          <GroupChips r={r} />
            </div>
            <div className="loss-fig">
              {r.turnover_gbp && <b className="call-turnover">{money(Number(r.turnover_gbp))}</b>}
              {Number(r.fx_gain_loss_gbp) < 0 && <span className="muted">FX loss {money(-Number(r.fx_gain_loss_gbp))}</span>}
            </div>
          </div>
          <p className="panel-p muted">{shyOf[r.company_number].why}</p>
          <LeadScore r={r} />
          <div className="card-foot">
            <a className="more-btn" href={companyPath(r.company_number)} onClick={(e) => { e.preventDefault(); onOpen(r.company_number); }}>Open company page →</a>
            <EmailButton r={r} onEmail={onEmail} />
            <span className="loss-contacted"><ContactedButton number={r.company_number} name={r.company_name} mark={null} onContact={onContact} /></span>
            <VerdictButtons number={r.company_number} />
          </div>
        </article>
      ))}
      {!list.length && <div className="empty">Nothing tagged yet — the morning ranking run tags every lead's sector (first run after this change).</div>}
    </div>
  );
}

// The New money tab: who was just bought by private equity, who is buying companies, who just raised funding, who has
// a new overseas owner or an employee ownership trust — from Companies House's ownership register (last 120 days,
// each with its FX sign) and the news. Newest first.
const MONEY_KINDS = { pe_buyout: "Bought by PE", news_pe: "PE deal (news)", pe_debt: "Buyout-style debt", acquired: "Buying companies", news_funding: "Just funded",
  overseas_buyer: "New overseas owner", eot: "Employee ownership trust" };
const MONEY_FILTERS = [["", "All"], ["pe", "Private equity"], ["acquired", "Buying companies"], ["news_funding", "Just funded"],
  ["overseas_buyer", "Overseas owner"], ["eot", "EOT"]];
function NewMoney({ password, listed, onOpen, rows: listRows = [] }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [industry, setIndustry] = useState("");
  const byNumber = useMemo(() => new Map(listRows.map((r) => [r.company_number, r])), [listRows]);
  const [mine, setMine] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(`${API}?view=deals`, { headers: { authorization: `Bearer ${password}` }, cache: "no-store" })
      .then(async (res) => { const body = await res.json().catch(() => ({})); if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`); return body; })
      .then((body) => { if (live) setData(body); })
      .catch((e) => { if (live) { setError(e.message); setData({ items: [], news: [] }); } });
    return () => { live = false; };
  }, [password]);
  const rows = useMemo(() => {
    const items = [...(data?.items || []).map((d) => ({ ...d, at: d.date, signs: (d.fx_signs || []).join(" · "),
      url: `https://find-and-update.company-information.service.gov.uk/company/${d.company_number}/persons-with-significant-control` })),
      ...(data?.news || []).map((a) => ({ kind: a.kind, at: String(a.at).slice(0, 10), company_number: a.company_number, company_name: a.company_name,
        detail: a.detail, signs: a.tracked ? "on your lists" : "", tracked: a.tracked, url: a.url }))]
      // the deal's own sector codes (ownership register pass), else the list row's
      .map((d) => ({ ...d, industry: industryOf(d.sic?.length ? d : byNumber.get(d.company_number) || {}) }));
    return items.filter((d) => !ukNamed(d) && (!filter || (filter === "pe" ? /pe/.test(d.kind) : d.kind === filter)) && (!mine || d.tracked || listed.has(d.company_number)))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }, [data, filter, mine, listed, byNumber]);
  const industryCounts = rows.reduce((c, d) => ({ ...c, [d.industry]: (c[d.industry] || 0) + 1 }), {});
  const shown = industry ? rows.filter((d) => d.industry === industry) : rows;
  if (!data) return <div className="list"><div className="empty">Loading new money…</div></div>;
  const open = (d) => (e) => { if (listed.has(d.company_number) && e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onOpen(d.company_number); } };
  return (
    <div className="list">
      {error && <div className="save-error" role="alert">New money couldn't load ({error}).</div>}
      <div className="filters filings-bar">
        <div className="groups" role="group" aria-label="Kind">
          {MONEY_FILTERS.map(([k, label]) => <button key={k || "all"} aria-pressed={filter === k} className={`grp${filter === k ? " on" : ""}`} onClick={() => setFilter(k)}>{label}</button>)}
        </div>
        <label className="check"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> On my lists only</label>
        <select className="input" value={industry} onChange={(e) => setIndustry(e.target.value)} aria-label="Industry">
          <option value="">Any industry</option>
          {Object.entries(industryCounts).sort((a, b) => b[1] - a[1]).map(([g, n]) => <option key={g} value={g}>{g} ({n})</option>)}
        </select>
        <span className="muted">{shown.length} · ownership register {data.made_at ? `read ${filedWhen(data.made_at.slice(0, 10))}` : "not read yet"} (last {data.window_days || 120} days, with an FX sign)</span>
      </div>
      <div className="sheet-wrap">
        <table className="sheet">
          <thead><tr><th>When</th><th>What</th><th>Company</th><th>Industry</th><th>Detail</th><th>FX sign</th></tr></thead>
          <tbody>
            {shown.slice(0, 500).map((d, i) => (
              <tr key={`${d.kind}:${d.company_number}:${i}`}>
                <td className="num">{d.at ? filedWhen(d.at) : ""}</td>
                <td><span className={`chip${/pe|acquired/.test(d.kind) ? " warn" : ""}`}>{MONEY_KINDS[d.kind] || d.kind}</span></td>
                <td><a href={listed.has(d.company_number) ? companyPath(d.company_number) : chCompanyUrl(d.company_number)} onClick={open(d)}
                       target={listed.has(d.company_number) ? undefined : "_blank"} rel="noreferrer">{d.company_name || d.company_number}</a>
                  {!listed.has(d.company_number) && <span className="muted"> · new lead</span>}</td>
                <td className="muted">{d.industry}</td>
                <td>{d.detail} <a href={d.url} target="_blank" rel="noreferrer" className="muted">{/^news/.test(d.kind) ? "Article ↗" : "Owners ↗"}</a></td>
                <td className="muted">{d.signs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!shown.length && <div className="empty">Nothing yet — the ownership register is read each morning, and the news of funding rounds and PE deals daily.</div>}
    </div>
  );
}

// The lead score as a chip with its reasons on one line (format.js leadScore: LEAD_POINTS).
// The lead score's reasons as bullets: why it fits, why now, and what counts against it (Zac, 15 Nov 2026: "clean up
// the section which justifies why it got that score — bullet points").
function ScoreBreakdown({ r, open = false }) {
  const parts = r.lead_parts || [];
  const groups = [["Fits because", parts.filter(([, p, c]) => p > 0 && c !== "timing")],
                  ["Why now", parts.filter(([, p, c]) => p > 0 && c === "timing")],
                  ["Counts against", parts.filter(([, p]) => p < 0)]].filter(([, g]) => g.length);
  if (!groups.length) return null;
  return (
    <div className={`score-groups${open ? " open" : ""}`}>
      {groups.map(([title, g]) => (
        <div className="score-group" key={title}>
          <h4>{title}</h4>
          <ul>{g.map(([why, p]) => <li key={why}><span className={`lead-p${p < 0 ? " neg" : ""}`}>{p > 0 ? "+" : "−"}{Math.abs(p)}</span>{why}</li>)}</ul>
        </div>
      ))}
    </div>
  );
}

function LeadScore({ r }) {
  if (r.lead_score === undefined) return null;
  const line = leadLine({ score: r.lead_score, fit: r.lead_fit, timing: r.lead_timing, parts: r.lead_parts || [] });
  return (
    <details className="lead-line" title={line}>
      <summary><span className="chip lead-chip">Score {r.lead_score}{r.lead_fit !== undefined ? ` · Fit ${r.lead_fit} · Now ${r.lead_timing}` : ""}</span>
        <span className="muted">Why this score</span></summary>
      <ScoreBreakdown r={r} />
    </details>
  );
}

function CallCard({ r, n, onOpen, onEmail, onContact, checks, onCrm }) {
  const open = (e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onOpen(r.company_number); } };
  return (
    <article className="card loss-card">
      <div className="card-top">
        <div className="card-name">
          <span className="call-n">{n}</span>
          {r.onList
            ? <a className="co" href={companyPath(r.company_number)} onClick={open}>{r.company_name}</a>
            : <a className="co" href={chCompanyUrl(r.company_number)} target="_blank" rel="noreferrer" title="Open on Companies House">{r.company_name}</a>}
          {r.onList ? <span className="chip own">On your Accounts list</span> : <span className="chip">From Recent FX filings</span>}
        </div>
        <div className="loss-fig"><b className="call-turnover">{r.turnover_gbp ? money(r.turnover_gbp) : r.turnover_foreign_gbp ? `≈${money(r.turnover_foreign_gbp)}` : ""}</b><span className="muted">turnover{r.turnover_basis === "group" ? " (group)" : ""}</span></div>
      </div>
      <LeadScore r={r} />
      <ul className="call-why">
        {r.why.map((w) => <li key={w}>{w}</li>)}
      </ul>
      <LeadCheck r={r} checks={checks} onCrm={onCrm} compact />
      <div className="loss-facts">
        {presentedContact(r)
          ? <span><span className="fxl">Ask for</span> {r.finance_contact}{r.finance_contact_role ? ` · ${r.finance_contact_role}` : ""}{r.finance_contact_confidence ? ` (${r.finance_contact_confidence})` : ""}</span>
          : <span><span className="fxl">Ask for</span> {askFor(r).replace(/^Ask for /, "")} <em>— no one confirmed</em> · <a href={r.fd_search_url || googleFd(r)} target="_blank" rel="noreferrer">Google the FD ↗</a></span>}
        {r.incumbent_bank && <span><span className="fxl">Bank</span> {r.incumbent_bank.split(":")[0]}</span>}
        <span><Src href={r.fx_gain_loss_url || r.accounts_url} title="Open the accounts">Accounts ↗</Src></span>
      </div>
      <div className="card-foot">
        {r.onList && <a className="more-btn" href={companyPath(r.company_number)} onClick={open}>Open company page →</a>}
        <EmailButton r={r} onEmail={onEmail} />
        {r.onList && <span className="loss-contacted"><ContactedButton number={r.company_number} name={r.company_name} mark={null} onContact={onContact} /></span>}
      </div>
    </article>
  );
}

// A clean spreadsheet for Cognism's upload (format.js cognismRow): company, domain, postcode, the named finance contact split
// into first / last name, or the role to find. Enrich it in Cognism; nothing comes back here.
function downloadCognism(rows, name) {
  downloadSheet(rows.map(cognismRow), COGNISM_COLUMNS, `${name}-cognism-${new Date().toISOString().slice(0, 10)}.xlsx`, "Cognism");
}

function downloadCognismCompanies(rows, name) {
  downloadSheet(cognismCompanyRows(rows), COGNISM_COMPANY_COLUMNS, `${name}-cognism-companies-${new Date().toISOString().slice(0, 10)}.xlsx`, "Companies");
}

// Figures written as numbers in the spreadsheets (sortable, summable); everything else as text.
const NUMBER_FIELDS = ["rank", "filed_fx_score", "turnover_gbp", "fx_wallet_low_gbp", "fx_wallet_high_gbp", "fx_gain_loss_gbp",
  "fx_gain_loss_prior_gbp", "fx_loss_gbp", "fx_prior_gbp"];

// The lead checklist and every reason not to progress (format.js leadChecklist / reasonsNotToProgress). "CRM checked"
// is Zac's own tick after checking the bank's CRM; nothing from the CRM is kept here. Compact on Call today cards.
const CHECK_MARK = { yes: "✓", no: "✗", check: "?", warn: "!" };
function LeadCheck({ r, checks = {}, onCrm, compact = false }) {
  const items = leadChecklist(r, checks);
  const reasons = reasonsNotToProgress(r);
  const crm = Boolean(checks[r.company_number]?.crm);
  return (
    <div className={`lead-check${compact ? " compact" : ""}`}>
      <ul className="lc-items">
        {items.map((i) => (
          <li key={i.key} className={`lc lc-${i.state}`} title={i.detail}>
            <span className="lc-mark">{CHECK_MARK[i.state]}</span>
            {i.manual && onCrm
              ? <label className="lc-crm"><input type="checkbox" checked={crm} onChange={(e) => onCrm(r.company_number, e.target.checked)} /> {i.label}</label>
              : <span className="lc-l">{i.label}</span>}
            {!compact && <span className="lc-d">{i.detail}</span>}
          </li>
        ))}
      </ul>
      <div className="lc-not">
        <span className="fxl">Reasons not to progress</span>
        {reasons.length
          ? <ul>{reasons.map((x) => <li key={x.text} className={x.serious ? "serious" : ""}>{x.text}</li>)}</ul>
          : <span className="muted"> none found in the records — still check the CRM and ask the questions</span>}
      </div>
    </div>
  );
}

// Today's list for a spreadsheet: the copy-ready company + finance contact first, then why, who and where.
const CALL_EXPORT = ["company_and_fd", "lead_checklist", "reasons_not_to_progress", "rank", "company_name", "company_number", "on_list", "why_today", "turnover_gbp", "filed_fx_score",
  "finance_contact", "finance_contact_role", "finance_contact_confidence", "incumbent_bank", "accounts_url", "companies_house_url", "email_draft"];
function exportCalls(rows, checks) {
  const out = rows.map((r, i) => ({
    company_and_fd: companyAndFd(r), industry: industryOf(r), lead_checklist: checklistLine(leadChecklist(r, checks)),
    reasons_not_to_progress: reasonsNotToProgress(r).map((x) => x.text).join(" | "), rank: i + 1, company_name: r.company_name, company_number: r.company_number,
    on_list: r.onList ? "yes" : "", why_today: r.why.join(" | "), turnover_gbp: r.turnover_gbp || "", filed_fx_score: r.filed_fx_score || "",
    finance_contact: presentedContact(r) ? r.finance_contact : "", finance_contact_role: presentedContact(r) ? r.finance_contact_role || "" : "",
    finance_contact_confidence: presentedContact(r) ? r.finance_contact_confidence || "" : "",
    incumbent_bank: (r.incumbent_bank || "").split(":")[0], accounts_url: r.fx_gain_loss_url || r.accounts_url || "",
    companies_house_url: chCompanyUrl(r.company_number), email_draft: emailDraft(r).text,
  }));
  downloadSheet(out, columnsFor(CALL_EXPORT, { company_and_fd: "Company – Finance Director", turnover_gbp: "Turnover (£)" }, NUMBER_FIELDS),
                `call-today-${new Date().toISOString().slice(0, 10)}.xlsx`, "Call today");
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
          {siteOf(r) && <a className="site" href={siteUrl(siteOf(r))} target="_blank" rel="noreferrer">{siteLabel(siteOf(r))}</a>}
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
          <VerdictButtons number={r.company_number} />
        </div>
      </div>
      <KeyPoints r={r} />
      <ContactLine r={r} />
      {mark && <FollowUpPanel r={r} mark={mark} onContact={onContact} />}
      {(open || note?.text) && <Notes note={note} onSave={onSaveNote} />}
      {open && <>
        <FxStrip r={r} />
        <LeadScore r={r} />
        <Chips r={r} />
        <CallPrep r={r} />
      </>}
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
function CompanyPage({ r, number, madeAt, mark, onContact, note, onSaveNote, onBack, saveError, onEmail, checks, onCrm }) {
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
            {siteOf(r) && <a href={siteUrl(siteOf(r))} target="_blank" rel="noreferrer">{siteLabel(siteOf(r))}</a>}
            <GroupChips r={r} />
            {r.fx_niche && <span>{r.fx_niche}</span>}
          </div>
        </div>
        <ContactedButton number={r.company_number} name={r.company_name} mark={mark} onContact={onContact} />
        <VerdictButtons number={r.company_number} />
      </header>
      {mark && (
        <section className="panel">
          <h2 className="panel-h">Follow-up</h2>
          <FollowUpPanel r={r} mark={mark} onContact={onContact} />
        </section>
      )}

      <FinanceCharts r={r} />

      <section className="panel">
        <h2 className="panel-h">Lead checklist</h2>
        <LeadCheck r={r} checks={checks} onCrm={onCrm} />
      </section>

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

      <section className="panel"><h2 className="panel-h">Key points</h2><KeyPoints r={r} /></section>
      {r.lead_parts?.length > 0 && (
        <section className="panel">
          <h2 className="panel-h">Why it ranks: lead score {r.lead_score}{r.lead_fit !== undefined ? ` · Fit ${r.lead_fit} · Now ${r.lead_timing}` : ""}</h2>
          <ScoreBreakdown r={r} open />
        </section>
      )}
      <OwnershipPanel r={r} />
      <SeatPanel r={r} />
      <PitchPanel r={r} />

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
.alert-banner{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;width:100%;text-align:left;margin:0 0 12px;padding:10px 14px;border-radius:8px;border:1px solid rgba(245,158,11,.25);background:rgba(245,158,11,.06);color:inherit;font:inherit;font-size:13px;cursor:pointer}
.alert-banner.fresh{border-color:rgba(245,158,11,.55);background:rgba(245,158,11,.12)}
.alert-banner b{color:#FBBF24}
.alert-banner .ab-item{color:rgba(255,255,255,.75)}
.alert-banner .ab-go{margin-left:auto;color:#FBBF24}
.outreach-why{margin:8px 0 4px;display:grid;gap:4px;font-size:12.5px}
.outreach-why>div{display:grid;grid-template-columns:150px 1fr;gap:10px}
.outreach-why dt{color:rgba(255,255,255,.5)}
.outreach-why dd{margin:0;color:rgba(255,255,255,.85)}
@media (max-width:640px){.outreach-why>div{grid-template-columns:1fr;gap:0}}
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
.calls-tab{border-color:rgba(245,158,11,.35);color:#FBBF24}
.calls-tab.on{background:rgba(245,158,11,.14);border-color:rgba(245,158,11,.45);color:#FBBF24}
.call-n{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;border-radius:12px;background:rgba(245,158,11,.15);color:#FBBF24;font:700 12px 'Inter',sans-serif;margin-right:8px}
.call-turnover{color:#e5e7eb !important}
.lead-check{margin-top:10px;font-size:13px}
.lc-items{list-style:none;margin:0;padding:0;display:grid;gap:4px}
.lead-check.compact .lc-items{display:flex;flex-wrap:wrap;gap:6px}
.lc{display:flex;gap:8px;align-items:baseline;color:rgba(255,255,255,.8)}
.lead-check.compact .lc{padding:2px 8px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);font-size:12px}
.lc-mark{font-weight:700;width:12px;text-align:center}
.lc-yes .lc-mark{color:#34D399}.lc-no .lc-mark{color:#F87171}.lc-check .lc-mark{color:#A5B4FC}.lc-warn .lc-mark{color:#FBBF24}
.lc-l{white-space:nowrap}.lc-d{color:rgba(255,255,255,.55)}
.lc-crm{display:inline-flex;gap:5px;align-items:center;cursor:pointer;white-space:nowrap}
.lc-not{margin-top:8px}.lc-not ul{margin:4px 0 0;padding-left:18px}.lc-not li{color:rgba(255,255,255,.7)}
.lc-not li.serious{color:#F87171}
.call-why{margin:8px 0 0;padding-left:18px;font-size:13px;color:rgba(255,255,255,.85);line-height:1.5}
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

/* ---- Theme (Nov 2026): clean, dark, spreadsheet-like — neutral greys, gridlines, flat panels, tabular figures ---- */
:root{--bg:#18191b;--surface:#1f2023;--surface-2:#26282b;--head:#232427;--line:#34363a;--line-soft:#2a2c2f;
  --text:#e8eaed;--text-2:#bdc1c6;--muted:#9aa0a6;--accent:#8ab4f8;--series:#3987e5;--gain:#3987e5;--loss:#e66767;
  --good:#81c995;--warn:#fdd663}
body{background:var(--bg);color:var(--text);font-feature-settings:"tnum" 1}
.tb{background:rgba(24,25,27,.96);border-bottom:1px solid var(--line);backdrop-filter:none}
.stats{background:var(--surface);border-bottom:1px solid var(--line)}
.stat{border-right:1px solid var(--line-soft)}
.card,.panel{background:var(--surface);border:1px solid var(--line);border-radius:6px;box-shadow:none}
.card:hover{border-color:#44474c}
.tab{border-radius:4px;border-color:var(--line);color:var(--text-2)}
.tab.on{background:#2d3a4d;border-color:#41546f;color:#d2e3fc}
.chip{border-radius:4px;background:var(--surface-2);color:var(--text-2)}
.input,select.input{background:var(--surface);border-color:var(--line);border-radius:4px;color:var(--text)}
.btn-sm{border-radius:4px;background:var(--surface-2);border-color:var(--line);color:var(--text-2)}
.btn-sm:hover{background:#303236;color:var(--text)}
.verdict{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--text-2)}
.verdict-good{color:var(--good)}
.verdict-not_fit{color:var(--muted)}
.verdict-panel{padding:10px 12px;margin-bottom:10px}
.verdict-tables{display:flex;flex-wrap:wrap;gap:18px;margin-top:8px;font-size:12px}
.verdict-table{min-width:200px}
.btn-link{background:none;border:0;padding:0 2px;color:inherit;text-decoration:underline;cursor:pointer;font-size:12px}
.grp{border-radius:4px}
a{color:var(--accent)}
.muted{color:var(--muted)}
.list{max-width:1480px}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:4px;overflow:hidden}
.seg button{background:none;border:0;padding:6px 12px;color:var(--text-2);font:600 12px 'Inter',sans-serif;cursor:pointer}
.seg button+button{border-left:1px solid var(--line)}
.seg button.on{background:#2d3a4d;color:#d2e3fc}
/* the sheet */
.sheet-wrap{overflow:auto;max-height:calc(100vh - 220px);border:1px solid var(--line);border-radius:4px;background:var(--surface)}
.sheet{border-collapse:separate;border-spacing:0;width:100%;font-size:12.5px}
.sheet th,.sheet td{border-right:1px solid var(--line-soft);border-bottom:1px solid var(--line-soft);padding:6px 10px;text-align:left;
  white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis;color:var(--text)}
.sheet thead th{position:sticky;top:0;z-index:2;background:var(--head);border-bottom:1px solid var(--line);font-weight:600;color:var(--text-2)}
.sheet thead th button{all:unset;cursor:pointer;display:block;width:100%}
.sheet thead th button:hover{color:var(--text)}
.sheet .num{text-align:right;font-variant-numeric:tabular-nums}
.sheet .rownum{position:sticky;left:0;z-index:1;width:38px;min-width:38px;text-align:center;color:var(--muted);background:var(--head);font-size:11px}
.sheet thead .rownum{z-index:3}
.sheet .sticky-col{position:sticky;left:38px;z-index:1;background:var(--surface);font-weight:600;max-width:300px}
.sheet thead .sticky-col{background:var(--head);z-index:3}
.sheet tbody tr:hover td{background:#25272a}
.sheet tbody tr:hover .sticky-col{background:#25272a}
.sheet tr.done td{opacity:.55}
.sheet tr.hot td{background:rgba(253,214,99,.06)}
.sheet td.neg{color:var(--loss)}
.sheet td.pos{color:var(--good)}
.sheet a{color:var(--text);text-decoration:none}
.sheet a:hover{color:var(--accent);text-decoration:underline}
/* finance charts */
.viz-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px 28px}
.viz{margin:0}
.viz figcaption{font:600 13px 'Inter',sans-serif;color:var(--text);margin-bottom:6px}
.viz figcaption span{font-weight:400;color:var(--muted);margin-left:8px;font-size:12px}
.viz-svg{width:100%;height:auto;overflow:visible}
.viz-svg .track{fill:var(--surface-2)}
.viz-svg .band{fill:rgba(57,135,229,.28)}
.viz-svg .marker{fill:var(--series);stroke:var(--surface);stroke-width:2}
.viz-svg .bar,.viz-svg .pos{fill:var(--gain)}
.viz-svg .neg{fill:var(--loss)}
.viz-svg .axis{stroke:#5f6368;stroke-width:1}
.viz-svg text{fill:var(--text-2);font:12px 'Inter',sans-serif}
.viz-svg .val{fill:var(--text);font-variant-numeric:tabular-nums}
.viz-svg .lbl{fill:var(--text);font-weight:600}
.viz-svg .tick{fill:var(--muted);font-size:11px}
@media(max-width:700px){.sheet-wrap{max-height:none}.viz-grid{grid-template-columns:1fr}}
.linkish{background:none;border:0;padding:0;color:var(--accent);cursor:pointer;font:inherit;text-align:left}
.linkish:hover{text-decoration:underline}
.sheet tr.muted-row td{color:var(--muted)}
.lead-line{margin:6px 0;font-size:12px;line-height:1.5;min-width:0}
.lead-line>summary{display:flex;gap:8px;align-items:baseline;cursor:pointer;list-style:none}
.lead-line>summary::-webkit-details-marker{display:none}
.lead-line>summary .muted::after{content:" ▸"}
.lead-line[open]>summary .muted::after{content:" ▾"}
.score-groups{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:4px 16px;margin-top:6px}
.score-group h4{margin:0 0 2px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted, #9aa0a6)}
.score-group ul{margin:0;padding:0;list-style:none}
.score-group li{display:flex;gap:6px;align-items:baseline;padding:1px 0}
.score-groups.open{font-size:13px}
.list-btns{display:inline-flex;flex-wrap:wrap;gap:4px;margin-right:6px}
.list-btns .btn-sm.on,.filters .btn-sm.on{background:rgba(138,180,248,.18);color:var(--accent)}
.pitch-list{margin:0;padding:0;list-style:none;display:grid;gap:10px}
.seq{margin:6px 0;font-size:13px}
.key-points{list-style:none;margin:8px 0;padding:0;display:grid;gap:3px;font-size:13px;line-height:1.45}
.key-points li{display:flex;gap:10px;min-width:0}
.kp-l{flex:none;width:64px;color:var(--muted, #9aa0a6);font-size:11px;text-transform:uppercase;letter-spacing:.04em;padding-top:2px}
.more-detail>summary{cursor:pointer;font-size:12px;color:var(--accent);margin:4px 0}
.seq>summary{cursor:pointer}
.seq-when.overdue{color:var(--loss, #f28b82)}
.seq-when.today{color:var(--accent)}
.seq-steps{list-style:none;margin:6px 0;padding:0;display:grid;gap:2px}
.seq-steps li.done{opacity:.55;text-decoration:line-through}
.seq-steps li.late:not(.done) .seq-due{color:var(--loss, #f28b82)}
.seq-due{display:inline-block;min-width:92px;font-variant-numeric:tabular-nums}
.seq-kind{display:inline-block;min-width:64px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;opacity:.75}
.seq-steps .btn-link{margin-left:8px}
.step-email{margin:6px 0 10px 24px;display:grid;gap:6px;max-width:720px}
.role-pick{margin-left:8px;display:inline-flex;gap:8px;flex-wrap:wrap;font-size:12px}
.call-line{margin:4px 0 6px 24px;font-size:13px}
.today-sec{margin:12px 0}
.step-email textarea{width:100%;font:inherit}
.pitch-list li{line-height:1.45}
.chip.lead-chip{background:rgba(138,180,248,.16);color:var(--accent);font-weight:600;flex:none;font-variant-numeric:tabular-nums}
.lead-parts{list-style:none;margin:0;padding:0;display:grid;gap:4px;font-size:13px}
.lead-p{display:inline-block;min-width:38px;font-weight:600;color:var(--gain);font-variant-numeric:tabular-nums}
.lead-p.neg{color:var(--loss)}
`;
