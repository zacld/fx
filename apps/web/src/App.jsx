import { useEffect, useState, useCallback, useMemo } from "react";
import { DailyCallListView, FollowupsDueSection, UnverifiedRevenueSection } from "./dashboard/CallListViews.jsx";
import { CompanyLookupView } from "./dashboard/CompanyLookupView.jsx";
import { EventItem } from "./dashboard/EventItem.jsx";
import { FilterBar } from "./dashboard/FilterBar.jsx";
import { computeRouteGrade, useCrmState } from "./dashboard/crm.js";
import { downloadCSV } from "./dashboard/csv.js";
import { fetchData, rememberPw, rememberedPw } from "./dashboard/data.js";
import { ALL_FILTERS, BLANK_FILTERS, CALL_LIST_FILTERS, NEW_FILTERS, RESEARCH_FILTERS, applyFilters, dedupeForReady, isCallListEligible, sizeFit, sortByReadyScore } from "./dashboard/filters.js";
import { ago, dateShort, today, urg } from "./dashboard/format.js";
import { CSS } from "./dashboard/styles.js";

// ─── ROOT APP ────────────────────────────────────────────────────
export default function App() {
  const [events,  setEvents]  = useState([]);
  const [leads,   setLeads]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [lastRef, setLast]    = useState(null);
  const [filters, setFilters] = useState(NEW_FILTERS);
  const [password, setPassword] = useState(rememberedPw);
  const [locked,  setLocked]  = useState(false);
  const [lockErr, setLockErr] = useState("");
  const { state: crmState, getLead, getStatus: getCrmStatus, updateLead, performAction } = useCrmState();

  const load = useCallback(async(pw = rememberedPw())=>{
    setLoading(true);
    try {
      const d = await fetchData(pw);
      setEvents(d.events); setLeads(d.leads); setLast(new Date());
      setLocked(d.locked); setLockErr(d.error);
      if (!d.locked && pw) rememberPw(pw);
      if (d.locked && pw) rememberPw("");
    } catch(e){console.error(e); setLockErr("Couldn't load the leads.");}
    finally{setLoading(false);}
  },[]);

  useEffect(()=>{ load(); },[load]);

  function downloadCsv(text, filename) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }

  function exportLeadsToCsv(list, filename) {
    const header = ['Company','Website','Director','Role','Phone','Email','LinkedIn search','FX exposure','Route grade','Confidence','Next action','Status','Notes'];
    const rows = [header];
    list.forEach(l=>{
      const crm = crmState[l.id]||{};
      const email = (l.guessed_emails&&l.guessed_emails[0]&&l.guessed_emails[0].email) || "";
      const li = (l.linkedin_assist&&l.linkedin_assist.company_search) || "";
      const row = [l.company_name||"", l.website||"", l.director_name||"", l.director_role||"", l.phone||"", email, li, l.fx_exposure||"", computeRouteGrade(l), l.website_confidence||"", crm.next_follow_up_at||"", crm.status||l.status||"", (crm.notes||"").replace(/\n/g,' ')];
      rows.push(row.map(cell=>`"${String(cell||"").replace(/"/g,'""')}"`));
    });
    const text = rows.map(r=>Array.isArray(r)?r.join(","):r.join(",")).join("\n");
    downloadCsv(text, filename);
  }

  const filteredLeads  = useMemo(()=>applyFilters(leads,filters,getCrmStatus),[leads,filters,getCrmStatus]);
  // callListLeads = eligible HOT leads sorted by ready_score, deduplicated by domain/CH number/name
  const callListLeads  = useMemo(()=>dedupeForReady(sortByReadyScore(leads.filter(isCallListEligible))),[leads]);
  // remainingHot = HOT leads that passed scoring but didn't make the call list eligibility check,
  // or are beyond the top 25 — shown collapsed in DailyCallListView
  const remainingHot   = useMemo(()=>{
    const callListIds = new Set(callListLeads.map(l => l.id));
    return sortByReadyScore(
      leads.filter(l => l.priority === "HOT" && !callListIds.has(l.id))
    );
  },[leads, callListLeads]);
  const researchLeads  = useMemo(()=>{
    const hotIds = new Set(leads.filter(l => l.priority === "HOT").map(l => l.id));
    return leads.filter(l => !hotIds.has(l.id));
  },[leads]);

  const hot       = leads.filter(l=>l.priority==="HOT").length;
  const warm      = leads.filter(l=>l.priority==="WARM").length;
  const contacted = useMemo(()=>leads.filter(l=>["contacted","follow_up","meeting_booked","passed_to_closer"].includes(getCrmStatus(l))).length,[leads,getCrmStatus]);
  const saved     = useMemo(()=>leads.filter(l=>getCrmStatus(l)==="saved").length,[leads,getCrmStatus]);
  const meetings  = useMemo(()=>leads.filter(l=>getCrmStatus(l)==="meeting_booked").length,[leads,getCrmStatus]);
  const hasSite   = leads.filter(l=>l.website).length;

  // Follow-up and contact lists
  const followupsDueToday = useMemo(()=>{
    const now = new Date();
    return leads.filter(l=>{ const crm = crmState[l.id]||{}; if(!crm.next_follow_up_at) return false; const d=new Date(crm.next_follow_up_at); return d.toDateString()===now.toDateString(); }).length;
  },[leads,crmState]);
  const followupsOverdue = useMemo(()=>{
    const now = new Date();
    return leads.filter(l=>{ const crm = crmState[l.id]||{}; if(!crm.next_follow_up_at) return false; const d=new Date(crm.next_follow_up_at); return d < now; }).length;
  },[leads,crmState]);
  const noNextAction = useMemo(()=>leads.filter(l=>{ const crm = crmState[l.id]||{}; return !crm.next_follow_up_at && (crm.status && crm.status!=='not_relevant' && crm.status!=='meeting_booked'); }).length,[leads,crmState]);
  const recentlyContacted = useMemo(()=>{
    const cutoff = Date.now() - (7*24*60*60*1000);
    return leads.filter(l=>{ const crm = crmState[l.id]||{}; return crm.last_contacted_at && new Date(crm.last_contacted_at).getTime() >= cutoff; }).length;
  },[leads,crmState]);

  const newLeadsCount = useMemo(()=>{
    const cutoff = Date.now() - 24*60*60*1000;
    return leads.filter(l => l.created_at && new Date(l.created_at).getTime() > cutoff).length;
  },[leads]);

  const viewDesc = filters.view === "new"
    ? `Added in the last 24 hours · sorted by readiness`
    : filters.view === "call_list"
    ? `Top 10 + Backup 15 + ${remainingHot.length} remaining HOT · ranked by ready_score`
    : filters.view === "research"
    ? `WARM + QUEUE · ${researchLeads.filter(l=>l.priority==="WARM").length} WARM, ${researchLeads.filter(l=>l.priority==="QUEUE").length} QUEUE`
    : "All leads across all events";

  const viewCountCls = filters.view === "call_list" ? "view-count view-count-cl"
    : filters.view === "research" ? "view-count view-count-rq"
    : filters.view === "new" ? "view-count view-count-cl"
    : "view-count view-count-all";

  return (
    <>
      <style>{CSS}</style>

      {/* TOPBAR */}
      <div className="tb">
        <div className="tb-l">
          <div className="tb-logo"><div className="tb-mark">FX</div>Discovery Engine</div>
          <div className="tb-sep"/>
          <div className="tb-tag">Sales Intelligence</div>
        </div>
        <div className="tb-r">
          <a className="btn-sm" href="/accounts" style={{textDecoration:"none"}}>Accounts</a>
          <div className="live"><div className="live-dot"/>LIVE</div>
          {lastRef && <span className="tb-time">{ago(lastRef)}</span>}
          <button className="btn-sm" onClick={()=>load()} disabled={loading}>{loading?"…":"↻ Refresh"}</button>
        </div>
      </div>

      {(locked || lockErr) && (
        <form className="unlock-bar" onSubmit={(e)=>{e.preventDefault(); load(password);}}>
          <span>{locked ? "Leads are behind the Accounts password." : lockErr}</span>
          {locked && <>
            <input className="unlock-in" type="password" placeholder="Accounts password" aria-label="Accounts password"
                   autoComplete="current-password" value={password} onChange={(e)=>setPassword(e.target.value)} />
            <button className="btn-sm" type="submit" disabled={!password || loading}>{loading ? "…" : "Unlock"}</button>
            {lockErr && <span className="unlock-err">{lockErr}</span>}
          </>}
        </form>
      )}

      {/* HERO */}
      <div className="hero">
        <div className="hero-eyebrow"><span>●</span> Live market intelligence · {dateShort}</div>
        <h1 className="hero-h1">What happened today —<br/><em>and who you should call</em></h1>
        <p className="hero-sub">
          Every market event mapped to the specific UK businesses writing cheques in foreign currency.
          {callListLeads.length > 0 && ` ${callListLeads.length} priority leads ready today.`}
        </p>
      </div>

      {/* STATS */}
      <div className="stats">
        {[
          {n:newLeadsCount,        l:"New leads",         s:"Added last 24h · click to view", c:"#FBB724", onClick:()=>setFilters(NEW_FILTERS)},
          {n:Math.min(callListLeads.length,25), l:"READY leads",   s:"Top 25 · ranked by ready_score", c:"#10B981"},
          {n:hot,                  l:"HOT leads",         s:"Score ≥ 80 · FX confirmed", c:"#10B981"},
          {n:warm,                 l:"WARM leads",        s:"Score 60–79",               c:"#F59E0B"},
          {n:leads.length,         l:"Companies found",   s:"All events · all priority", c:"#6366F1"},
          {n:hasSite,              l:"Website verified",  s:`${Math.round(hasSite/Math.max(leads.length,1)*100)}% of pipeline`, c:"#38BDF8"},
          {n:contacted,            l:"In progress",       s:"Contacted/follow-up",       c:"#38BDF8"},
          {n:meetings,             l:"Meetings booked",   s:"CRM tracked",               c:"#10B981"},
          {n:saved,                l:"Saved",             s:"Worth revisiting",          c:"#F59E0B"},
        ].map(({n,l,s,c,onClick})=>(
          <div className="stat" key={l} onClick={onClick} style={onClick?{cursor:"pointer"}:{}}>
            <div className="stat-n" style={{color:c}}>{n}</div>
            <div><span className="stat-l">{l}</span><span className="stat-s">{s}</span></div>
          </div>
        ))}
      </div>

      {/* VIEW SWITCHER */}
      <div className="view-banner">
        <div className="view-tabs">
          {newLeadsCount > 0 && (
            <button
              className={`view-tab${filters.view==="new"?" active-new":""}`}
              onClick={()=>setFilters(NEW_FILTERS)}
              style={{fontWeight:700}}
            >
              ✦ New Leads ({newLeadsCount})
            </button>
          )}
          <button
            className={`view-tab${filters.view==="call_list"?" active-cl":""}`}
            onClick={()=>setFilters(CALL_LIST_FILTERS)}
          >
            ⚡ Call List
          </button>
          <button
            className={`view-tab${filters.view==="research"?" active-rq":""}`}
            onClick={()=>setFilters(RESEARCH_FILTERS)}
          >
            🔍 Research
          </button>
          <button
            className={`view-tab${filters.view==="all"?" active-all":""}`}
            onClick={()=>setFilters(ALL_FILTERS)}
          >
            ⊙ All
          </button>
          <button
            className={`view-tab${filters.view==="lookup"?" active-lk":""}`}
            onClick={()=>setFilters({...BLANK_FILTERS,view:"lookup"})}
          >
            ⌕ Lookup
          </button>
        </div>
        <span className="view-desc">{viewDesc}</span>
        <span className={viewCountCls}>{filteredLeads.length} leads</span>
        <div style={{display:"flex",gap:6,marginLeft:"auto"}}>
          <button
            className="btn-sm"
            style={{background:"rgba(16,185,129,.08)",borderColor:"rgba(16,185,129,.2)",color:"#10B981",display:"flex",alignItems:"center",gap:5}}
            onClick={()=>{
              const exportLeads = filters.view==="call_list" ? callListLeads.slice(0,25) : filteredLeads;
              const label = filters.view==="call_list"?"daily-call-list":filters.view==="research"?"research-queue":"all-leads";
              downloadCSV(exportLeads, `fx-${label}-${new Date().toISOString().slice(0,10)}.csv`, crmState);
            }}
            title="Download as CSV — open in Google Sheets or Excel"
          >
            ⬇ Export CSV
          </button>
        </div>
      </div>

      {filters.view === "lookup" ? <CompanyLookupView /> : (<>

      {/* FILTER BAR */}
      <FilterBar
        filters={filters}
        setFilters={setFilters}
        leads={leads}
        events={events}
        filteredCount={filteredLeads.length}
        crmState={crmState}
      />

      {/* MAIN LAYOUT */}
      <div className="layout">
        <div>
          {filters.view === "call_list" ? (
            <DailyCallListView
              callListLeads={callListLeads}
              remainingHot={remainingHot}
              allLeads={leads}
              events={events}
              crmState={crmState}
              getCrmStatus={getCrmStatus}
              updateLead={updateLead}
              performAction={performAction}
              getLead={getLead}
              today={today}
              minRevenue={filters.minRevenue}
            />
          ) : (
            <>
              <div className="feed-hdr">
                <div className="feed-title">
                  {filters.view === "research" ? "Research Queue" : "All leads · market events"}
                </div>
                <div className="feed-date">{today}</div>
              </div>

              {filters.view === "research" && (
                <FollowupsDueSection
                  allLeads={leads}
                  events={events}
                  crmState={crmState}
                  getCrmStatus={getCrmStatus}
                  updateLead={updateLead}
                  performAction={performAction}
                  getLead={getLead}
                />
              )}

              {events.length === 0 ? (
                <div className="empty">
                  <div className="empty-i">📡</div>
                  <div className="empty-t">No events yet</div>
                  <div className="empty-s">Run <code>npm run pipeline</code> to pull today's market events<br/>then discover affected companies</div>
                </div>
              ) : (
                <div className="feed">
                  {events.map((ev,i)=>(
                    <EventItem
                      key={ev.id}
                      event={ev}
                      leads={filteredLeads}
                      allLeads={leads}
                      index={i}
                      getCrmStatus={getCrmStatus}
                      onCrmSet={updateLead}
                      getLead={getLead}
                      performAction={performAction}
                    />
                  ))}
                </div>
              )}

              {/* Unverified revenue — shown below main results when a threshold is active */}
              {filters.minRevenue > 0 && (() => {
                const unver = leads.filter(l => {
                  if (filters.view === "call_list") return false; // handled by DailyCallListView
                  // Apply same view+segment+event filters but NOT the revenue filter
                  if (filters.priorities.length && !filters.priorities.includes(l.priority)) return false;
                  if (filters.eventId !== "all" && l.event_id !== filters.eventId) return false;
                  if (filters.segment !== "all" && (l.segment_name||"") !== filters.segment) return false;
                  if (filters.grades.length && !filters.grades.includes(l.route_grade)) return false;
                  return sizeFit(l, filters.minRevenue) === "unverified";
                });
                return (
                  <UnverifiedRevenueSection
                    leads={unver}
                    minRevenue={filters.minRevenue}
                    events={events}
                    getCrmStatus={getCrmStatus}
                    updateLead={updateLead}
                    performAction={performAction}
                    getLead={getLead}
                  />
                );
              })()}
            </>
          )}
        </div>

        {/* SIDEBAR */}
        <div className="sidebar">
          <div className="sb">
            <div className="sb-h">Pipeline summary</div>
            {[
              {l:"READY (top 25)",    v:Math.min(callListLeads.length,25), c:"#10B981"},
              {l:"HOT (all)",        v:leads.filter(l=>l.priority==="HOT").length, c:"#10B981"},
              {l:"Research queue",   v:researchLeads.length, c:"#F59E0B"},
              {l:"With website",     v:hasSite,              c:"#38BDF8"},
              {l:"Contacted",        v:contacted,            c:"#38BDF8"},
              {l:"Saved",            v:saved,                c:"#10B981"},
              {l:"Total pipeline",   v:leads.length,         c:"#6366F1"},
            ].map(({l,v,c})=>(
              <div className="sb-row" key={l}>
                <span className="sb-l">{l}</span>
                <span className="sb-v" style={{color:c}}>{v}</span>
              </div>
            ))}
          </div>

          {events.length > 0 && (
            <div className="sb">
              <div className="sb-h">Event index</div>
              {events.map(ev=>(
                <div key={ev.id} className="sb-ev" onClick={()=>document.getElementById(ev.id)?.scrollIntoView({behavior:"smooth"})}>
                  <div className="sb-et" style={{color:urg(ev.urgency_score||0)}}>{ev.event_type} · {ev.urgency_score}/10</div>
                  <div className="sb-eh">{ev.headline.slice(0,55)}{ev.headline.length>55?"…":""}</div>
                  <div className="sb-em">{(ev.currency_pairs||[]).join(" · ")} · {ago(ev.detected_at)}</div>
                </div>
              ))}
            </div>
          )}

          <div className="sb">
            <div className="sb-h">Follow-ups</div>
            <div className="sb-row"><span className="sb-l">Due today</span><span className="sb-v" style={{color:"#10B981"}}>{followupsDueToday}</span></div>
            <div className="sb-row"><span className="sb-l">Overdue</span><span className="sb-v" style={{color:"#F97316"}}>{followupsOverdue}</span></div>
            <div className="sb-row"><span className="sb-l">No next action</span><span className="sb-v" style={{color:"#64748B"}}>{noNextAction}</span></div>
            <div className="sb-row"><span className="sb-l">Recently contacted</span><span className="sb-v" style={{color:"#38BDF8"}}>{recentlyContacted}</span></div>
          </div>

          <div className="sb">
            <div className="sb-h">Exports</div>
            <div className="sb-row">
              <span className="sb-l">Today's Queue</span>
              <button className="btn-sm" onClick={()=>exportLeadsToCsv(callListLeads, "todays_queue.csv")}>CSV</button>
            </div>
            <div className="sb-row">
              <span className="sb-l">Grade A/B leads</span>
              <button className="btn-sm" onClick={()=>exportLeadsToCsv(leads.filter(l=>["A","B"].includes(l.route_grade||computeRouteGrade(l))), "grade_a_b.csv")}>CSV</button>
            </div>
            <div className="sb-row">
              <span className="sb-l">Follow-ups due</span>
              <button className="btn-sm" onClick={()=>{
                const now = new Date();
                const due = leads.filter(l=>{ const crm=crmState[l.id]||{}; if(!crm.next_follow_up_at) return false; return new Date(crm.next_follow_up_at)<=now; });
                exportLeadsToCsv(due, "followups_due.csv");
              }}>CSV</button>
            </div>
          </div>
        </div>
      </div>
      </>)}
    </>
  );
}
