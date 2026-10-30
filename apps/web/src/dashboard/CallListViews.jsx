// Follow-ups due, the Daily Call List and the unverified-revenue section.
// (Split out of App.jsx; no behaviour change.)
import { useState, useMemo } from "react";
import { CompanyCard } from "./CompanyCard.jsx";
import { sizeFit } from "./filters.js";
import { today } from "./format.js";

// ─── FOLLOW-UPS DUE SECTION ──────────────────────────────────────
export function FollowupsDueSection({ allLeads, events, crmState, getCrmStatus, updateLead, performAction, getLead }) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(null);

  const now = new Date();
  const dueTodayLeads = useMemo(() => {
    return allLeads.filter(l => {
      const crm = crmState[l.id] || {};
      if (!crm.next_follow_up_at) return false;
      const d = new Date(crm.next_follow_up_at);
      return d <= now && getCrmStatus(l) !== "not_relevant" && getCrmStatus(l) !== "meeting_booked";
    });
  }, [allLeads, crmState, getCrmStatus]);

  if (!dueTodayLeads.length) return null;

  const CHAN_ICON = { phone:"📞", email:"✉️", linkedin:"💼", reply:"↩️", meeting:"📅" };

  return (
    <div className="fu-banner">
      <div className="fu-banner-hdr" onClick={()=>setOpen(o=>!o)}>
        <span style={{fontSize:14}}>🔔</span>
        <span className="fu-banner-title">Follow-ups Due</span>
        <span className="fu-banner-count">{dueTodayLeads.length}</span>
        <span className="fu-banner-hint">
          {dueTodayLeads.filter(l=>new Date((crmState[l.id]||{}).next_follow_up_at)<now).length > 0
            ? `${dueTodayLeads.filter(l=>new Date((crmState[l.id]||{}).next_follow_up_at)<now).length} overdue`
            : "due today"}
        </span>
        <span className="fu-banner-tog">{open?"▲ hide":"▼ show"}</span>
      </div>
      {open && (
        <div className="fu-leads">
          {dueTodayLeads.map(l => {
            const crm = crmState[l.id] || {};
            const d = new Date(crm.next_follow_up_at);
            const overdue = d < now;
            const ev = events.find(e => e.id === l.event_id);
            const isExpanded = expanded === l.id;
            return (
              <div key={l.id}>
                <div className="fu-row" onClick={()=>setExpanded(isExpanded ? null : l.id)}>
                  <span style={{fontSize:11}}>{CHAN_ICON[crm.last_channel]||"📋"}</span>
                  <span className="fu-name">{l.company_name}</span>
                  {crm.last_channel && <span className="fu-channel">{crm.last_channel}</span>}
                  {crm.touch_count > 0 && <span className="fu-meta">{crm.touch_count} touch{crm.touch_count!==1?"es":""}</span>}
                  <span className={`fu-meta ${overdue?"fu-overdue":""}`}>
                    {overdue
                      ? `overdue · ${d.toLocaleDateString("en-GB",{day:"numeric",month:"short"})}`
                      : `due ${d.toLocaleDateString("en-GB",{day:"numeric",month:"short"})}`}
                  </span>
                  <span style={{fontSize:10,color:"rgba(255,255,255,.2)"}}>{isExpanded?"▲":"▼"}</span>
                </div>
                {isExpanded && (
                  <div style={{marginBottom:8}}>
                    <CompanyCard
                      lead={l}
                      crmStatus={getCrmStatus(l)}
                      onCrmSet={updateLead}
                      performAction={performAction}
                      crmEntry={getLead(l)}
                      event={ev}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── DAILY CALL LIST VIEW ─────────────────────────────────────────
// ─── UNVERIFIED REVENUE SECTION ─────────────────────────────────
export function UnverifiedRevenueSection({ leads, minRevenue, events, getCrmStatus, updateLead, performAction, getLead }) {
  const [open, setOpen] = useState(false);
  if (!minRevenue || leads.length === 0) return null;
  const fmtThresh = minRevenue >= 1_000_000 ? `£${minRevenue/1_000_000}m` : `£${minRevenue/1_000}k`;
  return (
    <div className="cl-section" style={{marginTop:16}}>
      <div className="cl-section-hdr" onClick={()=>setOpen(o=>!o)}>
        <span className="cl-section-title" style={{color:"#F59E0B"}}>⚠ Unverified revenue</span>
        <span className="cl-section-count" style={{background:"rgba(245,158,11,.1)",color:"#F59E0B",border:"1px solid rgba(245,158,11,.25)"}}>
          {leads.length}
        </span>
        <span className="cl-section-desc">
          Turnover not in public CH accounts — may qualify for {fmtThresh} but cannot be confirmed · review manually
        </span>
        <span className="cl-toggle">{open?"▲":"▼ show"}</span>
      </div>
      {open && (
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {leads.map(l => {
            const ev = events.find(e=>e.id===l.event_id);
            return (
              <CompanyCard
                key={l.id}
                lead={l}
                crmStatus={getCrmStatus(l)}
                onCrmSet={updateLead}
                performAction={performAction}
                crmEntry={getLead(l)}
                event={ev}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

export function DailyCallListView({ callListLeads, remainingHot, allLeads, events, crmState, getCrmStatus, updateLead, performAction, getLead, today, minRevenue }) {
  const [showTop10, setShowTop10]       = useState(true);
  const [showBackup, setShowBackup]     = useState(true);
  const [showRemaining, setShowRemaining] = useState(false);

  // Apply revenue filter to call list bands — confirmed passes only, unverified collected separately
  const revPasses   = minRevenue > 0 ? callListLeads.filter(l => sizeFit(l, minRevenue) === "passes") : callListLeads;
  const revUnverCL  = minRevenue > 0 ? callListLeads.filter(l => sizeFit(l, minRevenue) === "unverified") : [];
  // eligible leads ranked below the top 25 join the remaining HOT list (they were shown nowhere before)
  const remPasses   = [...revPasses.slice(25),
                       ...(minRevenue > 0 ? (remainingHot||[]).filter(l => sizeFit(l, minRevenue) === "passes") : (remainingHot||[]))];
  const remUnver    = minRevenue > 0 ? (remainingHot||[]).filter(l => sizeFit(l, minRevenue) === "unverified") : [];
  const allUnver    = [...revUnverCL, ...remUnver];

  const top10   = revPasses.slice(0, 10);
  const backup15= revPasses.slice(10, 25);

  function renderBand(leads, title, color, accentBg, open, toggle, emptyMsg, desc) {
    const bandDesc = desc ?? (title.includes("Top") ? "Highest-confidence · call today" : title.includes("Backup") ? "Call if top 10 is clear" : "Evidence-backed · not yet ranked for today");
    return (
      <div className="cl-section">
        <div className="cl-section-hdr" onClick={toggle}>
          <span className="cl-section-title" style={{color}}>{title}</span>
          <span className="cl-section-count" style={{background:accentBg,color,border:`1px solid ${color}40`}}>
            {leads.length}
          </span>
          <span className="cl-section-desc">{bandDesc}</span>
          <span className="cl-toggle">{open?"▲":"▼ show"}</span>
        </div>
        {open && (
          leads.length > 0 ? (
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {leads.map(l => {
                const ev = events.find(e => e.id === l.event_id);
                return (
                  <CompanyCard
                    key={l.id}
                    lead={l}
                    crmStatus={getCrmStatus(l)}
                    onCrmSet={updateLead}
                    performAction={performAction}
                    crmEntry={getLead(l)}
                    event={ev}
                  />
                );
              })}
            </div>
          ) : (
            <div style={{padding:"20px 0",textAlign:"center",fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:"rgba(255,255,255,.2)"}}>
              {emptyMsg}
            </div>
          )
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="feed-hdr">
        <div className="feed-title">Daily Call List</div>
        <div className="feed-date">{today}</div>
      </div>

      <FollowupsDueSection
        allLeads={allLeads}
        events={events}
        crmState={crmState}
        getCrmStatus={getCrmStatus}
        updateLead={updateLead}
        performAction={performAction}
        getLead={getLead}
      />

      {minRevenue > 0 && (
        <div style={{padding:"6px 0 10px",fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"#10B981",opacity:.6}}>
          Confirmed £{(minRevenue/1_000_000).toFixed(0)}m+ companies · {revPasses.length} match · {revUnverCL.length + remUnver.length} unverified · below-threshold hidden
        </div>
      )}
      {renderBand(top10, "⚡ Today's Top 10", "#10B981", "rgba(16,185,129,.1)", showTop10, ()=>setShowTop10(o=>!o), "No eligible leads in top 10 — check scoring gates")}
      {backup15.length > 0 && renderBand(backup15, "📋 Backup 15", "#F59E0B", "rgba(245,158,11,.1)", showBackup, ()=>setShowBackup(o=>!o), "No backup leads")}
      {remPasses.length > 0 && renderBand(remPasses, "🔵 Remaining HOT", "#6366F1", "rgba(99,102,241,.1)", showRemaining, ()=>setShowRemaining(o=>!o), "No remaining HOT leads", "Evidence-backed but below top 25 · review when ready")}

      <UnverifiedRevenueSection
        leads={allUnver}
        minRevenue={minRevenue}
        events={events}
        getCrmStatus={getCrmStatus}
        updateLead={updateLead}
        performAction={performAction}
        getLead={getLead}
      />

      {callListLeads.length === 0 && (
        <div className="empty">
          <div className="empty-i">📡</div>
          <div className="empty-t">No call targets yet</div>
          <div className="empty-s">Run <code>npm run pipeline</code> to discover leads<br/>Leads need HOT/WARM priority · verified website · FX signals · contact route</div>
        </div>
      )}
    </div>
  );
}
