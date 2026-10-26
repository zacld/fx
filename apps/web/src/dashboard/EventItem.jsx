// One market event and the leads it found.
// (Split out of App.jsx; no behaviour change.)
import { useState } from "react";
import { CompanyCard } from "./CompanyCard.jsx";
import { ago, expClass, today, urg } from "./format.js";

// ─── EVENT ITEM ──────────────────────────────────────────────────
export function EventItem({ event, leads, allLeads, index, getCrmStatus, onCrmSet, getLead, performAction }) {
  const [open, setOpen]          = useState(false);
  const [showCompanies, setShow] = useState(false);
  const color = urg(event.urgency_score||0);

  const eventLeads    = leads.filter(l=>l.event_id===event.id);
  const allEventLeads = allLeads.filter(l=>l.event_id===event.id);
  const isFiltered    = eventLeads.length !== allEventLeads.length;

  const niches = event.target_segments?.length > 0
    ? event.target_segments
    : (event.affected_niches || event.who_pays_fx || event.affected_sectors || []);

  return (
    <div className="ev" id={event.id}>
      <div className="ev-row" onClick={()=>{ setOpen(o=>!o); if(open) setShow(false); }}>
        <div className="ev-num">{String(index+1).padStart(2,"0")}</div>
        <div className="ev-body">
          <div className="ev-tags">
            <span className="ev-type" style={{color, background:`${color}12`, borderColor:`${color}35`}}>{event.event_type||"Event"}</span>
            <div className="ev-urg" style={{color}}>
              <div className="ev-track"><div className="ev-fill" style={{width:`${(event.urgency_score||0)*10}%`,background:color}}/></div>
              {event.urgency_score}/10
            </div>
            {event.detected_at && <span className="ev-when">{ago(event.detected_at)}</span>}
          </div>
          <div className="ev-headline">{event.headline}</div>
          <div className="ev-summary">{event.summary?.slice(0,140)}{(event.summary?.length||0)>140?"…":""}</div>
          <div className="ev-meta">
            <div className="ev-pairs">{(event.currency_pairs||[]).map(p=><span key={p} className="ev-pair">{p}</span>)}</div>
            {allEventLeads.length>0 && (
              <span className="ev-lcount">
                {isFiltered ? `${eventLeads.length} of ${allEventLeads.length}` : allEventLeads.length} companies
              </span>
            )}
          </div>
        </div>
        <div className="ev-right">
          <span className="ev-hint">{open?"▲":"▼ more"}</span>
          {!open && eventLeads.length>0 && (
            <button className="ev-open-btn" onClick={e=>{e.stopPropagation();setOpen(true);setTimeout(()=>setShow(true),50)}}>
              View {eventLeads.length} →
            </button>
          )}
        </div>
      </div>

      {open && (
        <div className="ev-expanded">
          {/* Business impact — hero field for the event */}
          {event.business_impact_summary && (
            <div className="ev-fx-box" style={{marginBottom:14,borderLeftColor:"rgba(99,102,241,.5)"}}>
              <div className="ev-fx-label" style={{color:"#818CF8"}}>Business impact today</div>
              <div className="ev-fx-text">{event.business_impact_summary}</div>
            </div>
          )}

          <div className="ev-detail-row">
            {event.what_happened && (
              <div>
                <div className="ev-dl">What happened</div>
                <div className="ev-dv">{event.what_happened}</div>
              </div>
            )}
            {event.what_changed_financially && (
              <div>
                <div className="ev-dl">What changed financially</div>
                <div className="ev-dv">{event.what_changed_financially}</div>
              </div>
            )}
            {event.who_pays_more && (
              <div>
                <div className="ev-dl">Who pays more</div>
                <div className="ev-dv" style={{color:"rgba(252,165,165,.7)"}}>{event.who_pays_more}</div>
              </div>
            )}
            {event.who_receives_less && event.who_receives_less !== "none" && (
              <div>
                <div className="ev-dl">Who receives less</div>
                <div className="ev-dv" style={{color:"rgba(252,165,165,.6)"}}>{event.who_receives_less}</div>
              </div>
            )}
            {(event.margin_risk || event.payment_timing_risk) && (
              <div>
                <div className="ev-dl">Risk level</div>
                <div className="ev-dv" style={{fontSize:11}}>
                  {event.margin_risk && <span>Margin: <b style={{color:event.margin_risk==="High"?"#F87171":event.margin_risk==="Medium"?"#F59E0B":"#10B981"}}>{event.margin_risk}</b>{" "}</span>}
                  {event.payment_timing_risk && <span>Timing: <b style={{color:event.payment_timing_risk==="High"?"#F87171":event.payment_timing_risk==="Medium"?"#F59E0B":"#10B981"}}>{event.payment_timing_risk}</b></span>}
                </div>
              </div>
            )}
            {event.sales_angle && (
              <div style={{gridColumn:"1/-1"}}>
                <div className="ev-dl">Sales angle today</div>
                <div className="ev-dv" style={{fontStyle:"italic",color:"rgba(255,255,255,.45)"}}>"{event.sales_angle}"</div>
              </div>
            )}
          </div>

          {event.fx_payment_logic && (
            <div className="ev-fx-box">
              <div className="ev-fx-label">Why businesses pay FX because of this</div>
              <div className="ev-fx-text">{event.fx_payment_logic}</div>
            </div>
          )}

          {!showCompanies && (
            <>
              <div className="niche-header">
                <div className="niche-funnel-stats">
                  <span className="nf-stat"><strong>{niches.length}</strong> segments mapped</span>
                  <span className="nf-sep">·</span>
                  <span className="nf-stat"><strong>{event.total_micro_categories || 0}</strong> micro-cats</span>
                  <span className="nf-sep">·</span>
                  <span className="nf-stat"><strong>{allEventLeads.length}</strong> companies found</span>
                  <span className="nf-sep">·</span>
                  <span className="nf-stat"><strong>{allEventLeads.filter(l=>l.priority==="HOT"||l.priority==="WARM").length}</strong> call targets</span>
                </div>
                <div className="niche-hint">Click any segment to see discovered companies</div>
              </div>
              <div className="niches">
                {niches.map((n,i)=>{
                  const nStr = typeof n==="object"?(n.segment_name||""):(n||"");
                  const nExp = typeof n==="object"?n.exposure_level:null;
                  return (
                    <div key={i} className="niche-row" onClick={e=>{e.stopPropagation();setShow(true)}}>
                      <div className="niche-left">
                        <span className="niche-idx">{String(i+1).padStart(2,"0")}</span>
                        <span className="niche-name">{nStr}</span>
                      </div>
                      <div className="niche-right">
                        {nExp && <span className={`exp-level ${expClass(nExp)}`} style={{fontSize:9,padding:"1px 6px"}}>{nExp}</span>}
                        <span className="niche-arr">→</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              {eventLeads.length > 0 && (
                <button className="show-companies-btn" onClick={e=>{e.stopPropagation();setShow(true)}}>
                  View {eventLeads.length}{isFiltered?" filtered":""} companies →
                </button>
              )}
              {allEventLeads.length === 0 && (
                <div style={{padding:"14px 0",textAlign:"center",fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:"rgba(255,255,255,.2)"}}>
                  No companies found yet · run <code style={{color:"rgba(16,185,129,.5)"}}>discover.py</code>
                </div>
              )}
              {allEventLeads.length > 0 && eventLeads.length === 0 && (
                <div style={{padding:"14px 0",textAlign:"center",fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:"rgba(255,255,255,.2)"}}>
                  {allEventLeads.length} companies hidden by current view/filters
                </div>
              )}
            </>
          )}

          {showCompanies && (
            <div className="co-drawer" onClick={e=>e.stopPropagation()}>
              <div className="co-drawer-hdr">
                <div className="co-drawer-title">{eventLeads.length} companies · sorted by score</div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  {isFiltered && <span className="co-filtered-note">{allEventLeads.length-eventLeads.length} hidden by filters</span>}
                  <button className="co-back" onClick={e=>{e.stopPropagation();setShow(false)}}>← Back to niches</button>
                </div>
              </div>
              {eventLeads.length > 0
                ? <div className="co-list">{eventLeads.map(l=>
                    <CompanyCard
                      key={l.id}
                      lead={l}
                      crmStatus={getCrmStatus(l)}
                      onCrmSet={onCrmSet}
                      performAction={performAction}
                      crmEntry={getLead(l)}
                      event={event}
                    />
                  )}</div>
                : <div style={{padding:"18px 0",textAlign:"center",fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:"rgba(255,255,255,.2)"}}>All companies hidden by active filters</div>
              }
            </div>
          )}
        </div>
      )}
    </div>
  );
}
