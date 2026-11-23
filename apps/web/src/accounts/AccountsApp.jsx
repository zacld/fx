import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { FILINGS_SECTION } from "./ranking.js";
import { markSections, matchCompanies, scoreboard, likeGoodLeads, goodLeads, leadProfile, groupActivity, activityLine, FIT, HIDDEN_KINDS, hiddenFromFilters, overseasOps, LEAD_SOURCES, leadSource, reviewLearnings, SIMPLE_COLUMNS, NEW_LEAD_DAYS, addedOn, newLead, TODAYS_LIST, TODAYS_MARKS, todaysList, researchList, markedToday, googleCompany, FRESH_DAYS, FRESH_KINDS, QUIET_SOURCES, freshFind, setKnownLei, setKnownOwnerSearch, setKnownParents, foreignOwned, elsewhere, keyPoints, ownership, OWNERSHIP_LABEL, financeSeat, ukNamed, timelyReason, filedIso, leadLine, setKnownSites, setKnownSignals, movesByCurrency, outreachPlan, outreachWhyLine, letterAddressee, OUTREACH, siteOf, setKnownGroups, groupOf, groupName, peBackedOf, industryOf, INDUSTRIES, collapseGroups, nicheTiers, withLeadScores, SHEET_COLUMNS, SIZE_SCALE, parseMoney, regionBars, sizePosition, turnoverYears, COGNISM_COLUMNS, COGNISM_COMPANY_COLUMNS, cognismCompanyRows, EXPORT_FIELDS, cognismRow, checklistLine, leadChecklist, reasonsNotToProgress, CALL_RULES, CALL_TODAY_MAX, callToday, companyAndFd, searchAllowance, statusLines, LOSS_SORTS, filterLosses, lossGrew, lossRows, sortLosses, CONTACT_GROUPS, ROLE_GROUPS, SORTS, askFor, chCompanyUrl, monthLabel, filedWhen, filingRow, filterFilings, sortFilings, isGroupFiling, turnoverSearch, fxFacts, fxGroup, fxScore, companyPath, contactClues, presentedContact, detailSections, numberFromPath, roleGroup, sourceDocuments, bankUrl, contactGroup, factUrl, filterRows, fxShare, googleFd, isNew, isOut, money, parts, sortRows, wallet } from "./format.js";
import { pitchFor, pitchLine } from "./pitch.js";
import { TEMPLATES, fillTemplate, stepTemplate } from "./templates.js";
import { GRID_COLUMNS, ROLES, SEQUENCE, START_PER_DAY, callScript, gridCells, nextStep, plan, sequenceRank, todayQueue } from "./sequence.js";
import { firstName } from "./email.js";
import { columnsFor, downloadSheet } from "./xlsx.js";
import { emailDraft } from "./email.js";
import { VERDICT_REASONS, applyEmail } from "../../api/accounts.mjs";
import { CHANNELS, RESPONSES, STATES, applyContact, followUp, sortFollowUps, touchesOf } from "./followups.js";
import { OUTCOMES, dayReport, dayWrap, depthTables, localDay, outcomeLabel, reportHtml, reportMarkdown, shiftDay, siteHref, wrapText } from "./wrapped.js";

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
          {data && <FeedButton password={password} />}
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
  // Zac's own marks (verdicts, the Simplified dash's review buttons): read by the lead score's feedback loop
  const [verdicts, setVerdicts] = useState(data.verdicts || {});
  const [checks, setChecks] = useState(data.checks || {});
  const reviews = useMemo(() => reviewLearnings(baseRows, checks, verdicts), [baseRows, checks, verdicts]);
  // lookalikes by profile: the unmarked leads most like the ones Zac marked good
  const likes = useMemo(() => likeGoodLeads(baseRows, checks, verdicts), [baseRows, checks, verdicts]);
  const leadCtx = useMemo(() => ({ niches: nicheTiers(signals.niches), signals: signals.signals || {}, moves, madeAt: data.made_at, reviews, likes }),
                          [signals, moves, data.made_at, reviews, likes]);
  // Zac's Good lead / Not a fit verdicts: declared before the rows that read them
  const [lists, setLists] = useState(data.lists || {});   // Zac's call / chocolate-mailing / email lists
  const allRows = useMemo(() => withLeadScores(baseRows.map((r) => (verdicts[r.company_number]?.verdict === "not_fit"
    ? { ...r, qualified: "Out", qualify_reason: `Not a fit: ${verdicts[r.company_number].reason || "your review"}` } : r)), leadCtx),
  [baseRows, leadCtx, verdicts]);
  // Companies with "UK" in the name live in their own tab only (contacted ones stay in Contacted).
  const ukRows = useMemo(() => allRows.filter(ukNamed), [allRows]);
  // Owned from abroad (an American parent, a German group …): their own tab too (Zac, 16 Nov 2026: "if it's owned by an
  // American company or something like that put it in a different section"); `signals` brings the owner search's answers
  const markedAbroad = (r) => checks[r.company_number]?.review === "abroad";   // Zac's own "Owned abroad" button
  const foreignRows = useMemo(() => allRows.filter((r) => !ukNamed(r) && (foreignOwned(r) || markedAbroad(r))), [allRows, signals, checks]);   // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => allRows.filter((r) => (!elsewhere(r) && !markedAbroad(r)) || contacted[r.company_number]), [allRows, contacted, signals, checks]);   // eslint-disable-line react-hooks/exhaustive-deps
  // The section of tabs shown (TAB_SECTIONS): remembered; a phone with none remembered opens on Today
  const [tabSection, setTabSection] = useState(() => {
    try { const v = localStorage.getItem("fx-tab-section"); if (TAB_SECTIONS.some(([k]) => k === v)) return v; } catch { /* storage off */ }
    return typeof window !== "undefined" && window.innerWidth < 700 ? "today" : "all";
  });
  // Fresh finds: the leads he hasn't marked yet (contacted, a review button or a verdict take a lead out of it)
  const freshRows = useMemo(() => rows.filter((r) => !contacted[r.company_number] && !checks[r.company_number]?.review && !verdicts[r.company_number]?.verdict),
                            [rows, contacted, checks, verdicts]);
  const [filters, setFilters] = useState({ section: "", view: tabSection === "all" ? "" : TAB_SECTIONS.find(([k]) => k === tabSection)[2][0], query: "", contact: "", role: "", fdOnly: false, pair: "",
                                            triggersOnly: false, showOut: false, newOnly: false, fxLossOnly: false, oneGroup: true,
                                            peOnly: false, opsOnly: false, newFdOnly: false, industry: "", ownership: "", lookalikeOnly: false });
  const [sort, setSort] = useState("lead");
  // Sheet (a dense, sortable grid) or Cards; remembered in this browser
  const [layout, setLayout] = useState(() => { try { return localStorage.getItem("fx-layout") || "sheet"; } catch { return "sheet"; } });
  const pickLayout = (v) => { setLayout(v); try { localStorage.setItem("fx-layout", v); } catch { /* storage off */ } };
  const [shown, setShown] = useState(PAGE);
  const [notes, setNotes] = useState(data.notes || {});
  const [saveError, setSaveError] = useState("");
  const set = (patch) => { setFilters((f) => ({ ...f, ...patch })); setShown(PAGE); };
  const [finishing, setFinishing] = useState(false);   // "Finish day" pressed on Today's list: Your day opens on its report
  const pickSection = (k) => {
    setTabSection(k);
    try { localStorage.setItem("fx-tab-section", k); } catch { /* storage off */ }
    const views = TAB_SECTIONS.find(([x]) => x === k)[2];
    if (views && !views.includes(filters.view)) set({ section: "", view: views[0] });
  };
  // a tab in another section (a stat, the alert banner, a link) brings its section along
  useEffect(() => {
    if (tabSection !== "all" && sectionOf(filters.view) !== tabSection) setTabSection(sectionOf(filters.view));
  }, [filters.view]);   // eslint-disable-line react-hooks/exhaustive-deps
  const inTabs = (view) => tabSection === "all" || TAB_SECTIONS.find(([k]) => k === tabSection)[2].includes(view);
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
  // Today's list and Your day are the whole screen, on white: no top bar (logo, Market moves, Event leads, feed, Lock) —
  // Zac, 23 Nov 2026: "remove the bar at the top", "make the page white"
  useEffect(() => {
    document.body.classList.toggle("daily-view", ["daily", "wrapped"].includes(filters.view) && !pageNo);
    return () => document.body.classList.remove("daily-view");
  }, [filters.view, pageNo]);
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
    setChecks((c) => { const next = { ...c, [number]: { ...(c[number] || {}) } }; if (value) next[number].crm = new Date().toISOString(); else delete next[number].crm; return next; });
    try { await save(number, { crm_checked: value }); } catch (e) {
      setChecks(before);
      setSaveError(`Couldn't save the CRM tick (${e.message}).`);
    }
  }, [save, checks]);

  // The Simplified dash's buttons — Open lead / Added to mine / Owned abroad (one at a time; again clears it). Owned abroad
  // moves the company to the Foreign-owned tab. Shown at once, undone if the save fails.
  const setReview = useCallback(async (number, review) => {
    setSaveError("");
    const before = checks;
    const value = checks[number]?.review === review ? null : review;
    setChecks((c) => { const e = { ...(c[number] || {}) }; if (value) { e.review = value; e.review_at = new Date().toISOString(); } else { delete e.review; delete e.review_at; } return { ...c, [number]: e }; });
    try { await save(number, { review: value }); } catch (e) {
      setChecks(before);
      setSaveError(`Couldn't save that (${e.message}).`);
    }
  }, [save, checks]);

  // Many at once (the Scoreboard's paste box): one bulk save (POST {marks}) — saving them one by one lost marks, each
  // save reading the store before the last one's write had reached it. Sets marks, never toggles one off.
  const markMany = useCallback(async (items) => {
    setSaveError("");
    const todo = items.filter(({ number, mark }) => (mark.review ? checks[number]?.review !== mark.review
      : !(verdicts[number]?.verdict === mark.verdict && (verdicts[number]?.reason || "") === (mark.reason || ""))));
    if (!todo.length) return { saved: 0, already: items.length, failed: 0 };
    const res = await fetch(API, { method: "POST", headers: { authorization: `Bearer ${password}`, "content-type": "application/json" },
      body: JSON.stringify({ marks: todo.map(({ number, mark }) => ({ company_number: number, ...mark })) }) }).catch(() => null);
    const got = res && (await res.json().catch(() => null));
    if (!res?.ok || !got) {
      setSaveError(`The marks didn't save (${got?.error || (res ? res.status : "no connection")}) — try again.`);
      return { saved: 0, already: items.length - todo.length, failed: todo.length };
    }
    setChecks(got.checks || {});
    setVerdicts(got.verdicts || {});
    return { saved: todo.length, already: items.length - todo.length, failed: 0 };
  }, [password, checks, verdicts]);

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
  const rowsByNumber = useMemo(() => new Map(allRows.filter((r) => !r.dropped).map((r) => [r.company_number, r])), [allRows]);
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
    const out = visible.map((r) => ({ ...r, company_and_fd: companyAndFd(r), industry: industryOf(r), hidden_from_filters: hiddenFromFilters(r).map((h) => h.text).join("; "), finance_decided: financeSeat(r).verdict, ...(() => { const o = ownership(r); return { ownership: OWNERSHIP_LABEL[o.status], ultimate_owner: o.owner, owner_country: o.country }; })(), what_to_pitch: pitchLine(r), my_list: LIST_NAMES[lists[r.company_number]?.list] || "",
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
      {/* Today's list starts straight at the sections (Zac, 23 Nov 2026: "when on this page remove the banner at top") */}
      {!["daily", "wrapped"].includes(filters.view) && <>
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
      </>}

      <div className="controls">
        <nav className="sections" aria-label="Sections">
          {TAB_SECTIONS.map(([k, label]) => (
            <button key={k} aria-pressed={tabSection === k} className={`section-btn${tabSection === k ? " on" : ""}`} onClick={() => pickSection(k)}>{label}</button>
          ))}
        </nav>
        <div className="tabs" role="tablist">
          <button role="tab" hidden={!inTabs("daily")} aria-selected={filters.view === "daily"} className={`tab daily-tab${filters.view === "daily" ? " on" : ""}`}
                  title="The best-ranked leads you haven't marked: Google it, check for the FD, then ✓ good lead / ✕ not enough revenue / ● open lead / ☎ call list"
                  onClick={() => set({ section: "", view: "daily" })}>
            Today's list
          </button>
          <button role="tab" hidden={!inTabs("wrapped")} aria-selected={filters.view === "wrapped"} className={`tab${filters.view === "wrapped" ? " on" : ""}`}
                  title="Your day, Wrapped-style: how many leads you looked through, how you marked them, the sectors that worked and didn't, your pace"
                  onClick={() => set({ section: "", view: "wrapped" })}>
            Your day
          </button>
          <button role="tab" hidden={!inTabs("outreach")} aria-selected={filters.view === "outreach"} className={`tab outreach-tab${filters.view === "outreach" ? " on" : ""}`}
                  title={`The top ${OUTREACH.letters} for the Investec letter, then the rest: cold call (something timely to say) or email sequence`}
                  onClick={() => set({ section: "", view: "outreach" })}>
            Outreach <span className="tab-n">{OUTREACH.letters}</span>
          </button>
          <button role="tab" hidden={!inTabs("alerts")} aria-selected={filters.view === "alerts"} className={`tab alerts-tab${filters.view === "alerts" ? " on" : ""}`}
                  title="New finance directors, refinancing, new owners, charges to FX providers — from Companies House, every 3 hours"
                  onClick={() => set({ section: "", view: "alerts" })}>
            Alerts
          </button>
          <button role="tab" hidden={!inTabs("hits")} aria-selected={filters.view === "hits"} className={`tab hits-tab${filters.view === "hits" ? " on" : ""}`}
                  title="Filed lately with an FX loss — and a new finance director, buying companies or a private-equity deal"
                  onClick={() => set({ section: "", view: "hits" })}>
            Hit list <span className="tab-n">{open.filter((r) => r.lead_flags?.hit && !isOut(r)).length}</span>
          </button>
          <button role="tab" hidden={!inTabs("today")} aria-selected={filters.view === "today"} className={`tab${filters.view === "today" ? " on" : ""}`}
                  title="The day's sequence work across your lists: calls, emails, LinkedIn, and the companies to start today"
                  onClick={() => set({ section: "", view: "today" })}>
            Today <span className="tab-n">{todayDue}</span>
          </button>
          {Object.entries(LIST_NAMES).map(([key, name]) => (
            <button key={key} role="tab" hidden={!inTabs(`list-${key}`)} aria-selected={filters.view === `list-${key}`} className={`tab${filters.view === `list-${key}` ? " on" : ""}`}
                    title={`Your ${name.toLowerCase()} — sent here from any card's “+ ${name}” button`}
                    onClick={() => set({ section: "", view: `list-${key}` })}>
              {name} <span className="tab-n">{Object.values(lists).filter((v) => v.list === key).length}</span>
            </button>
          ))}
          <button role="tab" hidden={!inTabs("research")} aria-selected={filters.view === "research"} className={`tab${filters.view === "research" ? " on" : ""}`}
                  title="Good leads with no contact info yet — marked ? on Today's list"
                  onClick={() => set({ section: "", view: "research" })}>
            Research harder <span className="tab-n">{researchList(allRows, { checks, lists, contacted }).length}</span>
          </button>
          <button role="tab" hidden={!inTabs("simple")} aria-selected={filters.view === "simple"} className={`tab${filters.view === "simple" ? " on" : ""}`}
                  title="The same leads as a plain P&L-style sheet: company, Companies House number, type of company and the filed figures"
                  onClick={() => set({ section: "", view: "simple" })}>
            Simplified dash
          </button>
          <button role="tab" hidden={!inTabs("fresh")} aria-selected={filters.view === "fresh"} className={`tab${filters.view === "fresh" ? " on" : ""}`}
                  title="Leads few bankers have seen, in one list: new on the lists, found by a job advert / your niche search / a lookalike / an emerging niche, or hidden from the usual filters — not marked yet"
                  onClick={() => set({ section: "", view: "fresh" })}>
            Fresh finds <span className="tab-n">{freshRows.filter((r) => !isOut(r) && !r.dropped && freshFind(r).length).length}</span>
          </button>
          <button role="tab" hidden={!inTabs("new")} aria-selected={filters.view === "new"} className={`tab${filters.view === "new" ? " on" : ""}`}
                  title="Companies that joined the lists in the last 7 days (the finder's new finds and fresh FX filings), best lead score first"
                  onClick={() => set({ section: "", view: "new" })}>
            New leads <span className="tab-n">{rows.filter((r) => !contacted[r.company_number] && !isOut(r) && newLead(r, 7)).length}</span>
          </button>
          <button role="tab" hidden={!inTabs("hidden")} aria-selected={filters.view === "hidden"} className={`tab${filters.view === "hidden" ? " on" : ""}`}
                  title="Companies a standard Zint / Market IQ search can't see — and why" onClick={() => set({ section: "", view: "hidden" })}>
            Hidden from filters <span className="tab-n">{rows.filter((r) => !contacted[r.company_number] && !isOut(r) && hiddenFromFilters(r).length).length}</span>
          </button>
          <button role="tab" hidden={!inTabs("foreign")} aria-selected={filters.view === "foreign"} className={`tab${filters.view === "foreign" ? " on" : ""}`}
                  title="Owned by a company or person abroad (the accounts, the LEI register, Companies House or the owner search say so) — kept here, out of every other list"
                  onClick={() => set({ section: "", view: "foreign" })}>
            Foreign-owned <span className="tab-n">{foreignRows.filter((r) => !contacted[r.company_number] && !isOut(r)).length}</span>
          </button>
          <button role="tab" hidden={!inTabs("uk")} aria-selected={filters.view === "uk"} className={`tab${filters.view === "uk" ? " on" : ""}`}
                  title="Companies with “UK” in their name — usually a foreign group's UK arm; kept here, out of every other list"
                  onClick={() => set({ section: "", view: "uk" })}>
            UK in name <span className="tab-n">{ukRows.filter((r) => !contacted[r.company_number] && !isOut(r)).length}</span>
          </button>
          <button role="tab" hidden={!inTabs("fit")} aria-selected={filters.view === "fit"} className={`tab${filters.view === "fit" ? " on" : ""}`}
                  title={`The right companies, whatever the news: FX proof and FX pain, £20m–£300m, a good niche, ownership — Fit ${FIT.min}+, best first`}
                  onClick={() => set({ section: "", view: "fit" })}>
            Best fit <span className="tab-n">{open.filter((r) => (r.lead_fit || 0) >= FIT.min && !isOut(r)).length}</span>
          </button>
          <button role="tab" hidden={!inTabs("now")} aria-selected={filters.view === "now"} className={`tab${filters.view === "now" ? " on" : ""}`}
                  title={`Companies that fit (Fit ${FIT.min}+) with a reason to call now — a new FD, a deal, funding, a fresh filing, a customs or bank change — most timely first`}
                  onClick={() => set({ section: "", view: "now" })}>
            Call now <span className="tab-n">{open.filter((r) => (r.lead_fit || 0) >= FIT.min && (r.lead_timing || 0) > 0 && !isOut(r)).length}</span>
          </button>
          <button role="tab" hidden={!inTabs("shy")} aria-selected={filters.view === "shy"} className={`tab${filters.view === "shy" ? " on" : ""}`}
                  title="Sectors payment firms often won't take — scrap, bullion, mining, waste, fuel, vehicles, tobacco… where a bank can win"
                  onClick={() => set({ section: "", view: "shy" })}>
            Hard to broker <span className="tab-n">{open.filter((r) => ranked.shy_of?.[r.company_number] && !isOut(r)).length}</span>
          </button>
          <button role="tab" hidden={!inTabs("money")} aria-selected={filters.view === "money"} className={`tab money-tab${filters.view === "money" ? " on" : ""}`}
                  title="Just bought by private equity, buying companies, just funded, a new overseas owner"
                  onClick={() => set({ section: "", view: "money" })}>
            New money
          </button>
          <button role="tab" hidden={!inTabs("calls")} aria-selected={filters.view === "calls"} className={`tab calls-tab${filters.view === "calls" ? " on" : ""}`}
                  title={`Today's ${CALL_TODAY_MAX}: £20m–£300m, strong FX proof, a recent FX loss or a trigger — confirmed contacts first`}
                  onClick={() => set({ section: "", view: "calls" })}>
            Call today
          </button>
          {["", ...(data.sections || []), ...(ranked.rows?.length ? [FILINGS_SECTION] : [])].map((s) => {
            const on = !filters.view && filters.section === s;
            return (
              <button key={s || "all"} role="tab" hidden={tabSection !== "all"} aria-selected={on} className={`tab${on ? " on" : ""}`}
                      onClick={() => set({ section: s, view: "" })}>
                {s || "All"} <span className="tab-n">{s ? open.filter((r) => r.section === s).length : open.length}</span>
              </button>
            );
          })}
          <button role="tab" hidden={!inTabs("contacted")} aria-selected={filters.view === "contacted"} className={`tab contacted-tab${filters.view === "contacted" ? " on" : ""}`}
                  onClick={() => set({ section: "", view: "contacted" })}>
            Contacted <span className="tab-n">{contactedCount}</span>
            {followUpsDue > 0 && <span className="due-n" title="Follow-ups due today or overdue">{followUpsDue} due</span>}
          </button>
          <button role="tab" hidden={!inTabs("filings")} aria-selected={filters.view === "filings"} className={`tab filings-tab${filters.view === "filings" ? " on" : ""}`}
                  title="Companies of £20m+ whose newly filed accounts show FX" onClick={() => set({ section: "", view: "filings" })}>
            Recent FX filings
          </button>
          <button role="tab" hidden={!inTabs("losses")} aria-selected={filters.view === "losses"} className={`tab losses-tab${filters.view === "losses" ? " on" : ""}`}
                  title="Companies whose latest accounts show a loss on currency" onClick={() => set({ section: "", view: "losses" })}>
            FX losses
          </button>
          <button role="tab" hidden={!inTabs("niches")} aria-selected={filters.view === "niches"} className={`tab niches-tab${filters.view === "niches" ? " on" : ""}`}
                  title="Which niches prove FX most often, and how their leads score" onClick={() => set({ section: "", view: "niches" })}>
            Niches
          </button>
          <button role="tab" hidden={!inTabs("search")} aria-selected={filters.view === "search"} className={`tab niches-tab${filters.view === "search" ? " on" : ""}`}
                  title="Type a product or trade — every UK company whose customs records show it trading those goods" onClick={() => set({ section: "", view: "search" })}>
            Niche search
          </button>
          <button role="tab" hidden={!inTabs("emerging")} aria-selected={filters.view === "emerging"} className={`tab niches-tab${filters.view === "emerging" ? " on" : ""}`}
                  title="Every full / medium / group-accounts company in this week's emerging niches — check them off" onClick={() => set({ section: "", view: "emerging" })}>
            Emerging leads
          </button>
          <button role="tab" hidden={!inTabs("scoreboard")} aria-selected={filters.view === "scoreboard"} className={`tab niches-tab${filters.view === "scoreboard" ? " on" : ""}`}
                  title="Where your good leads come from — by source, niche and industry — and the leads like them" onClick={() => set({ section: "", view: "scoreboard" })}>
            Scoreboard
          </button>
          <button role="tab" hidden={!inTabs("jobs")} aria-selected={filters.view === "jobs"} className={`tab niches-tab${filters.view === "jobs" ? " on" : ""}`}
                  title="Employers whose job adverts name currency work, trade roles, treasury or a new finance director — most not on anyone's list" onClick={() => set({ section: "", view: "jobs" })}>
            Job adverts
          </button>
          <button role="tab" hidden={!inTabs("email")} aria-selected={filters.view === "email"} className={`tab email-tab${filters.view === "email" ? " on" : ""}`}
                  title="The Investec email for each company you send here" onClick={() => set({ section: "", view: "email" })}>
            Email generator <span className="tab-n">{emailItems.length}</span>
          </button>
        </div>
        {!["daily", "wrapped", "research", "fresh", "filings", "email", "losses", "calls", "alerts", "niches", "search", "emerging", "jobs", "scoreboard", "hits", "money", "shy", "outreach", "fit", "now", "uk", "foreign", "today", "new", "hidden", "simple"].includes(filters.view) && !filters.view?.startsWith("list-") && <>
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
          <label className="check" title="Subsidiaries in an offshore hub (Poland, India, the Philippines, South Africa …) or a job advert naming a team or payroll abroad: monthly payroll and supplier payments in another currency"><input type="checkbox" checked={filters.opsOnly} onChange={(e) => set({ opsOnly: e.target.checked })} /> Teams abroad</label>
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

      {filters.view === "daily" ? <TodaysList rows={rows} contacted={contacted} checks={checks} verdicts={verdicts} lists={lists} onOpen={openCompany}
                                              setVerdict={setVerdict} setReview={setReview} setList={setList} notes={notes} saveNote={saveNote}
                                              onWrap={() => set({ section: "", view: "wrapped" })}
                                              onFinish={() => { setFinishing(true); set({ section: "", view: "wrapped" }); }} />
       : filters.view === "wrapped" ? <YourDay rows={allRows} contacted={contacted} checks={checks} verdicts={verdicts} lists={lists} notes={notes}
                                              onOpen={openCompany} onBack={() => set({ section: "", view: "daily" })}
                                              startReport={finishing} onReportClosed={() => setFinishing(false)} />
       : filters.view === "research" ? <ResearchHarder rows={allRows} contacted={contacted} checks={checks} lists={lists} onOpen={openCompany}
                                              setVerdict={setVerdict} setReview={setReview} setList={setList} notes={notes} saveNote={saveNote} />
       : filters.view === "outreach" ? <Outreach rows={rows} contacted={contacted} password={password} onOpen={openCompany} onContact={contact} onEmail={toEmail} />
       : filters.view === "hits" ? <HitList rows={open} onOpen={openCompany} onContact={contact} onEmail={toEmail} />
       : filters.view?.startsWith("list-") ? <MyLists which={filters.view.slice(5)} rows={allRows} lists={lists} onOpen={openCompany} onContact={contact} onEmail={toEmail} />
       : filters.view === "today" ? <Today rows={allRows} lists={lists} onOpen={openCompany} />
       : filters.view === "simple" ? <SimpleDash rows={[...rows, ...allRows.filter((r) => markedAbroad(r) && !elsewhere(r) && !contacted[r.company_number])]} onOpen={openCompany} contacted={contacted} checks={checks} onReview={setReview} reviews={reviews} />
       : filters.view === "fresh" ? <FitTiming mode="fresh" rows={freshRows} onOpen={openCompany} onContact={contact} onEmail={toEmail}
                                               links={<>Also: <button className="linkish" onClick={() => set({ section: "", view: "jobs" })}>Job adverts</button> · <button className="linkish" onClick={() => set({ section: "", view: "emerging" })}>Emerging leads</button> · <button className="linkish" onClick={() => set({ section: "", view: "search" })}>Niche search</button></>} />
       : filters.view === "hidden" ? <FitTiming mode="hidden" rows={rows.filter((r) => !contacted[r.company_number])} onOpen={openCompany} onContact={contact} onEmail={toEmail} />
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
                                             headings={signals.headings || []} codes={signals.codes || []} onPick={(name) => set({ section: "", view: "", query: name })} />
       : filters.view === "scoreboard" ? <Scoreboard rows={allRows} checks={checks} verdicts={verdicts} likes={likes} onOpen={openCompany} onMarkMany={markMany}
                                                     onPick={(name) => set({ section: "", view: "", query: name })} />
       : filters.view === "jobs" ? <JobAdverts password={password} rowsByNumber={rowsByNumber} onOpen={openCompany} checks={checks} onReview={setReview} />
       : filters.view === "emerging" ? <EmergingLeads password={password} listed={listedNumbers} onOpen={openCompany} checks={checks} onReview={setReview} />
       : filters.view === "search" ? <NicheSearch password={password} listed={listedNumbers} onOpen={openCompany} />
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
      {overseasOps(r) && <span className="chip" title="Payroll and supplier payments abroad every month">Teams abroad: {overseasOps(r).text}</span>}
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
function SheetView({ rows, onOpen, contacted, columns = SHEET_COLUMNS, actions = null }) {
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
              <Fragment key={k}>
                <th className={`${num ? "num" : ""}${k === "company" ? " sticky-col" : ""}`} aria-sort={by === k ? (desc ? "descending" : "ascending") : "none"}>
                  <button onClick={() => sortBy(k)}>{header}{by === k ? (desc ? " ▾" : " ▴") : ""}</button>
                </th>
                {actions && actions.after === k && <th className="actions-col">{actions.header}</th>}
              </Fragment>
            ))}
            {actions && !actions.after && <th className="actions-col">{actions.header}</th>}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={r.company_number || i} className={contacted[r.company_number] ? "done" : ""}>
              <td className="rownum">{i + 1}</td>
              {columns.map(([k, , value, , num]) => {
                const v = value(r);
                const cell = k === "company"
                  ? <td className="sticky-col"><a href={companyPath(r.company_number)} onClick={open(r.company_number)}>{v}</a></td>
                  : <td className={`${num ? "num" : ""}${(k === "fxloss" || k === "fx") && Number(r.fx_gain_loss_gbp) < 0 ? " neg" : ""}${(k === "fxloss" || k === "fx") && Number(r.fx_gain_loss_gbp) > 0 ? " pos" : ""}`}
                        title={typeof v === "string" && v.length > 28 ? v : undefined}>{v}</td>;
                return <Fragment key={k}>{cell}{actions && actions.after === k && <td className="actions-col">{actions.cell(r)}</td>}</Fragment>;
              })}
              {actions && !actions.after && <td className="actions-col">{actions.cell(r)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The Simplified dash: the Accounts list's own leads (not contacted, not out — the same filtering, nothing re-scored)
// as a P&L-style sheet with a search, an industry filter and an Excel export of exactly what's shown.
const REVIEW_BUTTONS = [["open", "Open lead", "Checked: nobody has it — a lead to work"], ["mine", "Added to mine", "Added to your own book"],
  ["abroad", "Owned abroad", "Owned from abroad — moves it to the Foreign-owned tab"],
  ["skip", "Skipped", "Taken off with no reason kept (for one the bank already has: which ones never comes onto the site)"],
  ["research", "Research harder", "A good lead with no contact info yet — on the Research harder list"]];
// What Zac's own checks are teaching the lead score (the feedback loop, `reviewLearnings`): good-lead rate by source,
// niche and industry, and the lean each gets once 5+ are marked.
function ReviewLearnings({ reviews }) {
  if (!reviews?.reviewed) return <p className="filings-note">As you mark companies Open lead, Added to mine or Owned abroad, this shows which sources and niches give genuinely open leads — and the lead score leans towards them once 5+ in a group are marked.</p>;
  const table = (title, list) => list.length > 0 && (
    <div className="verdict-table"><b>{title}</b>
      {list.slice(0, 6).map((g) => (
        <div key={g.key}><span className="num">{g.good_share}%</span> good ({g.good}/{g.reviewed}) · {g.key}
          {g.points ? <span className={`chip${g.points < 0 ? " warn" : ""}`}>{g.points > 0 ? "+" : ""}{g.points} to its leads</span> : null}</div>))}
    </div>);
  return (
    <div className="panel verdict-panel">
      <b>What your checks are teaching the score: {reviews.reviewed} marked</b>
      <span className="muted"> — good = Open lead, Added to mine or Good lead; not = Owned abroad or Not a fit. Only your clicks here, nothing from the CRM.</span>
      <div className="verdict-tables">{table("By source", reviews.source)}{table("By niche", reviews.niche)}{table("By industry", reviews.industry)}</div>
    </div>
  );
}

function SimpleDash({ rows, onOpen, contacted, checks = {}, onReview, reviews }) {
  const [review, setReview] = useState("none");   // "none" = the main sheet (not marked yet); else that button's own list
  const [query, setQuery] = useState("");
  const [industry, setIndustry] = useState("");
  const base = useMemo(() => rows.filter((r) => !contacted[r.company_number] && !isOut(r) && !r.dropped)
    .sort((a, b) => (b.lead_score || 0) - (a.lead_score || 0)), [rows, contacted]);
  const counts = {};
  for (const r of base) { const k = industryOf(r); counts[k] = (counts[k] || 0) + 1; }
  const q = query.trim().toLowerCase();
  const reviewOf = (r) => checks[r.company_number]?.review || "";
  const reviewed = (k) => base.filter((r) => reviewOf(r) === k).length;
  const list = base.filter((r) => (!industry || industryOf(r) === industry)
    && (review === "none" ? !reviewOf(r) : reviewOf(r) === review)
    && (!q || `${r.company_name} ${r.company_number}`.toLowerCase().includes(q)));
  const exportList = () => downloadSheet(list.map((r) => ({ ...Object.fromEntries(SIMPLE_COLUMNS.map(([k, , , , , out]) => [k, out(r)])),
    review: (REVIEW_BUTTONS.find(([k]) => k === reviewOf(r)) || [])[1] || "" })),
    [...SIMPLE_COLUMNS.map(([k, header, , , numeric]) => ({ key: k, header, number: Boolean(numeric) && !["growth", "margin"].includes(k) })),
     { key: "review", header: "Status" }],
    `simplified-dash-${review === "none" ? "to-check" : review}-${new Date().toISOString().slice(0, 10)}.xlsx`, "Simplified dash");
  return (
    <div className="list">
      <ReviewLearnings reviews={reviews} />
      <div className="filters filings-bar review-lists" role="tablist" aria-label="Simplified dash lists">
        {[["none", "To check", base.length - reviewed("open") - reviewed("mine") - reviewed("abroad")],
          ...REVIEW_BUTTONS.map(([k, label]) => [k, label, reviewed(k)])].map(([k, label, n]) => (
          <button key={k} role="tab" aria-selected={review === k} className={`tab${review === k ? " on" : ""}`} onClick={() => setReview(k)}>
            {label} <span className="tab-n">{n}</span>
          </button>
        ))}
      </div>
      <div className="filters filings-bar">
        <input type="search" placeholder="Search company or number" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search" />
        <select value={industry} onChange={(e) => setIndustry(e.target.value)} aria-label="Type of company">
          <option value="">Any type of company ({base.length})</option>
          {Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => <option key={k} value={k}>{k} ({n})</option>)}
        </select>
        <span className="muted">{review === "none"
          ? `${list.length} companies to check · a button moves the company to its own list`
          : `${list.length} companies · click the lit button to send one back to To check`} · figures from their latest filed accounts</span>
        <button className="btn-sm export" onClick={exportList} disabled={!list.length}>Export Excel ({list.length})</button>
      </div>
      <SheetView rows={list} onOpen={onOpen} contacted={contacted} columns={SIMPLE_COLUMNS} actions={{
        header: "Status",
        after: "number",
        cell: (r) => (
          <span className="review-btns">
            {REVIEW_BUTTONS.map(([k, label, hint]) => (
              <button key={k} className={`btn-sm review-${k}${reviewOf(r) === k ? " on" : ""}`} title={reviewOf(r) === k ? "Click again to clear" : hint}
                      aria-pressed={reviewOf(r) === k} onClick={() => onReview(r.company_number, k)}>{label}</button>
            ))}
          </span>
        ),
      }} />
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

function Niches({ measured, madeAt, learned, headings, codes = [], onPick, verdicts }) {
  const [by, setBy] = useState("score");
  const [onlyEmerging, setOnlyEmerging] = useState(false);
  const learnedBy = Object.fromEntries(learned.map((n) => [n.niche, n]));
  const isEmerging = (m) => String(m.kind || "").startsWith("emerging");
  const all = Object.values(measured).filter((m) => m?.name);
  const rows = all.filter((m) => !onlyEmerging || isEmerging(m)).map((m) => ({ ...m, ...(learnedBy[m.name] || {}) }));
  const emergingCount = all.filter(isEmerging).length;
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
        <label className="check" title="Customs goods and sectors no niche covered, found by this week's measuring because their companies prove FX as often as a good niche — the finder searches them until they stop hitting">
          <input type="checkbox" checked={onlyEmerging} onChange={(e) => setOnlyEmerging(e.target.checked)} /> Emerging only ({emergingCount})
        </label>
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
                <td>{isEmerging(r) ? <span className="chip warn" title="A trial niche found by this week's measuring">{r.kind}</span> : r.kind}</td><td className="num">{r.hit_rate}%</td><td className="num">{pct(r.open_share)}</td><td className="num">{r.score}</td>
                <td>{r.verdict === "drop" ? "Skipped by the finder" : r.verdict === "few" ? "Too few to tell" : ""}</td>
                <td className="num">{r.leads ?? ""}</td><td className="num">{r.avg ?? ""}</td><td className="num">{r.strong ?? ""}</td>
                <td className="num">{r.band ?? ""}</td><td className="num">{r.loss ?? ""}</td><td className="num">{r.ruled_out || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {codes.some((c) => !c.covered) && (
        <p className="filings-note">Narrower: 8-digit customs codes no goods niche covers, best first (the heading's own score in brackets): {codes.filter((c) => !c.covered).slice(0, 12)
          .map((c) => `${c.code} (${c.hit_rate}% prove FX, ${c.strong} companies; heading ${c.heading} ${c.heading_score})`).join(" · ")}</p>
      )}
      {headings.some((h) => !h.covered) && (
        <p className="filings-note">Customs headings no goods niche covers yet, best first: {headings.filter((h) => !h.covered).slice(0, 12)
          .map((h) => `${h.heading} ${h.chapter} (${h.hit_rate}% prove FX, ${h.strong} companies)`).join(" · ")}</p>
      )}
    </div>
  );
}

// The Power Automate feed (api/feed.mjs): the URL with its own read-only key, to paste into a flow's HTTP step; a new
// key retires the old one. Every lead on the site, flat rows, best lead score first, each with its status here.
function FeedButton({ password }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [note, setNote] = useState("");
  const auth = { authorization: `Bearer ${password}` };
  const load = () => fetch(`${API}?view=feedkey`, { headers: auth, cache: "no-store" })
    .then((res) => (res.ok ? res.json() : null)).then((b) => setKey(b?.key || "")).catch(() => setKey(""));
  const rotate = async () => {
    if (!window.confirm("Make a new feed key? Flows using the old URL stop working until you paste the new one.")) return;
    const res = await fetch(API, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ feed_key: "new" }) }).catch(() => null);
    const b = res?.ok ? await res.json() : null;
    if (b?.key) { setKey(b.key); setNote("New key made — paste the new URL into your flow."); }
  };
  const url = key ? `${window.location.origin}/api/feed?key=${key}` : "";
  const copy = (text) => navigator.clipboard?.writeText(text).then(() => setNote("Copied."), () => setNote("Select and copy it by hand."));
  return (
    <>
      <button className="btn-sm" onClick={() => { setOpen(!open); if (!open) load(); }} title="The URL a Power Automate flow reads every lead from">Power Automate feed</button>
      {open && (
        <div className="feed-panel" role="dialog" aria-label="Power Automate feed">
          <b>Power Automate feed</b>
          <p className="muted">Every lead on the site, best lead score first, with its status here (To check / Contacted / Open lead …). Read-only. In your flow: an <b>HTTP</b> step, Method GET, this URL; then <b>Parse JSON</b> on the body; then <b>Apply to each</b> over <code>rows</code>.</p>
          {url ? <>
            <input className="input" readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Feed URL" />
            <div className="feed-actions">
              <button className="btn-sm" onClick={() => copy(url)}>Copy URL</button>
              <button className="btn-sm" onClick={() => copy(`${url}&format=csv`)}>Copy CSV URL</button>
              <button className="btn-sm" onClick={rotate}>New key</button>
              <button className="btn-sm" onClick={() => setOpen(false)}>Close</button>
            </div>
          </> : <p className="muted">Loading…</p>}
          {note && <p className="muted">{note}</p>}
          <p className="muted">Keep the URL inside your flow — it reads the whole list. Nothing from the CRM ever goes back through it.</p>
        </div>
      )}
    </>
  );
}

// The Emerging leads tab (Zac, 21 Nov 2026: "sort all of these new leads into a column — I'll check them all today"):
// every full / medium / group-accounts company in this week's emerging niches (niche_hits --emerging-out), strongest FX
// proof first, with the Simplified dash's buttons — Open lead / Added to mine / Owned abroad — so each one checked moves
// off To check (and feeds the lookalikes and the feedback loop).
function EmergingLeads({ password, listed, onOpen, checks, onReview }) {
  const [data, setData] = useState(null);
  const [niche, setNiche] = useState("");
  const [strongOnly, setStrongOnly] = useState(false);
  const [tab, setTab] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    fetch(`${API}?view=emerging`, { headers: { authorization: `Bearer ${password}` }, cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null)).then((body) => setData(body || { rows: [] })).catch(() => setData({ rows: [] }));
  }, [password]);
  if (!data) return <div className="list"><div className="empty">Loading…</div></div>;
  const reviewOf = (r) => checks[r.company_number]?.review || "";
  const rows = data.rows || [];
  const base = rows.filter((r) => (!niche || r.niches.includes(niche)) && (!strongOnly || r.fx_proof === "strong")
    && (!q || `${r.company_name} ${r.company_number}`.toLowerCase().includes(q.toLowerCase())));
  const list = base.filter((r) => reviewOf(r) === tab);
  const counts = {};
  for (const r of rows) for (const n of r.niches) counts[n] = (counts[n] || 0) + 1;
  const short = (n) => n.replace(/^Emerging: /, "");
  const open = (r) => (listed.has(r.company_number) ? onOpen(r.company_number) : window.open(chCompanyUrl(r.company_number), "_blank", "noopener"));
  const exportList = () => downloadSheet(list.map((r, i) => ({ rank: i + 1, company_name: r.company_name, company_number: r.company_number,
      niche: r.niches.map(short).join("; "), accounts_category: r.accounts_category, industry: industryOf({ sic_codes: r.sic_codes }),
      fx_proof: r.fx_proof === "strong" ? "Strong" : r.fx_proof === "some" ? "Some" : "", open: r.open ? "No hedging named" : "",
      customs_months: r.customs_months || "", on_list: listed.has(r.company_number) ? "Yes" : "", postcode: r.postcode,
      status: (REVIEW_BUTTONS.find(([k]) => k === reviewOf(r)) || [])[1] || "", companies_house_url: chCompanyUrl(r.company_number) })),
    columnsFor(["rank", "company_name", "company_number", "status", "niche", "accounts_category", "industry", "fx_proof", "open", "customs_months", "on_list", "postcode", "companies_house_url"],
      { customs_months: "Months in customs records", on_list: "On the lists", fx_proof: "FX proof in filings", open: "Hedging" }, ["rank", "customs_months"]),
    `emerging-leads-${new Date().toISOString().slice(0, 10)}.xlsx`, "Emerging leads");
  if (!rows.length) return <div className="list"><div className="empty">No emerging-niche companies yet — they arrive with the next Niche hits run.</div></div>;
  return (
    <div className="list">
      <div className="filters filings-bar">
        <span className="muted">{rows.length} companies (full / medium / group accounts) in this week's {data.niches?.length || 0} emerging niches · strongest FX proof in their filings first · updated {data.made_at ? filedWhen(data.made_at.slice(0, 10)) : ""}</span>
      </div>
      <div className="groups" role="group" aria-label="Status">
        {[["", "To check"], ...REVIEW_BUTTONS.map(([k, label]) => [k, label])].map(([k, label]) => (
          <button key={k || "todo"} className={`btn-sm${tab === k ? " on" : ""}`} onClick={() => setTab(k)}>
            {label} <span className="tab-n">{base.filter((r) => reviewOf(r) === k).length}</span>
          </button>
        ))}
      </div>
      <div className="filters filings-bar">
        <input className="input search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search company or number" aria-label="Search" />
        <select className="input" value={niche} onChange={(e) => setNiche(e.target.value)} aria-label="Emerging niche">
          <option value="">Every emerging niche ({rows.length})</option>
          {Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([n, c]) => <option key={n} value={n}>{short(n)} ({c})</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={strongOnly} onChange={(e) => setStrongOnly(e.target.checked)} /> Strong FX proof only ({rows.filter((r) => r.fx_proof === "strong").length})</label>
        <button className="btn-sm export" onClick={exportList} disabled={!list.length}>Export Excel ({list.length})</button>
      </div>
      <div className="sheet-wrap">
        <table className="sheet">
          <thead><tr><th className="num">#</th><th>Company</th><th>CH number</th><th className="actions-col">Status</th><th>Niche</th><th>Accounts</th><th>Industry</th>
            <th title="From the FX filings scan of its own accounts">FX proof</th><th className="num" title="Months with customs records in the last year">Customs months</th><th>On the lists</th></tr></thead>
          <tbody>
            {list.slice(0, 1500).map((r, i) => (
              <tr key={r.company_number}>
                <td className="num">{i + 1}</td>
                <td><button className="linkish" onClick={() => open(r)}>{r.company_name}</button></td>
                <td><a href={chCompanyUrl(r.company_number)} target="_blank" rel="noreferrer">{r.company_number}</a></td>
                <td className="actions-col"><span className="review-btns">
                  {REVIEW_BUTTONS.map(([k, label, hint]) => (
                    <button key={k} className={`btn-sm review-${k}${reviewOf(r) === k ? " on" : ""}`} title={reviewOf(r) === k ? "Click again to clear" : hint}
                            aria-pressed={reviewOf(r) === k} onClick={() => onReview(r.company_number, k)}>{label}</button>
                  ))}
                </span></td>
                <td>{r.niches.map(short).join("; ")}</td><td>{r.accounts_category}</td><td>{industryOf({ sic_codes: r.sic_codes })}</td>
                <td>{r.fx_proof === "strong" ? <span className="chip good">Strong{r.open ? " · no hedging named" : ""}</span> : r.fx_proof === "some" ? "Some" : ""}</td>
                <td className="num">{r.customs_months || ""}</td><td>{listed.has(r.company_number) ? "Yes" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!list.length && <div className="empty">{tab ? "None marked here yet." : "All checked — nice."}</div>}
    </div>
  );
}

// The Scoreboard tab (Zac, 22 Nov 2026: put the finding effort where the good leads come from): his marks (Open lead /
// Added to mine / Good lead count good; Owned abroad / Not a fit count not) against each source, niche and industry,
// the well-fitting leads still waiting there, and each good lead's lookalikes by profile (format.js likeGoodLeads).
function Scoreboard({ rows, checks, verdicts, likes, onOpen, onPick, onMarkMany }) {
  const [kind, setKind] = useState("source");
  const [open, setOpen] = useState("");
  const [paste, setPaste] = useState("");
  const [done, setDone] = useState("");
  const live = useMemo(() => rows.filter((r) => !r.dropped), [rows]);
  const sections = useMemo(() => (paste.trim() ? markSections(paste).map((s) => ({ ...s, ...matchCompanies(s.text, live) })) : []), [paste, live]);
  const total = sections.reduce((n, s) => n + s.matched.length, 0);
  const found = paste.trim() ? { matched: sections.flatMap((s) => s.matched), unmatched: sections.flatMap((s) => s.unmatched) } : null;
  const markAll = async () => {
    // a pasted reason in any case ("no real fx") becomes the page's own wording; one it doesn't know is Other; a company
    // under two headings takes the last
    const items = new Map();
    for (const s of sections) {
      const mark = s.mark.verdict === "not_fit" && s.mark.reason
        ? { ...s.mark, reason: VERDICT_REASONS.find((r) => r.toLowerCase() === s.mark.reason.toLowerCase()) || "Other" } : s.mark;
      for (const m of s.matched) items.set(m.row.company_number, { number: m.row.company_number, mark });
    }
    const res = await onMarkMany([...items.values()]);
    if (res.failed) { setDone(""); return; }
    setDone(`Saved ${res.saved} mark${res.saved === 1 ? "" : "s"}${res.already ? ` (${res.already} already marked)` : ""}: ${sections.filter((s) => s.matched.length).map((s) => `${s.label} ${s.matched.length}`).join(" · ")}.`);
    setPaste("");
  };
  const board = useMemo(() => scoreboard(rows, checks, verdicts), [rows, checks, verdicts]);
  const good = useMemo(() => goodLeads(rows, checks, verdicts), [rows, checks, verdicts]);
  const byNumber = useMemo(() => new Map(rows.map((r) => [r.company_number, r])), [rows]);
  const likesOf = {};
  for (const [n, l] of Object.entries(likes || {})) (likesOf[l.like] ||= []).push(n);
  const checked = board.source.reduce((n, g) => n + g.checked, 0);
  const goodN = board.source.reduce((n, g) => n + g.good, 0);
  const fromWhere = board.source.filter((g) => g.good).map((g) => `${g.key} ${g.good}`).join(" · ");
  const lines = board[kind].filter((g) => kind === "source" || g.leads >= 5 || g.checked).slice(0, kind === "source" ? 50 : 40);
  const traits = (p) => Object.entries(p).filter(([k, v]) => v && k !== "source").map(([, v]) => v).join(" · ");
  return (
    <div className="list">
      <div className="filters filings-bar">
        <span className="muted">{checked ? `${checked} lead${checked === 1 ? "" : "s"} checked, ${goodN} good${fromWhere ? ` — from ${fromWhere}` : ""}.` : "Nothing checked yet."}
          {" "}Every Open lead / Added to mine / Good lead mark teaches the score: with 5+ checked, a source or niche that's mostly good lifts its leads (+8), and every lead that shares most of a good lead's profile is lifted too (+8, “Like your good lead …”). About 20 marks a day is enough.</span>
      </div>
      <details className="bulk-mark" open={!good.length}>
        <summary>Mark leads in bulk — paste names or numbers (Added to mine, Open lead, Owned abroad, Not a fit)</summary>
        <textarea className="input" rows={6} value={paste} onChange={(e) => { setPaste(e.target.value); setDone(""); }}
                  placeholder={"One per line (or comma-separated): registered names or company numbers. A heading line sets the mark for the names under it:\nAdded to mine:\nVOLANTEUS LIMITED\nOpen lead:\n13582451\nNot a fit (No real FX):\nACME LIMITED"} aria-label="Companies to mark" />
        {found && <div className="muted">
          {sections.map((s) => `${s.label}: ${s.matched.length}`).join(" · ")}{found.unmatched.length ? ` · not on our lists: ${found.unmatched.slice(0, 8).join("; ")}${found.unmatched.length > 8 ? " …" : ""}` : ""}
          {sections.filter((s) => s.matched.length).map((s) => <div key={s.label} className="chips"><b>{s.label}</b>{s.matched.slice(0, 40).map((m) => <span key={m.row.company_number} className="chip">{m.row.company_name}</span>)}</div>)}
        </div>}
        <button className="btn-sm" disabled={!total} onClick={markAll}>Mark {total}</button>
        {done && <span className="muted"> {done}</span>}
        <div className="muted">Only your own mark is kept (with the date) — nothing else from where you copied them.</div>
      </details>
      {good.length > 0 && <>
        <h2 className="group-h">Your good leads <span>{good.length} · lookalikes by profile: {Object.keys(likes || {}).length}</span></h2>
        <div className="sheet-wrap">
          <table className="sheet">
            <thead><tr><th>Company</th><th>Found via</th><th>Profile</th><th className="num">Lookalikes</th></tr></thead>
            <tbody>{good.map((g) => (
              <Fragment key={g.company_number}>
                <tr>
                  <td><button className="linkish" onClick={() => onOpen(g.company_number)}>{g.company_name}</button></td>
                  <td>{g.profile.source}</td><td>{traits(g.profile) || "—"}</td>
                  <td className="num">{likesOf[g.company_number]?.length
                    ? <button className="btn-sm" aria-expanded={open === g.company_number} onClick={() => setOpen(open === g.company_number ? "" : g.company_number)}>{likesOf[g.company_number].length} {open === g.company_number ? "▴" : "▾"}</button> : "0"}</td>
                </tr>
                {open === g.company_number && (likesOf[g.company_number] || []).map((n) => byNumber.get(n)).filter(Boolean)
                  .sort((a, b) => (b.lead_fit || 0) - (a.lead_fit || 0) || (b.lead_score || 0) - (a.lead_score || 0)).slice(0, 30).map((r) => (
                  <tr key={r.company_number} className="sub-row">
                    <td>↳ <button className="linkish" onClick={() => onOpen(r.company_number)}>{r.company_name}</button></td>
                    <td>{leadSource(r)}</td><td>{likes[r.company_number].same.join(" · ")}</td>
                    <td className="num">Fit {r.lead_fit ?? "?"} · {r.lead_score ?? ""}</td>
                  </tr>
                ))}
              </Fragment>
            ))}</tbody>
          </table>
        </div>
      </>}
      <div className="groups" role="group" aria-label="Scoreboard by">
        {[["source", "By source"], ["niche", "By niche"], ["industry", "By industry"]].map(([k, label]) => (
          <button key={k} className={`btn-sm${kind === k ? " on" : ""}`} onClick={() => setKind(k)}>{label}</button>
        ))}
      </div>
      <div className="sheet-wrap">
        <table className="sheet">
          <thead><tr><th>{kind === "source" ? "Source" : kind === "niche" ? "Niche" : "Industry"}</th><th className="num">Leads</th>
            <th className="num" title="Leads with Fit 60+">Fit 60+</th><th className="num">Checked</th><th className="num">Good</th>
            <th className="num">Good %</th><th className="num" title="Fit 60+ leads you haven't marked yet">Waiting</th></tr></thead>
          <tbody>{lines.map((g) => (
            <tr key={g.key}>
              <td>{kind === "niche" ? <button className="linkish" onClick={() => onPick(g.key)}>{g.key}</button> : g.key}</td>
              <td className="num">{g.leads.toLocaleString()}</td><td className="num">{g.fit60.toLocaleString()}</td><td className="num">{g.checked || ""}</td>
              <td className="num">{g.good || ""}</td><td className="num">{g.good_share === null ? "" : `${g.good_share}%`}</td>
              <td className="num">{g.waiting ? g.waiting.toLocaleString() : ""}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

// The Job adverts tab (Zac, 22 Nov 2026: "make our job finder new"): every employer whose adverts on Adzuna and Reed name
// currency work, a treasury / FX role, an import / export role, teams abroad or a new finance director — read by
// sourcer/jobs.py (the sentence, currencies, countries, trade terms, a score), matched to Companies House (cached), the
// strongest not on the lists already sent to the finder as new leads. Agencies' adverts are left out (their client is
// unnamed). Status buttons as on the Simplified dash: his marks teach the score.
const JOB_STATUS = { new_lead: ["New lead", "Matched on Companies House, not on our lists — sent to the finder"],
  on_list: ["On our lists", "Already on the Accounts or FX filings list"], matched: ["Matched", "Found on Companies House; its adverts score under the lead bar"],
  not_found: ["Not matched", "No company of that name on Companies House — search it by hand"],
  waiting: ["Not looked up yet", "This run's name searches were used up — tried next run"],
  excluded: ["Left out", "A recruitment agency, job board, accountancy practice, consultancy or payments firm — its adverts are other companies' work"],
  not_looked_up: ["Weak", "Nothing FX-specific in its adverts"] };
const JOB_KINDS = { currency: "Currency work", treasury: "Treasury / FX role", trade: "Import / export role", fd: "Finance director", abroad: "Teams abroad" };
function JobAdverts({ password, rowsByNumber, onOpen, checks, onReview }) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("new_lead");
  const [kind, setKind] = useState("");
  const [currency, setCurrency] = useState("");
  const [worded, setWorded] = useState(false);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState("");
  const [showQueries, setShowQueries] = useState(false);
  useEffect(() => {
    fetch(`${API}?view=jobs`, { headers: { authorization: `Bearer ${password}` }, cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status))))).then((body) => setData(body || { employers: [] }))
      .catch(() => setData({ employers: [], failed: true }));
  }, [password]);
  if (!data) return <div className="list"><div className="empty">Loading…</div></div>;
  if (data.failed) return <div className="list"><div className="empty">Couldn't load the job adverts — refresh the page to try again.</div></div>;
  const all = (data.employers || []).filter((e) => e.status !== "not_looked_up");
  const statusOf = (e) => (e.company_number && rowsByNumber.has(e.company_number) ? "on_list" : e.status || "");
  const base = all.filter((e) => (!kind || (e.kinds || []).includes(kind)) && (!currency || (e.currencies || []).includes(currency))
    && (!worded || e.quote) && (!q || `${e.employer} ${e.company_name || ""} ${e.company_number || ""} ${e.quote || ""}`.toLowerCase().includes(q.toLowerCase())));
  const list = base.filter((e) => !status || statusOf(e) === status);
  const counts = (fn) => { const c = {}; for (const e of all) for (const k of fn(e)) c[k] = (c[k] || 0) + 1; return c; };
  const kindCounts = counts((e) => e.kinds || []), ccyCounts = counts((e) => e.currencies || []);
  const reviewOf = (e) => (e.company_number ? checks[e.company_number]?.review || "" : "");
  const go = (e) => (e.company_number && rowsByNumber.has(e.company_number) ? onOpen(e.company_number)
    : window.open(e.company_number ? chCompanyUrl(e.company_number) : `https://find-and-update.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(e.employer)}`, "_blank", "noopener"));
  const exportList = () => downloadSheet(list.map((e, i) => {
    const r = e.company_number && rowsByNumber.get(e.company_number);
    return { rank: i + 1, employer: e.employer, company_name: e.company_name || "", company_number: e.company_number || "",
      status: JOB_STATUS[statusOf(e)]?.[0] || "", job_score: e.score, what: (e.kinds || []).map((k) => JOB_KINDS[k] || k).join("; "),
      currencies: (e.currencies || []).join(", "), countries: (e.countries || []).join(", "), terms: (e.terms || []).join(", "),
      quote: e.quote || "", adverts: (e.adverts || []).map((a) => `${a.title} (${a.date}, ${a.source})`).join("; "),
      latest_advert: e.adverts?.[0]?.link || "", last_seen: e.last_seen || "", lead_score: r?.lead_score ?? "", industry: r ? industryOf(r) : "",
      my_status: (REVIEW_BUTTONS.find(([k]) => k === reviewOf(e)) || [])[1] || "",
      companies_house_url: e.company_number ? chCompanyUrl(e.company_number) : "" };
  }), columnsFor(["rank", "employer", "company_name", "company_number", "status", "my_status", "job_score", "what", "currencies", "countries", "terms", "quote", "adverts", "latest_advert", "last_seen", "lead_score", "industry", "companies_house_url"],
    { job_score: "Advert score", what: "What the adverts show", quote: "In their words", latest_advert: "Advert link", last_seen: "Latest advert", my_status: "Your mark" }, ["rank", "job_score", "lead_score"]),
    `job-adverts-${new Date().toISOString().slice(0, 10)}.xlsx`, "Job adverts");
  const c = data.counts || {};
  if (!all.length) return <div className="list"><div className="empty">No job adverts yet — they arrive with the next morning's Alerts run{data.boards?.length === 0 ? " (no job-board keys set: ADZUNA_APP_ID / ADZUNA_APP_KEY, REED_API_KEY)" : ""}.</div></div>;
  return (
    <div className="list">
      <div className="filters filings-bar">
        <span className="muted">{all.length} employers from the last {data.days || 14} days of adverts on {(data.boards || []).join(" and ") || "the job boards"}
          {c.adverts ? ` (${c.adverts.toLocaleString()} adverts read this morning, ${c.full_reads || 0} in full)` : ""} — agencies' adverts left out.
          Best first: the advert's own words about currency work, the currencies and countries it names, trade terms, a finance director role. Updated {data.made_at ? filedWhen(data.made_at.slice(0, 10)) : ""}.</span>
      </div>
      <div className="groups" role="group" aria-label="Status">
        {[["", "All", "Every employer"], ...Object.entries(JOB_STATUS).filter(([k]) => k !== "not_looked_up").map(([k, [label, hint]]) => [k, label, hint])].map(([k, label, hint]) => (
          <button key={k || "all"} title={hint} className={`btn-sm${status === k ? " on" : ""}`} onClick={() => setStatus(k)}>
            {label} <span className="tab-n">{k ? base.filter((e) => statusOf(e) === k).length : base.length}</span>
          </button>
        ))}
      </div>
      <div className="filters filings-bar">
        <input className="input search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search employer, company or words" aria-label="Search" />
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="What the adverts show">
          <option value="">Any kind of advert</option>
          {Object.entries(JOB_KINDS).map(([k, label]) => <option key={k} value={k}>{label} ({kindCounts[k] || 0})</option>)}
        </select>
        <select className="input" value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Currency named">
          <option value="">Any currency</option>
          {Object.entries(ccyCounts).sort((a, b) => b[1] - a[1]).map(([k, n]) => <option key={k} value={k}>{k} ({n})</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={worded} onChange={(e) => setWorded(e.target.checked)} /> Names currency work ({all.filter((e) => e.quote).length})</label>
        <button className="btn-sm export" onClick={exportList} disabled={!list.length}>Export Excel ({list.length})</button>
        <button className="btn-sm" onClick={() => setShowQueries((v) => !v)} aria-expanded={showQueries}>Which searches pay</button>
      </div>
      {showQueries && (
        <div className="sheet-wrap">
          <table className="sheet">
            <thead><tr><th>Search</th><th>Kind</th><th className="num">Adverts</th><th className="num">Kept</th><th className="num" title="Adverts naming currency work">Naming FX</th><th className="num" title="Adverts whose employer became a new lead">Leads</th></tr></thead>
            <tbody>{[...(data.queries || [])].sort((a, b) => b.leads - a.leads || b.worded - a.worded).map((x) => (
              <tr key={x.query}><td>{x.query}</td><td>{JOB_KINDS[x.kind] || x.kind}</td><td className="num">{x.adverts}</td><td className="num">{x.kept}</td><td className="num">{x.worded}</td><td className="num">{x.leads}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {list.slice(0, 400).map((e, i) => {
        const r = e.company_number && rowsByNumber.get(e.company_number);
        const st = statusOf(e);
        return (
          <article className="card loss-card" key={e.key}>
            <div className="card-top">
              <div className="card-name">
                <span className="call-n">{i + 1}</span>
                <button className="linkish co" onClick={() => go(e)} title={e.company_number ? "Open the company" : "Search Companies House for it"}>{e.company_name || e.employer}</button>
                {e.company_name && advertisesAs(e) && <span className="muted">advertises as {e.employer}</span>}
                <span className={`chip${st === "new_lead" ? " good" : st === "not_found" ? " warn" : ""}`} title={JOB_STATUS[st]?.[1]}>{JOB_STATUS[st]?.[0] || st}</span>
                {(e.kinds || []).map((k) => <span key={k} className="chip">{JOB_KINDS[k] || k}</span>)}
                {e.first_seen && e.first_seen === data.made_at?.slice(0, 10) && <span className="new">New today</span>}
                {(e.excluded || e.note) && <span className="muted">{e.excluded || e.note}</span>}
              </div>
              <div className="loss-fig" title="Advert score: currency wording 30, each currency 8, each country beside trade words 4, trade terms 6, an FD role 20, treasury 15, an import / export role 8, more adverts naming FX 5 each">
                <b>{e.score}</b><span className="muted"> advert score{r?.lead_score !== undefined ? ` · lead score ${r.lead_score}` : ""}</span>
              </div>
            </div>
            {e.quote && <p className="quote">“{e.quote}”</p>}
            <div className="chips">
              {(e.currencies || []).map((x) => <span key={x} className="chip good">{x}</span>)}
              {(e.countries || []).slice(0, 6).map((x) => <span key={x} className="chip">{x}</span>)}
              {(e.terms || []).map((x) => <span key={x} className="chip">{x}</span>)}
              {e.company_number && <a className="chip" href={chCompanyUrl(e.company_number)} target="_blank" rel="noreferrer">{e.company_number}</a>}
              {e.match === "core" && <span className="chip warn" title="Matched on the name without Group / Holdings / UK — check it's the same company">Name matched loosely</span>}
            </div>
            {e.company_number && <span className="review-btns">
              {REVIEW_BUTTONS.map(([k, label, hint]) => (
                <button key={k} className={`btn-sm review-${k}${reviewOf(e) === k ? " on" : ""}`} title={reviewOf(e) === k ? "Click again to clear" : hint}
                        aria-pressed={reviewOf(e) === k} onClick={() => onReview(e.company_number, k)}>{label}</button>
              ))}
            </span>}
            <button className="btn-sm" onClick={() => setOpen(open === e.key ? "" : e.key)} aria-expanded={open === e.key}>
              {(e.adverts || []).length} advert{(e.adverts || []).length === 1 ? "" : "s"} {open === e.key ? "▴" : "▾"}</button>
            {open === e.key && <ul className="adverts">
              {(e.adverts || []).map((a) => (
                <li key={`${a.title}${a.date}`}>
                  {a.link ? <a href={a.link} target="_blank" rel="noreferrer">{a.title}</a> : a.title}
                  <span className="muted"> · {a.date} · {a.source} · {JOB_KINDS[a.kind] || a.kind} · {a.score}{a.why?.length ? ` (${a.why.join("; ")})` : ""}</span>
                  {a.quotes?.length > 1 && <div className="muted">{a.quotes.slice(1).map((x) => `“${x}”`).join(" ")}</div>}
                </li>
              ))}
            </ul>}
          </article>
        );
      })}
      {!list.length && <div className="empty">No employers match these filters.</div>}
    </div>
  );
}
// the employer advertises under a name other than its registered one
const advertisesAs = (e) => e.employer && e.company_name && e.employer.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) !== e.company_name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);

// The Niche search tab (Zac, 21 Nov 2026: "focus on finding niche companies — I have paid services for contacts and exact
// financials"): a product or trade typed here is answered by the Niche search workflow within the hour (customs codes
// whose description names it -> every company whose HMRC records carry them, matched to Companies House; sized ones not
// on the lists go to the finder). Below, lookalikes: sized companies trading the same goods as the leads Zac marked good.
const SEARCH_EXPORT = ["company_name", "company_number", "accounts_category", "industry", "flow", "months", "share", "codes", "on_list", "filed_fx_score", "postcode"];
function NicheSearch({ password, listed, onOpen }) {
  const [data, setData] = useState(null);
  const [text, setText] = useState("");
  const [pick, setPick] = useState("");
  const [sizedOnly, setSizedOnly] = useState(true);
  const [newOnly, setNewOnly] = useState(false);
  const [error, setError] = useState("");
  const auth = { authorization: `Bearer ${password}` };
  const load = () => fetch(`${API}?view=search`, { headers: auth, cache: "no-store" })
    .then((res) => (res.ok ? res.json() : null)).then((body) => { if (body) setData(body); }).catch(() => {});
  useEffect(() => { load(); }, [password]);   // eslint-disable-line react-hooks/exhaustive-deps
  const post = async (body) => {
    setError("");
    const res = await fetch(API, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const got = res && (await res.json().catch(() => null));
    if (!res?.ok) { setError(got?.error || "Couldn't save the search — try again."); return; }
    setData((d) => ({ ...(d || {}), searches: got.searches }));
  };
  const searches = data?.searches || [];
  const results = data?.results || {};
  const current = pick || searches[0]?.id || "";
  const result = results[current];
  const waiting = (s) => (results[s.id]?.asked_at || "") !== s.asked_at;
  const isListed = (n) => listed.has(n);
  const sized = (r) => ["full", "medium", "group"].includes(r.accounts_category);
  const shown = (result?.rows || []).filter((r) => (!sizedOnly || sized(r)) && (!newOnly || !isListed(r.company_number)));
  const alike = (data?.lookalikes?.items || []).filter((r) => !newOnly || !isListed(r.company_number));
  const open = (r) => (isListed(r.company_number) ? onOpen(r.company_number) : window.open(chCompanyUrl(r.company_number), "_blank", "noopener"));
  const exportRows = (rows, name) => downloadSheet(rows.map((r) => ({ ...r, industry: industryOf({ sic_codes: r.sic_codes }), codes: (r.codes || r.shared || []).join(" "),
      on_list: isListed(r.company_number) ? "Yes" : "" })),
    columnsFor(name === "lookalikes" ? ["company_name", "company_number", "like_name", "score", "shared_n", "codes", "accounts_category", "industry", "on_list", "postcode"] : SEARCH_EXPORT,
      { share: "Share of its trade (%)", months: "Months trading", like_name: "Like", score: "Similarity", shared_n: "Goods in common", codes: "Customs codes", on_list: "On the lists" },
      ["months", "share", "score", "shared_n", "filed_fx_score"]),
    `fx-${name}-${new Date().toISOString().slice(0, 10)}.xlsx`, name === "lookalikes" ? "Lookalikes" : "Niche search");
  return (
    <div className="list">
      <form className="filters filings-bar" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { post({ niche_search: text.trim() }); setText(""); setPick(""); } }}>
        <input className="input search" value={text} onChange={(e) => setText(e.target.value)} maxLength={200}
               placeholder="A product or trade — marble, saffron, drone, cut flowers… (commas for several; customs codes work too)" aria-label="Niche search" />
        <button className="btn-sm" type="submit" disabled={!text.trim()}>Search</button>
        <span className="muted">Answered within the hour (the Niche search workflow) · from HMRC's importer / exporter lists, last 12 months</span>
      </form>
      {error && <div className="save-error" role="alert">{error}</div>}
      {!data && <div className="empty">Loading…</div>}
      {data && !searches.length && <div className="empty">No searches yet — type a product or trade above.</div>}
      {searches.length > 0 && (
        <div className="groups" role="group" aria-label="Your searches">
          {searches.map((s) => {
            const r = results[s.id];
            return (
              <span key={s.id} className={`btn-sm${current === s.id ? " on" : ""}`} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <button className="linkish" onClick={() => setPick(s.id)}>{s.text}</button>
                <span className="muted">{waiting(s) ? "searching…" : `${r.counts.sized} sized · ${r.counts.new_sized} new`}</span>
                {!waiting(s) && <button className="linkish" title="Search again with the latest customs files" onClick={() => post({ niche_search_again: s.id })}>↻</button>}
                <button className="linkish" title="Remove this search" onClick={() => post({ niche_search_remove: s.id })}>×</button>
              </span>
            );
          })}
        </div>
      )}
      {current && !result && <div className="empty">Searching — the results arrive with the next Niche search run (hourly).</div>}
      {result && (
        <>
          <div className="filters filings-bar">
            <b>{result.text}</b>
            <span className="muted">{result.counts.companies} companies trade it · {result.counts.sized} file full / medium / group accounts · {result.counts.new_sized} of those not on the lists (the finder checks them next) · searched {filedWhen(String(result.done_at).slice(0, 10))}</span>
            <label className="check"><input type="checkbox" checked={sizedOnly} onChange={(e) => setSizedOnly(e.target.checked)} /> Full / medium / group accounts only</label>
            <label className="check"><input type="checkbox" checked={newOnly} onChange={(e) => setNewOnly(e.target.checked)} /> Not on the lists only</label>
            <button className="btn-sm" onClick={() => exportRows(shown, "niche-search")} disabled={!shown.length}>Excel</button>
          </div>
          {result.note && <p className="filings-note">{result.note}</p>}
          {result.codes?.length > 0 && (
            <details className="filings-note"><summary>{result.codes.length} customs codes searched</summary>
              {result.codes.map((c) => <div key={c.code}><b>{c.code}</b> {c.description}</div>)}</details>
          )}
          <div className="sheet-wrap">
            <table className="sheet">
              <thead><tr><th>Company</th><th>Accounts</th><th>Industry</th><th>Trades</th><th className="num">Months</th>
                <th className="num" title="Share of everything it declares to customs">Share of its trade</th><th>Codes</th><th className="num">FX proof</th><th>On the lists</th></tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.company_number}>
                    <td><button className="linkish" onClick={() => open(r)}>{r.company_name}</button> <span className="muted">{r.company_number}</span></td>
                    <td>{r.accounts_category}</td><td>{industryOf({ sic_codes: r.sic_codes })}</td><td>{r.flow}</td>
                    <td className="num">{r.months}</td><td className="num">{r.share}%</td><td>{(r.codes || []).join(" ")}</td>
                    <td className="num">{r.filed_fx_score || ""}</td><td>{isListed(r.company_number) ? "Yes" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!shown.length && <div className="empty">None match these filters.</div>}
        </>
      )}
      <h2 className="group-h" style={{ marginTop: 28 }}>Like your good leads <span>{alike.length} · companies trading the same goods as the leads you marked Open lead / Added to mine / Good lead (rarer goods count more)</span></h2>
      {alike.length > 0 ? (
        <>
          <div className="filters filings-bar">
            <span className="muted">{data.lookalikes.good} leads marked good, {data.lookalikes.leads} with customs records to compare · updated {data.lookalikes.made_at ? filedWhen(data.lookalikes.made_at.slice(0, 10)) : ""} (daily, Niche hits)</span>
            <button className="btn-sm" onClick={() => exportRows(alike, "lookalikes")}>Excel</button>
          </div>
          <div className="sheet-wrap">
            <table className="sheet">
              <thead><tr><th>Company</th><th>Like</th><th className="num">Similarity</th><th className="num">Goods in common</th><th>Accounts</th><th>Industry</th><th>On the lists</th></tr></thead>
              <tbody>
                {alike.map((r) => (
                  <tr key={r.company_number}>
                    <td><button className="linkish" onClick={() => open(r)}>{r.company_name}</button> <span className="muted">{r.company_number}</span></td>
                    <td><button className="linkish" onClick={() => onOpen(r.like)}>{r.like_name}</button></td>
                    <td className="num">{Math.round(100 * r.score)}%</td><td className="num" title={(r.shared || []).join(" ")}>{r.shared_n} of {r.of}</td>
                    <td>{r.accounts_category}</td><td>{industryOf({ sic_codes: r.sic_codes })}</td><td>{isListed(r.company_number) ? "Yes" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : <div className="empty">{data?.lookalikes?.made_at ? "None yet — mark leads Open lead / Added to mine (Simplified dash) or Good lead; the ones with customs records find their lookalikes in the next daily run." : "Arrives with the next daily Niche hits run."}</div>}
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
function FitTiming({ mode, rows, onOpen, onContact, onEmail, links }) {
  const fresh = mode === "new";
  const hidden = mode === "hidden";
  const finds = mode === "fresh";   // Fresh finds: new, a quiet source or niche, hidden from the usual filters (freshFind)
  const [why, setWhy] = useState("");   // Hidden: which filter drops it
  const [kind, setKind] = useState("");   // Fresh finds: why it's fresh
  const [days, setDays] = useState(7);
  const [source, setSource] = useState("");
  const [seat, setSeat] = useState("");   // Foreign-owned: where finance is decided (financeSeat's lean)
  const foreign = mode === "foreign";
  const uk = mode === "uk" || foreign || fresh || hidden || finds;
  const fitOnly = mode === "fit" || uk;
  const key = uk ? "lead_score" : fitOnly ? "lead_fit" : "lead_timing";
  // Discovery tabs open Fit first (the right company), the timely ones first among equals
  const [order, setOrder] = useState(fresh || hidden || finds ? "fit" : key);
  const [industry, setIndustry] = useState("");
  const base = rows.filter((r) => !isOut(r) && !r.dropped && (!fresh || (newLead(r, days) && (!source || leadSource(r) === source))) && (!foreign || !seat || financeSeat(r).lean === seat) && (!hidden || hiddenFromFilters(r).some((h) => !why || h.key === why)) && (!finds || ((kind ? freshFind(r).includes(kind) : freshFind(r).length) && (!source || leadSource(r) === source))) && (uk || ((r.lead_fit || 0) >= FIT.min && (fitOnly || (r.lead_timing || 0) > 0))));
  const counts = {};
  for (const r of base) { const k = industryOf(r); counts[k] = (counts[k] || 0) + 1; }
  const list = base.filter((r) => !industry || industryOf(r) === industry)
    .sort(order === "fit" ? (a, b) => (b.lead_fit || 0) - (a.lead_fit || 0) || (b.lead_timing || 0) - (a.lead_timing || 0) || (b.lead_score || 0) - (a.lead_score || 0)
      : (a, b) => (b[order] || 0) - (a[order] || 0) || (b.lead_score || 0) - (a.lead_score || 0));
  const half = (r, cat) => (r.lead_parts || []).filter(([, , c]) => c === cat);
  const line = (parts) => parts.map(([why, p]) => `${why} ${p > 0 ? "+" : "−"}${Math.abs(p)}`).join("; ");
  const exportList = () => downloadSheet(list.map((r, i) => ({
    rank: i + 1, company_name: r.company_name, company_number: r.company_number, fresh_because: finds ? freshFind(r).map((k) => FRESH_KINDS.find(([x]) => x === k)[1]).join("; ") : "", hidden_because: hidden ? hiddenFromFilters(r).map((h) => h.text).join("; ") : "", added_on: addedOn(r), found_via: fresh || finds ? `${leadSource(r)}${r.found_via ? ` — ${r.found_via}` : ""}` : "", industry: industryOf(r), lead_fit: r.lead_fit,
    lead_timing: r.lead_timing, lead_score: r.lead_score, fit_reasons: line(half(r, "fit")), timing_reasons: line(half(r, "timing")),
    turnover_gbp: r.turnover_gbp || "", companies_house_url: chCompanyUrl(r.company_number),
  })), columnsFor(["rank", "company_name", "company_number", ...(finds ? ["fresh_because", "found_via"] : []), ...(hidden || finds ? ["hidden_because"] : []), ...(fresh ? ["added_on", "found_via"] : []), "industry", "lead_fit", "lead_timing", "lead_score", "fit_reasons", "timing_reasons",
    "turnover_gbp", "companies_house_url"], { lead_fit: "Fit", lead_timing: "Now", turnover_gbp: "Turnover (£)", hidden_because: "Hidden from the usual filters because", fresh_because: "Fresh because" },
    ["rank", "lead_fit", "lead_timing", "lead_score", "turnover_gbp"]), `${finds ? "fresh-finds" : hidden ? "hidden-from-filters" : fresh ? "new-leads" : foreign ? "foreign-owned" : uk ? "uk-in-name" : fitOnly ? "best-fit" : "call-now"}-${new Date().toISOString().slice(0, 10)}.xlsx`,
    finds ? "Fresh finds" : hidden ? "Hidden" : fresh ? "New leads" : foreign ? "Foreign-owned" : uk ? "UK in name" : fitOnly ? "Best fit" : "Call now");
  return (
    <div className="list">
      <div className="filters filings-bar">
        <span className="muted">{finds
          ? `${list.length} leads few bankers have seen — new on the lists in the last ${FRESH_DAYS} days, found by a job advert, your niche search, a lookalike of a good lead or an emerging niche, or hidden from the usual Zint / Market IQ filters. Not marked yet; ${order === "fit" ? "best fit first, then the most timely" : order === "lead_timing" ? "most timely first" : "highest lead score first"}.`
          : hidden
          ? `${list.length} companies a standard Zint / Market IQ search can't see — no turnover filed, sized by their group, accounts in another currency or scanned, a sector code that hides what they trade, too new, or found by their goods or a job advert. ${order === "fit" ? "Best fit first, then the most timely" : order === "lead_timing" ? "Most timely first" : "Highest lead score first"}.`
          : fresh
          ? `${list.length} companies new to the lists in the last ${days} days — the finder's new finds and fresh FX filings. ${order === "fit" ? "Best fit first, then the most timely" : order === "lead_timing" ? "Most timely first" : "Highest lead score first"}.`
          : foreign
          ? `${list.length} companies owned from abroad — ask whether FX is decided in the UK or by the parent. Out of every other list; highest lead score first.`
          : uk
          ? `${list.length} companies with “UK” in their name — usually a foreign group's UK arm (ask whether FX is run here or by the parent). Out of every other list; highest lead score first.`
          : fitOnly
          ? `${list.length} companies with Fit ${FIT.min}+ — the right company for the desk (FX proof and FX pain, size, niche, ownership), whatever the news. Best fit first.`
          : `${list.length} of those with a reason to call now — a new FD, a deal, funding, a fresh filing, a customs or bank change. Most timely first (moments fade over 120 days).`}</span>
        {hidden && <select value={why} onChange={(e) => setWhy(e.target.value)} aria-label="Which filter drops it">
          <option value="">Any reason</option>
          {HIDDEN_KINDS.map(([k, label]) => <option key={k} value={k}>{label} ({rows.filter((r) => !isOut(r) && !r.dropped && hiddenFromFilters(r).some((h) => h.key === k)).length})</option>)}
        </select>}
        {finds && <div className="groups fresh-kinds" role="group" aria-label="Why it's fresh">
          {[["", "All"], ...FRESH_KINDS].map(([k, label]) => (
            <button key={k || "all"} aria-pressed={kind === k} className={`grp${kind === k ? " on" : ""}`} onClick={() => setKind(k)}>
              {label} <span className="tab-n">{rows.filter((r) => !isOut(r) && !r.dropped && (k ? freshFind(r).includes(k) : freshFind(r).length)).length}</span>
            </button>))}
        </div>}
        {finds && <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Found via">
          <option value="">Any source</option>
          {LEAD_SOURCES.map((k) => [k, rows.filter((r) => !isOut(r) && !r.dropped && freshFind(r).length && leadSource(r) === k).length]).filter(([, n]) => n)
            .map(([k, n]) => <option key={k} value={k}>{k} ({n})</option>)}
        </select>}
        {fresh && <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Added in the last">
          {NEW_LEAD_DAYS.map((d) => <option key={d} value={d}>Last {d} days</option>)}
        </select>}
        {foreign && <select value={seat} onChange={(e) => setSeat(e.target.value)} aria-label="Where finance is decided"
                            title="From its own records: its own forward contracts or facilities, a UK board, the accounts' words on group treasury">
          <option value="">Wherever finance is decided</option>
          {[["uk", "Decides in the UK"], ["unclear", "Unclear — ask"], ["abroad", "Likely run from abroad"]].map(([k, label]) => (
            <option key={k} value={k}>{label} ({rows.filter((r) => !isOut(r) && !r.dropped && financeSeat(r).lean === k).length})</option>))}
        </select>}
        {fresh && <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Found via">
          <option value="">Any source</option>
          {LEAD_SOURCES.map((k) => <option key={k} value={k}>{k} ({rows.filter((r) => !isOut(r) && newLead(r, days) && leadSource(r) === k).length})</option>)}
        </select>}
        {uk && <select value={order} onChange={(e) => setOrder(e.target.value)} aria-label="Order">
          <option value="fit">Fit first, then Now</option>
          <option value="lead_score">Lead score</option>
          <option value="lead_timing">Now first</option>
        </select>}
        <select value={industry} onChange={(e) => setIndustry(e.target.value)} aria-label="Industry">
          <option value="">Any industry ({base.length})</option>
          {Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => <option key={k} value={k}>{k} ({n})</option>)}
        </select>
        <button className="btn-sm export" onClick={exportList} disabled={!list.length}>Export Excel ({list.length})</button>
        {finds && links && <span className="muted">{links}</span>}
      </div>
      {list.slice(0, 200).map((r, i) => (
        <article className="card loss-card" key={r.company_number}>
          <div className="card-top">
            <div className="card-name">
              <span className="call-n">{i + 1}</span>
              <a className="co" href={companyPath(r.company_number)} onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onOpen(r.company_number); } }}>{r.company_name}</a>
              <span className="chip">{industryOf(r)}</span>
              {fresh && <span className="new">Added {addedOn(r)}</span>}
              {(fresh || finds) && <span className="chip" title={r.found_via || undefined}>{leadSource(r)}</span>}
              {finds && freshFind(r).filter((k) => k !== "source").map((k) => <span key={k} className="chip">{FRESH_KINDS.find(([x]) => x === k)[1]}</span>)}
              {foreign && <span className={`chip${financeSeat(r).lean === "abroad" ? " warn" : ""}`}>{financeSeat(r).verdict}</span>}
            </div>
            <div className="loss-fig">
              <b className="call-turnover">{uk ? `Score ${r.lead_score}` : fitOnly ? `Fit ${r.lead_fit}` : `Now ${r.lead_timing}`}</b>
              <span className="muted">{fitOnly ? `Now ${r.lead_timing || 0}` : `Fit ${r.lead_fit}`} · score {r.lead_score}</span>
            </div>
          </div>
          {(hidden || finds) && <ul className="call-why">{hiddenFromFilters(r).map((h) => <li key={h.key}><b>{h.label}:</b> {h.text}</li>)}</ul>}
          <ul className="call-why">{half(r, fitOnly ? "fit" : "timing").map(([why, p]) => <li key={why}>{why} <b>{p > 0 ? "+" : "−"}{Math.abs(p)}</b></li>)}</ul>
          {(fresh || finds) && r.found_via && <p className="panel-p muted">Found via {r.found_via_url
            ? <a href={r.found_via_url} target="_blank" rel="noreferrer">{r.found_via}</a> : r.found_via}</p>}
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

// Today's list: the best leads not marked yet, one line each — the company, its Companies House page, a Google search
// for it and for its finance director — and four buttons (TODAYS_MARKS); a mark takes it off and the next moves up.
function TodaysList({ rows, contacted, checks, verdicts, lists, onOpen, setVerdict, setReview, setList, notes = {}, saveNote, onWrap, onFinish }) {
  const [shown, setShown] = useState(TODAYS_LIST);
  const [last, setLast] = useState(null);   // the last mark, to undo: {number, name, key}
  const all = useMemo(() => todaysList(rows, { contacted, checks, verdicts, lists }), [rows, contacted, checks, verdicts, lists]);
  const done = markedToday({ checks, verdicts, lists });
  const labelOf = (key) => TODAYS_MARKS.find(([k]) => k === key)[2];
  const mark = (r, key) => {
    const n = r.company_number;
    if (key === "good") setVerdict(n, "good");
    else if (key === "small") setVerdict(n, "not_fit", "Too small");
    else if (key === "call") setList(n, "call");
    else setReview(n, key);   // research / open / abroad / skip
    setLast({ number: n, name: r.company_name, key });
  };
  const undo = () => {
    if (!last) return;
    if (last.key === "good" || last.key === "small") setVerdict(last.number, null);
    else if (last.key === "call") setList(last.number, null);
    else setReview(last.number, last.key);   // the same review again clears it
    setLast(null);
  };
  const open = (e, n) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onOpen(n); } };
  return (
    <div className="list daily">
      <div className="daily-head">
        <span className="muted">The best-ranked leads you haven't marked yet — {all.length.toLocaleString()} waiting{done ? `, ${done} marked today` : ""}.
          A mark takes the company off and the next one moves up. {onWrap && <button className="linkish" onClick={onWrap}>Your day so far →</button>}</span>
        <span className="daily-key">{TODAYS_MARKS.map(([k, sym, label]) => (
          <span key={k}><span className={`dot-btn dot-${k} dot-key`} aria-hidden="true">{sym}</span>{label}</span>))}</span>
        {onFinish && <button className="btn-sm wrap-primary" onClick={onFinish} title="Compile today's report and a document of the good leads to paste into Notion">Finish day</button>}
      </div>
      {last && <div className="daily-undo" role="status">{last.name}: {labelOf(last.key)}. <button className="linkish" onClick={undo}>Undo</button></div>}
      <ol className="daily-rows">
        {all.slice(0, shown).map((r, i) => (
          <li className="daily-row" key={r.company_number}>
            <span className="daily-n">{i + 1}</span>
            <div className="daily-main">
              <a className="co" href={companyPath(r.company_number)} onClick={(e) => open(e, r.company_number)}>{r.company_name}</a>
              <span className="daily-sub">{[industryOf(r), r.turnover_gbp ? `${money(r.turnover_gbp)}${r.turnover_basis === "group" ? " (group)" : ""}` : "no turnover filed",
                `score ${r.lead_score}`].join(" · ")}</span>
              <span className="daily-links">
                <span className="daily-number" title="Companies House number">{r.company_number}</span>
                <a href={googleCompany(r)} target="_blank" rel="noreferrer">Google it ↗</a>
                <a href={googleFd(r)} target="_blank" rel="noreferrer">Check for FD ↗</a>
              </span>
              <LineNote note={notes[r.company_number]} onSave={(text) => saveNote(r.company_number, text)} />
            </div>
            <span className="daily-btns" role="group" aria-label={`Mark ${r.company_name}`}>
              {TODAYS_MARKS.map(([k, sym, label]) => (
                <button key={k} className={`dot-btn dot-${k}`} title={label} aria-label={`${label}: ${r.company_name}`} onClick={() => mark(r, k)}>{sym}</button>))}
            </span>
          </li>
        ))}
      </ol>
      {all.length > shown && <button className="btn-sm daily-more" onClick={() => setShown(shown + TODAYS_LIST)}>Show {TODAYS_LIST} more</button>}
      {!all.length && <div className="empty">Nothing left to mark — every ranked lead has a mark.</div>}
    </div>
  );
}

// Your day (Zac, 23 Nov 2026: "a tracker of what I do each day … like a Spotify Wrapped of the day"): the day's marks
// told as a few big facts — how many leads, how he marked them, the sectors that worked and didn't, the best find, his
// pace, the day against the others, and what else got done. Worked out in the browser from his marks' own times
// (`dayWrap`, src/accounts/wrapped.js); any earlier day by the arrows or by clicking its column.
const WRAP_ICON = { good: ["✓", "good"], research: ["?", "research"], open: ["●", "open"], call: ["☎", "call"], mine: ["★", "open"],
  email: ["✉", "call"], post: ["✉", "call"], small: ["✕", "small"], abroad: ["✈︎", "abroad"], notfit: ["✕", "small"], skip: ["»", "skip"] };
const WRAP_BY = [["sector", "Sectors"], ["niche", "Niches"], ["source", "Where they came from"]];
function WrapIcon({ kind }) {
  const [sym, cls] = WRAP_ICON[kind] || ["•", "skip"];
  return <span className={`dot-btn dot-${cls} dot-key`} aria-hidden="true">{sym}</span>;
}
const clock = (d) => (d ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "");
// One of the day's tables (depthTables in wrapped.js): counts, share of the day and kept %, with a small meter on kept %.
const WIDE_TABLES = new Set(["sector", "signals", "niche"]);
function DepthTable({ t }) {
  const last = t.head.length - 1;
  const cls = (i) => [i ? "num" : "", t.minor?.includes(i) ? "minor" : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`depth${WIDE_TABLES.has(t.key) ? " depth-wide" : ""}`}>
      <h4>{t.title}</h4>
      {t.note && <p className="depth-note">{t.note}</p>}
      <div className="depth-scroll">
        <table className="depth-table">
          <thead><tr>{t.head.map((h, i) => <th key={i} className={cls(i)}>{h}</th>)}</tr></thead>
          <tbody>{t.rows.map((r, i) => (
            <tr key={i}>{r.cells.map((c, j) => (
              <td key={j} className={cls(j)}>
                {j === last && t.meter && r.rate != null
                  ? <span className="depth-rate"><span className="depth-meter" aria-hidden="true"><span style={{ width: `${Math.round(100 * r.rate)}%` }} /></span>{c}</span>
                  : c}
              </td>))}
            </tr>))}
          </tbody>
          {t.foot && <tfoot><tr>{t.foot.map((c, i) => <th key={i} className={cls(i)}>{c}</th>)}</tr></tfoot>}
        </table>
      </div>
    </div>
  );
}
const span = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
function YourDay({ rows, contacted, checks, verdicts, lists, notes = {}, onOpen, onBack, startReport = false, onReportClosed }) {
  const today = localDay(new Date().toISOString());
  const [day, setDay] = useState(today);
  const [by, setBy] = useState("sector");
  const [tip, setTip] = useState(null);   // the hovered / focused day column
  const [copied, setCopied] = useState(false);
  const w = useMemo(() => dayWrap(rows, { checks, verdicts, lists, contacted, notes }, day), [rows, checks, verdicts, lists, contacted, notes, day]);
  // Finish day: the day's report and its good leads as one document — copied for Notion (formatted, with the Markdown
  // underneath), downloaded as a .md file, or the good leads in Excel. Worked out from the marks; nothing is saved.
  const [report, setReport] = useState(!!startReport);
  const [docNote, setDocNote] = useState("");
  const reportRef = useRef(null);
  const rep = useMemo(() => (report ? dayReport(w, notes) : null), [report, w, notes]);
  const tables = useMemo(() => depthTables(w).filter((t) => t.key !== "marks"), [w]);
  useEffect(() => () => onReportClosed?.(), []);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (report) reportRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }); }, [report]);
  const closeReport = () => { setReport(false); onReportClosed?.(); };
  const flash = (text) => { setDocNote(text); setTimeout(() => setDocNote(""), 3000); };
  const copyDoc = async () => {
    const md = reportMarkdown(rep);
    try {
      if (window.ClipboardItem && navigator.clipboard?.write) {
        await navigator.clipboard.write([new window.ClipboardItem({ "text/html": new Blob([reportHtml(rep)], { type: "text/html" }), "text/plain": new Blob([md], { type: "text/plain" }) })]);
      } else await navigator.clipboard.writeText(md);
      flash("Copied — paste it into Notion");
    } catch {
      try { await navigator.clipboard.writeText(md); flash("Copied — paste it into Notion"); } catch { flash("Couldn't copy here — use Download"); }
    }
  };
  const downloadDoc = () => {
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([reportMarkdown(rep)], { type: "text/markdown" })), download: `fx-day-${day}.md` });
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const REPORT_COLUMNS = ["mark", "company_name", "company_number", "industry", "turnover_gbp", "lead_score", "website", "note", "marked_at", "companies_house"];
  const excelDoc = () => downloadSheet(rep.keepers.map((it) => ({ mark: it.mark, company_name: it.name, company_number: it.number, industry: it.industry,
    turnover_gbp: it.turnover, lead_score: it.lead_score, website: it.website, note: it.note, marked_at: it.at, companies_house: it.url })),
  columnsFor(REPORT_COLUMNS, { company_name: "Company", company_number: "Companies House number", turnover_gbp: "Turnover (£)", lead_score: "Score",
    marked_at: "Marked at", companies_house: "Companies House" }, ["turnover_gbp", "lead_score"]), `fx-good-leads-${day}.xlsx`, "Good leads");
  const isToday = day === today;
  const bars = OUTCOMES.filter(([k]) => w.counts[k]);
  const barMax = Math.max(1, ...bars.map(([k]) => w.counts[k]));
  const colMax = Math.max(1, ...w.history.map((h) => h.count));
  const vs = w.before.count ? w.looked - w.before.count : null;
  const top = w.worked[by][0], flop = w.didnt[by][0];
  const thing = { sector: "sector", niche: "niche", source: "best source" }[by];
  const copy = async () => {
    try { await navigator.clipboard.writeText(wrapText(w)); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* no clipboard: nothing to do */ }
  };
  const open = (e, n) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onOpen(n); } };
  const scoreLine = w.scores.keep != null && w.scores.drop != null
    ? (w.scores.keep > w.scores.drop + 2 ? "The score is pointing the right way."
      : w.scores.drop > w.scores.keep + 2 ? "The score liked some you didn't — your marks are teaching it."
        : "The score couldn't tell them apart today — your marks are teaching it.")
    : "";
  const done = [["call", "calls"], ["email", "emails"], ["linkedin", "LinkedIn touches"]].filter(([k]) => w.done[k]);
  return (
    <div className="wrap">
      <div className="wrap-top">
        <div className="wrap-nav">
          <button className="btn-sm" aria-label="The day before" onClick={() => setDay(shiftDay(day, -1))}>‹</button>
          <strong>{isToday ? "Today" : dayLabel(day)}</strong>{isToday && <span className="muted">{dayLabel(day)}</span>}
          <button className="btn-sm" aria-label="The day after" disabled={isToday} onClick={() => setDay(shiftDay(day, 1))}>›</button>
          {!isToday && <button className="linkish" onClick={() => setDay(today)}>Back to today</button>}
        </div>
        <div className="wrap-actions">
          <button className="btn-sm wrap-primary" onClick={() => setReport(true)}>{isToday ? "Finish day" : "Day report"}</button>
          <button className="btn-sm" onClick={copy} disabled={!w.looked}>{copied ? "Copied" : "Copy summary"}</button>
          <button className="btn-sm" onClick={onBack}>Today's list →</button>
        </div>
      </div>

      {rep && <section className="wrap-card wrap-report" ref={reportRef} aria-label="Day report">
        <div className="wrap-card-top">
          <h3>{isToday ? "Day finished — your report" : "Day report"}</h3>
          <button className="linkish" onClick={closeReport}>Close</button>
        </div>
        <div className="wrap-report-btns">
          <button className="btn-sm wrap-primary" onClick={copyDoc}>Copy for Notion</button>
          <button className="btn-sm" onClick={downloadDoc}>Download (.md)</button>
          <button className="btn-sm" onClick={excelDoc} disabled={!rep.keepers.length}>Good leads in Excel ({rep.keepers.length})</button>
          {docNote && <span className="wrap-tile-s" role="status">{docNote}</span>}
        </div>
        <article className="wrap-doc">
          <h1>{rep.title}</h1>
          <ul>{rep.summary.map((x) => <li key={x}>{x}</li>)}</ul>
          {rep.tables.length > 0 && <>
            <h2>The day in numbers</h2>
            <div className="depth-grid">{rep.tables.map((t) => <DepthTable key={t.key} t={t} />)}</div>
            <h2>The companies</h2>
          </>}
          {!rep.sections.length && <p className="muted">No keepers {isToday ? "yet today" : "that day"}.</p>}
          {rep.sections.map((sec) => (
            <Fragment key={sec.key}>
              <h2>{sec.title} ({sec.items.length})</h2>
              <ul>{sec.items.map((it) => (
                <li key={it.number}><strong>{it.name}</strong> — <a href={it.url} target="_blank" rel="noreferrer">{it.number}</a>
                  {it.website && <> · <a href={siteHref(it.website)} target="_blank" rel="noreferrer">website</a></>}{it.meta && ` · ${it.meta}`}
                  {it.note && <ul><li>Note: {it.note}</li></ul>}</li>))}</ul>
            </Fragment>))}
          {(rep.notFor.length > 0 || rep.skipped > 0) && <>
            <h2>Not for us</h2>
            <ul>{rep.notFor.map((x) => <li key={x.label}>{x.label} ({x.count}): {x.names.join(", ")}</li>)}
              {rep.skipped > 0 && <li>Skipped: {rep.skipped}</li>}</ul>
          </>}
        </article>
      </section>}

      <section className="wrap-hero" aria-label="Leads looked through">
        <div className="wrap-kicker">{isToday ? "Your day so far" : `Your ${dayLabel(day)}`}</div>
        <div className="wrap-big">{w.looked.toLocaleString()}</div>
        <div className="wrap-hero-l">{w.looked === 1 ? "lead looked through" : "leads looked through"}</div>
        {w.looked > 0
          ? <div className="wrap-hero-s">{w.keep} keepers · {w.drop} not for us · {w.skip} skipped</div>
          : <div className="wrap-hero-s">{isToday ? "Nothing marked yet — " : "Nothing marked that day. "}{isToday && <button className="wrap-hero-btn" onClick={onBack}>start on Today's list</button>}</div>}
        {vs != null && w.looked > 0 && <div className="wrap-hero-s">{vs > 0 ? `${vs} more than` : vs < 0 ? `${-vs} fewer than` : "The same as"} {dayLabel(w.before.day)} ({w.before.count})</div>}
      </section>

      <div className="wrap-tiles">
        <div className="wrap-tile"><div className="wrap-tile-l">Keepers</div><div className="wrap-tile-v">{w.keepRate == null ? "–" : `${w.keepRate}%`}</div>
          <div className="wrap-tile-s">{w.keep} of {w.keep + w.drop} judged</div></div>
        <div className="wrap-tile"><div className="wrap-tile-l">Good leads</div><div className="wrap-tile-v">{w.counts.good + w.counts.research}</div>
          <div className="wrap-tile-s">{w.counts.research ? `${w.counts.research} to research harder` : "✓ and ?"}</div></div>
        <div className="wrap-tile"><div className="wrap-tile-l">Open leads</div><div className="wrap-tile-v">{w.counts.open}</div>
          <div className="wrap-tile-s">{w.counts.mine ? `+ ${w.counts.mine} added to mine` : "●"}</div></div>
        <div className="wrap-tile"><div className="wrap-tile-l">To the call list</div><div className="wrap-tile-v">{w.counts.call}</div>
          <div className="wrap-tile-s">{w.counts.email + w.counts.post ? `+ ${w.counts.email + w.counts.post} email / mail` : "☎"}</div></div>
        <div className="wrap-tile"><div className="wrap-tile-l">Pace</div><div className="wrap-tile-v">{w.pace.perHour ?? "–"}</div>
          <div className="wrap-tile-s">{w.pace.perHour ? "leads an hour" : "a few marks needed"}</div></div>
        <div className="wrap-tile"><div className="wrap-tile-l">Streak</div><div className="wrap-tile-v">{w.streak}</div>
          <div className="wrap-tile-s">{w.streak === 1 ? "day" : "days in a row"}</div></div>
      </div>

      {w.looked > 0 && <section className="wrap-card">
        <h3>How you marked them</h3>
        <div className="wrap-bars">
          {bars.map(([k, label]) => (
            <div className="wrap-bar" key={k} title={`${label}: ${w.counts[k]} (${Math.round((100 * w.counts[k]) / w.looked)}%)`}>
              <span className="wrap-bar-l"><WrapIcon kind={k} />{label}</span>
              <span className="wrap-bar-t"><span className="wrap-bar-f" style={{ width: `${(70 * w.counts[k]) / barMax}%` }} />
                <span className="wrap-bar-n">{w.counts[k]}</span><span className="wrap-bar-p">{Math.round((100 * w.counts[k]) / w.looked)}%</span></span>
            </div>
          ))}
        </div>
      </section>}

      {w.looked > 0 && <section className="wrap-card">
        <div className="wrap-card-top">
          <h3>What worked</h3>
          <span className="seg" role="group" aria-label="Group by">
            {WRAP_BY.map(([k, label]) => <button key={k} className={by === k ? "on" : ""} aria-pressed={by === k} onClick={() => setBy(k)}>{label}</button>)}
          </span>
        </div>
        {top && <p className="wrap-head">{top.key} was your {thing} — {top.keep} of {top.keep + top.drop} kept.</p>}
        {!top && <p className="wrap-head">Nothing kept {isToday ? "yet today" : "that day"}.</p>}
        <div className="wrap-cols2">
          <div>
            <div className="wrap-sub">Worked</div>
            {w.worked[by].map((e) => (
              <div className="wrap-item" key={e.key}>
                <div className="wrap-item-t"><span>{e.key}</span><span className="wrap-item-n">{e.keep} of {e.keep + e.drop} kept{e.skip ? ` · ${e.skip} skipped` : ""}</span></div>
                <div className="wrap-meter" title={`${Math.round(100 * (e.rate ?? 1))}% kept`}><span style={{ width: `${Math.round(100 * (e.rate ?? 1))}%` }} /></div>
              </div>))}
            {!w.worked[by].length && <div className="muted">—</div>}
          </div>
          <div>
            <div className="wrap-sub">Didn't land</div>
            {w.didnt[by].map((e) => (
              <div className="wrap-item" key={e.key}>
                <div className="wrap-item-t"><span>{e.key}</span><span className="wrap-item-n">{e.keep} of {e.keep + e.drop} kept{e.mainDrop ? ` · mostly ${outcomeLabel(e.mainDrop).toLowerCase()}` : ""}</span></div>
                <div className="wrap-meter" title={`${Math.round(100 * e.rate)}% kept`}><span style={{ width: `${Math.round(100 * e.rate)}%` }} /></div>
              </div>))}
            {!w.didnt[by].length && <div className="muted">Nothing fell flat (two or more judged, a third or fewer kept).</div>}
          </div>
        </div>
        {flop && <p className="wrap-foot">{flop.key} didn't land: {flop.keep} of {flop.keep + flop.drop} kept{flop.mainDrop ? `, mostly ${outcomeLabel(flop.mainDrop).toLowerCase()}` : ""}.</p>}
      </section>}

      {tables.length > 0 && <section className="wrap-card" aria-label="The day in numbers">
        <h3>The day in numbers</h3>
        <p className="wrap-head">{w.looked} looked through · {w.keep} kept ({w.looked ? Math.round((100 * w.keep) / w.looked) : 0}%) · {w.drop} not for us ({w.looked ? Math.round((100 * w.drop) / w.looked) : 0}%) · {w.skip} skipped ({w.looked ? Math.round((100 * w.skip) / w.looked) : 0}%)</p>
        <div className="depth-grid">{tables.map((t) => <DepthTable key={t.key} t={t} />)}</div>
      </section>}

      {w.looked > 0 && <div className="wrap-grid">
        {w.best && <section className="wrap-card">
          <h3>Best find</h3>
          <a className="wrap-find" href={companyPath(w.best.company_number)} onClick={(e) => open(e, w.best.company_number)}>{w.best.company_name}</a>
          <div className="wrap-tile-s">{[w.best.industry, w.best.turnover ? `${money(w.best.turnover)}${w.best.turnover_basis === "group" ? " (group)" : ""}` : "",
            `score ${w.best.lead_score}`].filter(Boolean).join(" · ")}</div>
          <div className="wrap-tile-s"><WrapIcon kind={w.best.kind} /> {outcomeLabel(w.best.kind)}</div>
        </section>}
        {(w.scores.keep != null || w.sizes.keep) && <section className="wrap-card">
          <h3>The score and you</h3>
          {w.scores.keep != null && <p className="wrap-line">Your keepers scored <strong>{w.scores.keep}</strong> on average{w.scores.drop != null ? <>, the ones you ruled out <strong>{w.scores.drop}</strong></> : ""}.</p>}
          {scoreLine && <p className="wrap-line">{scoreLine}</p>}
          {w.sizes.keep && <p className="wrap-line muted">Median size: keepers {money(w.sizes.keep)}{w.sizes.drop ? `, ruled out ${money(w.sizes.drop)}` : ""}.</p>}
        </section>}
        {w.pace.first && <section className="wrap-card">
          <h3>Your pace</h3>
          <p className="wrap-line">First mark <strong>{clock(w.pace.first)}</strong>{w.pace.minutes ? <>, last <strong>{clock(w.pace.last)}</strong> ({span(w.pace.minutes)})</> : ""}.</p>
          {w.pace.perHour && <p className="wrap-line">About <strong>{w.pace.perHour}</strong> leads an hour.</p>}
          {w.pace.busyHour != null && w.pace.busyCount > 1 && <p className="wrap-line muted">Busiest hour: {String(w.pace.busyHour).padStart(2, "0")}:00–{String(w.pace.busyHour + 1).padStart(2, "0")}:00, {w.pace.busyCount} marked.</p>}
        </section>}
        <section className="wrap-card">
          <h3>Also done</h3>
          {done.length || w.done.contacted || w.done.notes ? <>
            {done.length > 0 && <p className="wrap-line">Ticked off: {done.map(([k, label]) => `${w.done[k]} ${label}`).join(", ")}.</p>}
            {w.done.contacted > 0 && <p className="wrap-line">Contacted <strong>{w.done.contacted}</strong> {w.done.contacted === 1 ? "company" : "companies"}{w.done.touches > w.done.contacted ? ` (${w.done.touches} touches)` : ""}{Object.keys(w.done.channels).length ? ` — ${Object.entries(w.done.channels).map(([c, n]) => `${n} ${c === "in_person" ? "in person" : c}`).join(", ")}` : ""}.</p>}
            {w.done.notes > 0 && <p className="wrap-line muted">{w.done.notes} {w.done.notes === 1 ? "note" : "notes"} written.</p>}
          </> : <p className="wrap-line muted">No calls, emails or contacts ticked off {isToday ? "yet" : "that day"}.</p>}
        </section>
      </div>}

      <section className="wrap-card">
        <div className="wrap-card-top">
          <h3>Leads looked through, last 14 days</h3>
          <span className="wrap-tile-s">{w.average != null ? `Your average day ${w.average}` : ""}{w.bestDay ? ` · best ${w.bestDay.count} on ${dayLabel(w.bestDay.day)}` : ""}</span>
        </div>
        <div className="wrap-chart" onMouseLeave={() => setTip(null)}>
          {tip != null && <div className="wrap-tip" style={{ left: `${((tip + 0.5) / w.history.length) * 100}%` }}>
            <strong>{w.history[tip].count}</strong><span>{dayLabel(w.history[tip].day)}</span></div>}
          <div className="wrap-colset">
            {w.history.map((h, i) => (
              <button key={h.day} className={`wrap-col${h.day === day ? " on" : ""}`} aria-label={`${dayLabel(h.day)}: ${h.count} looked through`}
                      onMouseEnter={() => setTip(i)} onFocus={() => setTip(i)} onBlur={() => setTip(null)} onClick={() => setDay(h.day)}>
                {(h.day === day || (w.bestDay && h.day === w.bestDay.day)) && h.count > 0 && <span className="wrap-col-v">{h.count}</span>}
                <span className="wrap-col-f" style={{ height: `${(100 * h.count) / colMax}%` }} />
              </button>))}
          </div>
          <div className="wrap-x" aria-hidden="true">{w.history.map((h) => <span key={h.day}>{dayLabel(h.day).split(" ")[1]}</span>)}</div>
        </div>
        <details className="wrap-table"><summary>As a table</summary>
          <table><tbody>{w.history.filter((h) => h.count).map((h) => <tr key={h.day}><td>{dayLabel(h.day)}</td><td>{h.count}</td></tr>)}</tbody></table>
        </details>
      </section>

      {w.looked > 0 && <details className="wrap-card wrap-all">
        <summary>Every company you marked {isToday ? "today" : "that day"} ({w.looked})</summary>
        <ol>
          {[...w.marked].reverse().map((a) => (
            <li key={a.n}>
              <WrapIcon kind={a.kind} />
              {a.r ? <a href={companyPath(a.n)} onClick={(e) => open(e, a.n)}>{a.r.company_name}</a> : <span>{a.n}</span>}
              <span className="muted">{[outcomeLabel(a.kind), a.r ? industryOf(a.r) : "", /T\d/.test(String(a.at)) ? clock(new Date(a.at)) : ""].filter(Boolean).join(" · ")}</span>
            </li>))}
        </ol>
      </details>}
    </div>
  );
}

// A company's note on a Today's list / Research harder line: shown when there is one, "✎ Add note" opens a box (saved to
// the store key `notes`, the same note the cards and the company page show).
function LineNote({ note, onSave }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(note?.text || "");
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (!open) setText(note?.text || ""); }, [note, open]);
  const save = async () => {
    setSaving(true);
    const ok = await onSave(text);
    setSaving(false);
    if (ok) setOpen(false);
  };
  if (open) {
    return (
      <div className="daily-note">
        <textarea className="input" rows={3} value={text} autoFocus maxLength={4000} placeholder="Who you spoke to, what to check, when to try again…"
                  onChange={(e) => setText(e.target.value)} aria-label="Note" />
        <span className="daily-note-btns">
          <button className="btn-sm" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save note"}</button>
          <button className="linkish" onClick={() => setOpen(false)}>Cancel</button>
        </span>
      </div>
    );
  }
  return (
    <div className="daily-note">
      {note?.text && <span className="daily-note-text">{note.text}</span>}
      <button className="linkish" onClick={() => setOpen(true)}>✎ {note?.text ? "Edit note" : "Add note"}</button>
    </div>
  );
}

// Research harder (Zac, 23 Nov 2026): the good leads he marked ? on Today's list because nobody to call was found yet.
// The same line as Today's list, with a LinkedIn people search, and buttons to move it on: ☎ Call list once a contact
// turns up, ✕ Not enough revenue, » Skip, or back to Today's list.
function ResearchHarder({ rows, contacted, checks, lists, onOpen, setVerdict, setReview, setList, notes = {}, saveNote }) {
  const list = researchList(rows, { contacted, checks, lists });
  const open = (e, n) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onOpen(n); } };
  const linkedin = (r) => "https://www.google.com/search?" + new URLSearchParams({ q: `site:linkedin.com/in "${r.company_name}" (finance director OR CFO OR financial controller)` });
  const exportList = () => downloadSheet(list.map((r) => ({
    company_name: r.company_name, company_number: r.company_number, industry: industryOf(r), turnover_gbp: r.turnover_gbp || "",
    lead_score: r.lead_score, marked_on: String(checks[r.company_number]?.review_at || "").slice(0, 10), note: notes[r.company_number]?.text || "",
    google: googleCompany(r), check_for_fd: googleFd(r), companies_house_url: chCompanyUrl(r.company_number),
  })), columnsFor(["company_name", "company_number", "industry", "turnover_gbp", "lead_score", "marked_on", "note", "google", "check_for_fd", "companies_house_url"],
    { turnover_gbp: "Turnover (£)", marked_on: "Marked on", check_for_fd: "Check for FD" }, ["turnover_gbp", "lead_score"]),
    `research-harder-${new Date().toISOString().slice(0, 10)}.xlsx`, "Research harder");
  const moves = [["call", "☎", "Found a contact: Call list"], ["small", "✕", "Not enough revenue"], ["skip", "»", "Skip (no reason kept)"],
    ["back", "↺", "Back to Today's list"]];
  const move = (r, key) => {
    const n = r.company_number;
    if (key === "call") setList(n, "call");
    else if (key === "small") setVerdict(n, "not_fit", "Too small");
    else if (key === "skip") setReview(n, "skip");
    else setReview(n, "research");   // the same review again clears it: back to Today's list
  };
  return (
    <div className="list daily">
      <div className="daily-head">
        <span className="muted">{list.length} good leads with no contact info yet, newest first. Found someone? ☎ puts it on your Call list.</span>
        <button className="btn-sm export" onClick={exportList} disabled={!list.length}>Export Excel ({list.length})</button>
      </div>
      <ol className="daily-rows">
        {list.map((r, i) => (
          <li className="daily-row" key={r.company_number}>
            <span className="daily-n">{i + 1}</span>
            <div className="daily-main">
              <a className="co" href={companyPath(r.company_number)} onClick={(e) => open(e, r.company_number)}>{r.company_name}</a>
              <span className="daily-sub">{[industryOf(r), r.turnover_gbp ? money(r.turnover_gbp) : "no turnover filed", `score ${r.lead_score}`,
                `marked ${String(checks[r.company_number]?.review_at || "").slice(0, 10)}`].join(" · ")}</span>
              <span className="daily-links">
                <span className="daily-number" title="Companies House number">{r.company_number}</span>
                <a href={googleCompany(r)} target="_blank" rel="noreferrer">Google it ↗</a>
                <a href={googleFd(r)} target="_blank" rel="noreferrer">Check for FD ↗</a>
                <a href={linkedin(r)} target="_blank" rel="noreferrer">Finance people on LinkedIn ↗</a>
              </span>
              <LineNote note={notes[r.company_number]} onSave={(text) => saveNote(r.company_number, text)} />
            </div>
            <span className="daily-btns" role="group" aria-label={`Move ${r.company_name} on`}>
              {moves.map(([k, sym, label]) => (
                <button key={k} className={`dot-btn dot-${k}`} title={label} aria-label={`${label}: ${r.company_name}`} onClick={() => move(r, k)}>{sym}</button>))}
            </span>
          </li>
        ))}
      </ol>
      {!list.length && <div className="empty">Nothing to research — mark a good lead with no contact info ? on Today's list.</div>}
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
// The phone layout (Zac, 22 Nov 2026: about 30 tabs were too many on a phone): five sections, each with its own tabs;
// the section in use is remembered in this browser. "All tabs" shows every tab, as before.
const TAB_SECTIONS = [
  ["today", "Today", ["daily", "wrapped", "today", "calls", "outreach", "alerts", "contacted", "email"]],
  ["fresh", "Fresh finds", ["fresh", "new", "hidden", "jobs", "emerging", "search", "money"]],
  ["lists", "My lists", ["list-call", "list-email", "list-post", "research", "simple"]],
  ["learn", "Learn", ["scoreboard", "niches"]],
  ["all", "All tabs", null],
];
const sectionOf = (view) => TAB_SECTIONS.find(([, , views]) => views?.includes(view))?.[0] || "all";
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
  if (!name && !members.length && !abroad && !groupActivity(r)) return null;
  return (<>
    {name && <span className="chip" title={`Top UK parent: ${name} (${groupOf(r).top})${abroad ? ` — owned by ${abroad}` : ""}`}>Group: {name}</span>}
    {!name && abroad && <span className="chip" title="Its corporate owner is registered abroad">Owner abroad: {abroad}</span>}
    {groupActivity(r) && <span className="chip good" title={`A holding company: what its group trades, from ${activityLine(groupActivity(r))} (sector codes ${groupActivity(r).sic.join(", ")})${groupActivity(r).niche ? ` — niche ${groupActivity(r).niche}` : ""}`}>
      Group trades as: {industryOf(r).replace(/^Manufacturing: /, "")}</span>}
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
.sheet .actions-col { white-space: nowrap; }
.review-btns { display: inline-flex; gap: 4px; }
.review-btns .btn-sm { opacity: .7; }
.review-btns .btn-sm.on { opacity: 1; font-weight: 600; }
.review-btns .review-open.on { background: #14532d; border-color: #22c55e; color: #dcfce7; }
.review-btns .review-mine.on { background: #1e3a8a; border-color: #60a5fa; color: #dbeafe; }
.review-btns .review-abroad.on { background: #78350f; border-color: #f59e0b; color: #fef3c7; }
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
.card .quote{margin:8px 0 0;font-style:italic;color:var(--ink-2,inherit);line-height:1.45}
.adverts{margin:8px 0 0;padding-left:18px;line-height:1.6}
.adverts .muted{font-size:12px}
.sheet .sub-row td{font-size:12px;opacity:.9}
.bulk-mark{margin:12px 0;padding:10px 12px;border:1px solid var(--line,#333);border-radius:6px}
.bulk-mark summary{cursor:pointer;font-weight:600}
.bulk-mark textarea{width:100%;margin:8px 0;font:inherit}
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
.sheet th.actions-col,.sheet td.actions-col{max-width:none;overflow:visible;text-overflow:clip;padding:4px 8px}
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
.tab[hidden]{display:none}
.daily-head{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between;margin:4px 0 12px}
.daily-key{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--text-2)}
.daily-key>span{display:inline-flex;align-items:center;gap:6px}
.daily-undo{margin:0 0 10px;padding:8px 12px;border:1px solid var(--line);border-radius:6px;background:var(--surface);font-size:13px}
.daily-rows{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:6px;background:var(--surface)}
.daily-row{display:flex;align-items:center;gap:12px;padding:10px 12px;border-bottom:1px solid var(--line-soft)}
.daily-row:last-child{border-bottom:0}
.daily-n{flex:0 0 auto;min-width:22px;color:var(--muted);font-size:12px;text-align:right;font-variant-numeric:tabular-nums}
.daily-main{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:3px}
.daily-main .co{font-weight:600;overflow-wrap:anywhere}
.daily-sub{font-size:12px;color:var(--muted)}
.daily-links{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:13px}
.daily-links a{color:var(--accent);text-decoration:none}
.daily-links a:hover{text-decoration:underline}
.daily-number{color:var(--text-2);font-variant-numeric:tabular-nums;user-select:all}
.daily-btns{flex:0 0 auto;display:flex;gap:8px}
.dot-btn{--c:#9aa0a6;width:36px;height:36px;border-radius:50%;border:2px solid var(--c);background:transparent;color:var(--c);font:700 16px/1 'Inter',sans-serif;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}
.dot-btn:hover,.dot-btn:focus-visible{background:var(--c);color:var(--bg);outline:none}
.dot-good{--c:#81c995}.dot-small{--c:#f28b82}.dot-open{--c:#fcad70}.dot-call{--c:#8ab4f8}.dot-abroad{--c:#c58af9}.dot-skip{--c:#9aa0a6}
.dot-research{--c:#fdd663}.dot-back{--c:#9aa0a6}
.daily-note{display:flex;flex-direction:column;align-items:flex-start;gap:6px;font-size:13px;margin-top:2px}
.daily-note-text{color:var(--text-2);white-space:pre-wrap;overflow-wrap:anywhere;border-left:2px solid var(--line);padding-left:8px}
.daily-note textarea{width:100%;min-height:64px;resize:vertical;font:13px/1.4 'Inter',sans-serif}
.daily-note-btns{display:flex;gap:12px;align-items:center}
.daily-key .dot-key,.daily-key .dot-key:hover{width:22px;height:22px;font-size:12px;border-width:1.5px;cursor:default;background:transparent;color:var(--c)}
.daily-more{margin-top:12px}
@media(max-width:700px){.daily-row{flex-wrap:wrap;gap:8px 10px}.daily-btns{width:100%;justify-content:flex-end;gap:7px}.dot-btn{width:38px;height:38px}}
.sections{display:flex;gap:0;margin-bottom:10px;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--surface)}
.section-btn{flex:1 1 0;min-width:0;padding:9px 6px;border:0;border-right:1px solid var(--line);background:none;color:var(--text-2);font:600 13px 'Inter',sans-serif;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.section-btn:last-child{border-right:0}
.section-btn:hover{background:var(--surface-2);color:var(--text)}
.section-btn.on{background:#2d3a4d;color:#d2e3fc}
.fresh-kinds{flex-wrap:wrap}
.daily-view .tb{display:none}
@media(max-width:700px){.daily-view .sections{top:0}}
/* Today's list and Your day on white (Zac, 23 Nov 2026: "make the page white … the leads today page"): the theme's
   tokens stepped for a light surface; the mark buttons' hues darkened to 3:1+ on white (validated as a set, dataviz
   validate_palette.js --mode light; each button also has its own symbol and label, so no colour stands alone) */
body.daily-view{color-scheme:light;--bg:#ffffff;--surface:#ffffff;--surface-2:#f3f3f1;--head:#f6f6f4;--line:#dddcd7;--line-soft:#ecebe7;
  --text:#0b0b0b;--text-2:#3d3c39;--muted:#6f6e69;--accent:#1a5fb4;--series:#2a78d6;--good:#188038;--warn:#a87b00}
body.daily-view .controls{border-bottom:1px solid var(--line)}
body.daily-view .tab.on,body.daily-view .section-btn.on,body.daily-view .seg button.on{background:#e8f0fe;border-color:#aecbfa;color:#174ea6}
body.daily-view .btn-sm:hover,body.daily-view .section-btn:hover{background:#e9e9e6;color:var(--text)}
body.daily-view .empty{color:var(--muted)}
body.daily-view .dot-good{--c:#188038}body.daily-view .dot-research{--c:#a87b00}body.daily-view .dot-small{--c:#c5221f}
body.daily-view .dot-open{--c:#e8710a}body.daily-view .dot-call{--c:#1a73e8}body.daily-view .dot-abroad{--c:#9334e6}
body.daily-view .dot-skip,body.daily-view .dot-back{--c:#5f6368}
body.daily-view .daily-row:hover{background:#fafaf8}
body.daily-view .co{color:var(--text)}body.daily-view a.co:hover{color:var(--accent)}
/* Your day: a Wrapped-style page — one hero figure, stat tiles, then cards; the history columns and keep meters on the
   reference blue ramp (selected day #2a78d6, the rest #86b6ef; meter #2a78d6 on its #cde2fb track) */
.wrap{max-width:980px;margin:0 auto;padding:16px 40px 80px;display:flex;flex-direction:column;gap:14px}
.wrap-top{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px}
.wrap-nav{display:flex;align-items:center;gap:10px;font-size:15px}
.wrap-nav .btn-sm{font-size:16px;line-height:1;padding:6px 11px}
.wrap-actions{display:flex;gap:8px}
.wrap-hero{border-radius:16px;padding:26px 28px 24px;background:#0d366b;color:#fff}
.wrap-kicker{font:600 12px 'Inter',sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#cde2fb}
.wrap-big{font:700 76px/1 'Inter',sans-serif;margin:10px 0 4px;letter-spacing:-.02em}
.wrap-hero-l{font:600 20px 'Inter',sans-serif}
.wrap-hero-s{margin-top:8px;font-size:14px;color:#cde2fb}
.wrap-hero-btn{background:none;border:0;padding:0;color:#fff;text-decoration:underline;font:inherit;cursor:pointer}
.wrap-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.wrap-tile{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.wrap-tile-l{font-size:12px;color:var(--muted)}
.wrap-tile-v{font:700 30px/1.2 'Inter',sans-serif;color:var(--text)}
.wrap-tile-s{font-size:12px;color:var(--text-2);display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.wrap-card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px 18px;min-width:0}
.wrap-card h3{margin:0 0 10px;font:600 13px 'Inter',sans-serif;color:var(--muted)}
.wrap-card-top{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:6px}
.wrap-card-top h3{margin:0}
.wrap-head{font:700 20px/1.3 'Inter',sans-serif;color:var(--text);margin:6px 0 14px}
.wrap-bars{display:flex;flex-direction:column;gap:8px}
.wrap-bar{display:grid;grid-template-columns:minmax(140px,210px) 1fr;align-items:center;gap:10px;font-size:13px}
.wrap-bar-l{display:flex;align-items:center;gap:8px;color:var(--text-2)}
.wrap-bar-t{display:flex;align-items:center;gap:8px;min-width:0}
.wrap-bar-f{height:16px;min-width:3px;background:var(--series);border-radius:0 4px 4px 0}
.wrap-bar-n{font-weight:600;color:var(--text);font-variant-numeric:tabular-nums}
.wrap .dot-key{width:22px;height:22px;font-size:12px;border-width:1.5px;flex:0 0 auto}
.wrap .dot-key:hover{background:transparent;color:var(--c)}
.wrap-cols2{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.wrap-sub{font:600 12px 'Inter',sans-serif;color:var(--muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em}
.wrap-item{margin-bottom:10px}
.wrap-item-t{display:flex;justify-content:space-between;gap:8px;font-size:13px;color:var(--text)}
.wrap-item-n{color:var(--text-2);white-space:nowrap}
.wrap-meter{height:8px;border-radius:4px;background:#cde2fb;margin-top:4px;overflow:hidden}
.wrap-meter span{display:block;height:100%;background:#2a78d6;border-radius:4px}
.wrap-foot{margin:6px 0 0;font-size:13px;color:var(--text-2)}
.wrap-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px}
.wrap-find{display:block;font:700 18px/1.3 'Inter',sans-serif;color:var(--text);text-decoration:none;margin-bottom:4px}
.wrap-find:hover{text-decoration:underline}
.wrap-line{margin:0 0 6px;font-size:14px;color:var(--text)}
.wrap-chart{position:relative;padding-top:26px}
.wrap-colset{display:flex;align-items:flex-end;gap:2px;height:140px;border-bottom:1px solid var(--line)}
.wrap-col{flex:1 1 0;min-width:0;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;background:none;border:0;padding:0;cursor:pointer}
.wrap-col-f{display:block;width:70%;max-width:24px;background:#86b6ef;border-radius:4px 4px 0 0}
.wrap-col.on .wrap-col-f{background:#2a78d6}
.wrap-col:hover .wrap-col-f,.wrap-col:focus-visible .wrap-col-f{background:#256abf}
.wrap-col:focus-visible{outline:2px solid #aecbfa;outline-offset:2px}
.wrap-col-v{font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:3px}
.wrap-x{display:flex;gap:2px;margin-top:4px}
.wrap-x span{flex:1 1 0;text-align:center;font-size:10px;color:var(--muted)}
.wrap-tip{position:absolute;top:0;transform:translateX(-50%);background:#0b0b0b;color:#fff;border-radius:6px;padding:3px 8px;font-size:12px;white-space:nowrap;pointer-events:none;display:flex;gap:6px;z-index:2}
.wrap-table{margin-top:10px;font-size:12px;color:var(--text-2)}
.wrap-table summary,.wrap-all summary{cursor:pointer;color:var(--accent)}
.wrap-table table{margin-top:6px;border-collapse:collapse}
.wrap-table td{padding:2px 14px 2px 0;font-variant-numeric:tabular-nums}
.wrap-all ol{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}
.wrap-all li{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;font-size:13px}
.wrap-all li a{color:var(--text);font-weight:600}
.wrap-bar-p{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.depth-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr));gap:22px 26px}
.depth{min-width:0}.depth-wide{grid-column:1/-1}
.depth h4{margin:0 0 6px;font:600 13px 'Inter',sans-serif;color:var(--text)}
.depth-note{margin:0 0 6px;font-size:12px;color:var(--muted)}
.depth-scroll{overflow-x:auto}
.depth-table{width:100%;border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums}
.depth-table th{font-weight:600;color:var(--muted);text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
.depth-table td{padding:5px 8px;border-bottom:1px solid var(--line-soft);color:var(--text)}
.depth-table .num{text-align:right;white-space:nowrap}
.depth-table tfoot th{color:var(--text);border-bottom:0}
.depth-rate{display:inline-flex;align-items:center;gap:6px;justify-content:flex-end}
.depth-meter{display:inline-block;width:38px;height:6px;border-radius:3px;background:#cde2fb;overflow:hidden}
.depth-meter span{display:block;height:100%;background:#2a78d6;border-radius:3px}
.wrap-doc .depth-grid{margin:6px 0 4px}
.depth-table td:first-child{min-width:7.5em}
@media(max-width:700px){.depth-table .minor,.depth-meter{display:none}.depth-table{font-size:12px}.depth-table th{font-size:11px}.depth-table th,.depth-table td{padding:5px 4px}
  .depth-table td:first-child{min-width:6.5em}}
body.daily-view .wrap-primary{background:#1a73e8;border-color:#1a73e8;color:#fff}
body.daily-view .wrap-primary:hover{background:#1765cc;border-color:#1765cc;color:#fff}
.wrap-report{border-color:#aecbfa;scroll-margin-top:12px}
.wrap-report-btns{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:4px 0 14px}
.wrap-doc{border:1px solid var(--line-soft);border-radius:8px;padding:18px 22px;background:#fcfcfb;font-size:14px;line-height:1.55;color:var(--text);overflow-wrap:anywhere}
.wrap-doc h1{font:700 22px/1.3 'Inter',sans-serif;margin:0 0 10px}
.wrap-doc h2{font:700 16px/1.3 'Inter',sans-serif;margin:18px 0 6px}
.wrap-doc ul{margin:0 0 4px;padding-left:20px}
.wrap-doc li{margin:3px 0}
.wrap-doc a{color:var(--accent)}
@media(max-width:700px){.wrap{padding:12px 16px 60px}.wrap-big{font-size:60px}.wrap-hero{padding:22px 20px}
  .wrap-tiles{grid-template-columns:1fr 1fr}.wrap-cols2,.wrap-grid{grid-template-columns:1fr}.wrap-item-t{flex-direction:column;gap:0}.wrap-item-n{white-space:normal}.wrap-bar{grid-template-columns:150px 1fr}
  .wrap-actions{width:100%}.wrap-actions .btn-sm{flex:1 1 0}.wrap-doc{padding:14px}}
@media(max-width:700px){.sections{position:sticky;top:52px;z-index:5}.section-btn{font-size:12px;padding:10px 2px}
  .tabs,.fresh-kinds{flex-wrap:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:4px}.tab,.fresh-kinds .grp{flex:0 0 auto}
  .tb-l{flex:0 0 auto}.tb-r{min-width:0;overflow-x:auto;flex-wrap:nowrap}.tb-r>*{flex:0 0 auto}}
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
.feed-panel{position:absolute;right:16px;top:56px;z-index:50;width:min(560px,calc(100vw - 32px));background:var(--bg2,#1e1f22);border:1px solid var(--line,#33353a);border-radius:8px;padding:14px;display:flex;flex-direction:column;gap:8px;box-shadow:0 8px 24px rgba(0,0,0,.4);text-align:left}.feed-panel p{margin:0;font-size:12px}.feed-actions{display:flex;gap:6px;flex-wrap:wrap}.tb-r{position:relative}
`;
