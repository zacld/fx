// One lead's card.
// (Split out of App.jsx; no behaviour change.)
import { useState } from "react";
import { computeRouteGrade } from "./crm.js";
import { ago, copy, expClass, expLabel, fxLikColor, fxLikLabel, gradeBg, gradeColor, gradeTip, pri } from "./format.js";
import { CallIntelligencePanel, CallOpenerPanel, DecisionMakers, EmailPatterns, MessageAmmoPanel, ReadinessBadge } from "./panels.jsx";
import { CompanyFinancials, CrmBadge, FxIntelCard, PhoneBadge, expConfClass, expConfLabel, siteConfClass, siteConfLabel, sizeBandColor } from "./parts.jsx";

// ─── COMPANY CARD ────────────────────────────────────────────────
export function CompanyCard({ lead, crmStatus, onCrmSet, performAction, crmEntry, event }) {
  const [open, setOpen] = useState(false);
  const color       = pri(lead.priority);
  const initials    = (lead.director_name||"").split(" ").slice(0,2).map(w=>w[0]||"").join("").toUpperCase()||"?";
  // Legacy v1 LinkedIn-assist blob. The v2 source of truth is
  // lead.decision_makers[].linkedin_search / linkedin_name_only / google_email_search,
  // produced by the new TS enrich-decision-makers stage. `li` is only read as a
  // fallback for old data that pre-dates that stage.
  const li          = lead.linkedin_assist;
  const fxSigs      = lead.fx_payment_signals || [];
  const segSigs     = lead.segment_signals || [];
  const confBadge   = siteConfLabel(lead.website_confidence, lead.website_source);
  const confCls     = siteConfClass(lead.website_confidence);
  const routeGrade  = computeRouteGrade(lead);
  const expConf     = lead.exposure_confidence;
  const thesis      = lead.exposure_thesis || lead.fx_reason || "";
  const isMultiEvt  = lead.multi_event_trigger;
  const allSigs     = [...new Set([...fxSigs, ...segSigs])];
  const isNew = lead.created_at && (Date.now() - new Date(lead.created_at).getTime() < 24*60*60*1000);

  return (
    <div className="cc" style={{"--pc":color}}>
      <div className="cc-top" onClick={()=>setOpen(o=>!o)}>
        <div>
          <div className="cc-name">
            {lead.company_name}
            {isMultiEvt && <span style={{marginLeft:6,fontSize:10,padding:"1px 6px",borderRadius:4,background:"rgba(16,185,129,.12)",border:"1px solid rgba(16,185,129,.25)",color:"#10B981",fontFamily:"'JetBrains Mono',monospace",letterSpacing:".04em"}}>🔥 {lead.multi_event_count} events</span>}
          </div>
          <div className="cc-meta">
            {[lead.company_type?.toUpperCase(), lead.company_number&&`CH ${lead.company_number}`, lead.incorporated&&`Est. ${lead.incorporated.slice(0,4)}`].filter(Boolean).join(" · ")}
          </div>
          <div className="cc-badges">
            {isNew && <span style={{padding:"2px 9px",borderRadius:5,background:"rgba(251,191,36,.2)",border:"1px solid rgba(251,191,36,.5)",color:"#FBB724",fontFamily:"'JetBrains Mono',monospace",fontSize:11,fontWeight:800,letterSpacing:".12em",textTransform:"uppercase",boxShadow:"0 0 8px rgba(251,191,36,.2)"}}>✦ NEW</span>}
            <ReadinessBadge lead={lead} />
            <span className="b b-p">● {lead.priority}</span>
            {lead.exposure_level && <span className={`exp-level ${expClass(lead.exposure_level)}`}>{expLabel(lead.exposure_level)}</span>}
            {allSigs.length > 0 && (
              <span className="b b-fx">{allSigs.length} FX signal{allSigs.length>1?"s":""}</span>
            )}
            {confBadge && <span className={confCls}>{confBadge}</span>}
            {lead.fx_exposure && <span className="b b-sec">{lead.fx_exposure}</span>}
            {expConf && expConf !== "none" && (
              <span className={expConfClass(expConf)} title={expConfLabel(expConf)}>{expConf} conf</span>
            )}
            {lead.route_grade && (
              <span
                className="grade-badge"
                style={{color:gradeColor(lead.route_grade),background:gradeBg(lead.route_grade),borderColor:`${gradeColor(lead.route_grade)}35`}}
                title={`Route grade ${lead.route_grade}: ${gradeTip(lead.route_grade)}`}
              >
                {lead.route_grade}
              </span>
            )}
            {lead.fx_likelihood_score >= 25 && (
              <span
                className="grade-badge"
                style={{color:fxLikColor(lead.fx_likelihood_score),background:`${fxLikColor(lead.fx_likelihood_score)}14`,borderColor:`${fxLikColor(lead.fx_likelihood_score)}30`}}
                title={fxLikLabel(lead.fx_likelihood_score)}
              >
                FX {lead.fx_likelihood_score}%
              </span>
            )}
            {(lead.inferred_currency_pairs||[]).slice(0,2).map(p=>(
              <span key={p} style={{fontFamily:"'JetBrains Mono',monospace",fontSize:9,padding:"1px 5px",borderRadius:3,background:"rgba(16,185,129,.08)",border:"1px solid rgba(16,185,129,.18)",color:"#10B981"}}>{p}</span>
            ))}
            {lead.company_size_band && lead.company_size_band !== "unknown" && (() => {
              const bc = sizeBandColor(lead.company_size_band);
              return (
                <span
                  className="size-badge"
                  style={{color:bc,background:`${bc}12`,borderColor:`${bc}30`}}
                  title={`Company size band: ${lead.company_size_band}`}
                >
                  {lead.company_size_band === "dormant" ? "dormant" : `~${lead.company_size_band}`}
                </span>
              );
            })()}
          </div>
          <div className="cc-info">
            {lead.address && <span>📍 {lead.address.split(",").slice(-2).join(",").trim()}</span>}
            {lead.company_status && <span style={{color:lead.company_status==="active"?"#10B981":"#F59E0B"}}>● {lead.company_status}</span>}
            {lead.segment_name && <span style={{color:"rgba(255,255,255,.3)"}}>{lead.segment_name.slice(0,40)}</span>}
            {lead.priority === "HOT" && lead.ready_score > 0 && (
              <span title={`Ready score: ${lead.ready_score}/100 — ranking within HOT pool`} style={{color:"#10B981",fontFamily:"'JetBrains Mono',monospace",fontSize:10,letterSpacing:".03em"}}>
                ★ {lead.ready_score}
              </span>
            )}
            {lead.contact_phone && <PhoneBadge phone={lead.contact_phone} sourceCount={lead.phone_source_count} />}
            {crmEntry?.touch_count > 0 && (
              <span className="crm-touch crm-touched" title={`Last: ${crmEntry.last_channel||"contact"} · ${ago(crmEntry.last_contacted_at)}`}>
                📬 {crmEntry.touch_count} touch{crmEntry.touch_count!==1?"es":""}
              </span>
            )}
            {crmEntry?.next_follow_up_at && (() => {
              const d = new Date(crmEntry.next_follow_up_at);
              const overdue = d <= new Date();
              const label = overdue
                ? `overdue · ${d.toLocaleDateString("en-GB",{day:"numeric",month:"short"})}`
                : `follow up ${d.toLocaleDateString("en-GB",{day:"numeric",month:"short"})}`;
              return (
                <span className={`crm-touch ${overdue?"crm-fu-due":"crm-fu-soon"}`} title={overdue?"Follow-up overdue":"Scheduled follow-up"}>
                  🔔 {label}
                </span>
              );
            })()}
            {crmEntry?.last_contacted_at && !crmEntry?.next_follow_up_at && (
              <span className="crm-touch" style={{color:"rgba(255,255,255,.2)"}} title={crmEntry.last_channel||"contacted"}>
                Last contact {ago(crmEntry.last_contacted_at)}
              </span>
            )}
          </div>
          {lead.director_name && (
            <div className="cc-dir" style={{marginBottom:7}}>
              <span style={{fontSize:11,color:"rgba(255,255,255,.2)"}}>👤</span>
              <b>{lead.director_name}</b>
              <span style={{color:"rgba(255,255,255,.25)"}}>· {lead.director_role}</span>
              {lead.contact_confidence != null && (
                <span style={{marginLeft:6,fontFamily:"'JetBrains Mono',monospace",fontSize:9,color:"rgba(255,255,255,.2)"}}>
                  {lead.contact_confidence}% conf
                </span>
              )}
            </div>
          )}
          {thesis && (
            <div className="cc-angle">
              {thesis.slice(0,160)}
              {thesis.length > 160 ? "…" : ""}
            </div>
          )}
        </div>
        <div className="cc-score">
          <div className="cc-sn">{lead.score}</div>
          <div className="cc-sl">Score</div>
          <div className="cc-chev">{open?"▲":"▼"}</div>
          <CrmBadge leadId={lead.id} status={crmStatus} onSet={onCrmSet}/>
        </div>
      </div>

      {open && (
        <div className="cc-exp">

          {/* CALL INTELLIGENCE — website evidence, countries, currency pair, FX score */}
          <CallIntelligencePanel lead={lead} />

          {/* CALL OPENER — rule-based, three formats */}
          <CallOpenerPanel lead={lead} event={event} />

          {/* COMPANY FINANCIALS — CH accounts size, employees, turnover */}
          <CompanyFinancials lead={lead} />

          {/* FX INTELLIGENCE — priority grade, disclosed exposure, call angle */}
          <FxIntelCard lead={lead} />

          {/* EXPOSURE THESIS — AI-generated context (shown when no direct evidence) */}
          {thesis && !(lead.fx_evidence_snippets?.length) && (
            <div className="thesis-box" style={{marginBottom:14}}>
              <div className="thesis-label">Exposure thesis</div>
              <div className="thesis-text">{thesis}</div>
            </div>
          )}

          <div className="cc-exp-grid">
            {/* Phone — contact route */}
            {lead.contact_phone && (
              <div>
                <div className="xl">Phone</div>
                <div className="phone-row">
                  <PhoneBadge phone={lead.contact_phone} sourceCount={lead.phone_source_count} large />
                  {(lead.phone_source_count||0) < 2 && lead.phone_sources?.length > 0 && (
                    <span className="phone-src">{lead.phone_sources[0]}</span>
                  )}
                </div>
                {lead.all_phones_found?.length > 1 && (
                  <div style={{fontSize:10,color:"rgba(255,255,255,.2)",fontFamily:"'JetBrains Mono',monospace",marginTop:3}}>
                    Also found: {lead.all_phones_found.slice(1,3).join("  ·  ")}
                  </div>
                )}
              </div>
            )}

            {/* Decision makers — full panel (replaces single director) */}
            <DecisionMakers lead={lead} />

            {/* Why pays FX */}
            <div>
              <div className="xl">Why they pay FX</div>
              <div className="xv">{lead.fx_payment_logic || lead.fx_reason || "—"}</div>
            </div>

            {/* Business model */}
            {lead.segment_business_model && (
              <div>
                <div className="xl">Business model</div>
                <div className="xv">{lead.segment_business_model}</div>
              </div>
            )}

            {/* Why affected */}
            {(lead.why_affected || lead.why_financially_exposed) && (
              <div>
                <div className="xl">Why affected by this event</div>
                <div className="xv">{lead.why_affected || lead.why_financially_exposed}</div>
              </div>
            )}

            {/* Margin + timing risk */}
            {(lead.margin_risk || lead.payment_timing_risk) && (
              <div>
                <div className="xl">Risk profile</div>
                <div className="xv" style={{fontSize:11}}>
                  {lead.margin_risk && <div>Margin risk: <span style={{color:lead.margin_risk==="High"?"#F87171":lead.margin_risk==="Medium"?"#F59E0B":"#10B981"}}>{lead.margin_risk}</span></div>}
                  {lead.payment_timing_risk && <div>Payment timing risk: <span style={{color:lead.payment_timing_risk==="High"?"#F87171":lead.payment_timing_risk==="Medium"?"#F59E0B":"#10B981"}}>{lead.payment_timing_risk}</span></div>}
                  {lead.affected_payment_flow && <div style={{marginTop:3,color:"rgba(255,255,255,.35)"}}>{lead.affected_payment_flow}</div>}
                </div>
              </div>
            )}

            {/* Website */}
            {lead.website && (
              <div>
                <div className="xl">Website</div>
                <div className="xv" style={{wordBreak:"break-all",fontSize:11}}>
                  <a href={lead.website} target="_blank" rel="noreferrer" style={{color:"#38BDF8",textDecoration:"none"}}>
                    {lead.website}
                  </a>
                </div>
                {confBadge && <div className="site-detail">{confBadge}</div>}
                {expConf && expConf !== "none" && <div className="site-detail">{expConfLabel(expConf)}</div>}
                {lead.company_source && <div className="site-detail">Source: {lead.company_source.replace("_"," ")}</div>}
              </div>
            )}

            {/* FX signals */}
            {allSigs.length > 0 && (
              <div>
                <div className="xl">FX signals on website</div>
                <div className="sigs">
                  {allSigs.slice(0,10).map(s=><span key={s} className="sig">{s}</span>)}
                </div>
              </div>
            )}

            {/* Trigger event */}
            {lead.trigger_headline && (
              <div style={{gridColumn:"1/-1"}}>
                <div className="xl">Trigger event</div>
                <div className="xv" style={{fontSize:11,fontStyle:"italic",color:"rgba(255,255,255,.35)"}}>{lead.trigger_headline}</div>
              </div>
            )}

            {/* Scoring rationale */}
            {(lead.scoring_reasons||[]).length > 0 && (
              <div style={{gridColumn:"1/-1"}}>
                <div className="xl">Scoring rationale</div>
                <div className="xv" style={{fontSize:11,lineHeight:1.7}}>
                  {lead.scoring_reasons.slice(0,5).map((r,i)=><div key={i}>· {r}</div>)}
                </div>
              </div>
            )}
          </div>

          <EmailPatterns emails={lead.guessed_emails} />

          {(li || lead.company_name) && (() => {
            const co       = lead.company_name || li?.search_name || "";
            const dir      = lead.director_name || "";
            const hasDMs   = lead.decision_makers?.length > 0;
            // Fix #6: prefer native LinkedIn URLs (from TS enrich-decision-makers stage).
            // legacy company_linkedin may be a Google site: search — detect and skip.
            const isNativeLiUrl = u => u && (u.startsWith("https://www.linkedin.com/") || u.startsWith("https://linkedin.com/"));
            const coUrl =
              isNativeLiUrl(lead.company_linkedin) ? lead.company_linkedin :
              isNativeLiUrl(li?.company_search)     ? li.company_search :
              `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(co)}`;
            const dirUrl   = dir ? `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(dir)}` : null;
            const dirCoUrl = dir ? `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(dir + " " + co.split(" ").slice(0,3).join(" "))}` : null;
            // linkedin_assist.people_searches[] from old Python pipeline — use .url if it's a native LI URL
            const liAssistPeople = (li?.people_searches||[]).filter(p => isNativeLiUrl(p.url));
            return (
              <div className="li-section">
                <div className="xl" style={{marginBottom:7}}>LinkedIn — open manually, do not automate</div>
                <a href={coUrl} target="_blank" rel="noreferrer" className="li-company-btn">
                  💼 Find Company Page on LinkedIn →
                </a>
                {/* Only show generic role / single director links when DM panel isn't populated */}
                {!hasDMs && (
                  <div className="li-people">
                    {dir && (
                      <a href={dirCoUrl} target="_blank" rel="noreferrer" className="li-person-btn">
                        🔍 {dir} at {co.split(" ").slice(0,3).join(" ")} →
                      </a>
                    )}
                    {dir && (
                      <a href={dirUrl} target="_blank" rel="noreferrer" className="li-person-btn">
                        👤 {dir} (name only) →
                      </a>
                    )}
                    {/* Use native LI URLs from linkedin_assist if available */}
                    {liAssistPeople.slice(0,3).map((p,i)=>(
                      <a key={i} href={p.url} target="_blank" rel="noreferrer" className="li-person-btn">
                        {p.role || p.name || "Person"} →
                      </a>
                    ))}
                    {/* Role-based fallback when no named people */}
                    {!dir && liAssistPeople.length === 0 && (
                      <>
                        <a href={`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(co.split(" ").slice(0,3).join(" ") + " Finance Director")}`} target="_blank" rel="noreferrer" className="li-person-btn">Finance Director →</a>
                        <a href={`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(co.split(" ").slice(0,3).join(" ") + " Managing Director")}`} target="_blank" rel="noreferrer" className="li-person-btn">Managing Director →</a>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          <MessageAmmoPanel
            ingredients={lead.message_ingredients}
            outreach={lead.outreach}
          />

          <div style={{marginBottom:10,display:"flex",gap:8,flexWrap:"wrap"}}>
            <button className="act a-call" onClick={()=>{ const t = lead.message_ingredients?.call_opener || lead.outreach?.call_opener; if(t) copy(t); performAction && performAction(lead, "called"); }}>📞 Called</button>
            <button className="act a-email" onClick={()=>{ const t = lead.message_ingredients?.email_body || lead.email_draft || lead.outreach?.email_body; if(t) copy(t); performAction && performAction(lead, "email_sent"); }}>✉️ Email sent</button>
            <button className="act a-email" onClick={()=>{ performAction && performAction(lead, "linkedin_sent"); const t = lead.message_ingredients?.linkedin_note || lead.outreach?.linkedin_connection; if(t) copy(t); }}>💼 LinkedIn sent</button>
            <button className="act a-web" onClick={()=>{ performAction && performAction(lead, "replied"); }}>↩️ Replied</button>
            <button className="act a-call" onClick={()=>{ performAction && performAction(lead, "meeting_booked"); }}>📅 Meeting</button>
            <button className="act a-web" onClick={()=>{ performAction && performAction(lead, "not_relevant"); }}>❌ Not relevant</button>
            <button className="act a-web" onClick={()=>{ performAction && performAction(lead, "follow_later"); }}>⏭ Follow up later</button>
            {lead.website && <a href={lead.website} target="_blank" rel="noreferrer" className="act a-web">🌐 Website</a>}
            {lead.company_number && (
              <a href={`https://find-and-update.company-information.service.gov.uk/company/${lead.company_number}`} target="_blank" rel="noreferrer" className="act a-web">🏛 CH</a>
            )}
          </div>

          {/* Verification checkboxes + notes */}
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
            {['companyLinkedIn','personLinkedIn','email','phone','decisionMaker','bad_match'].map(k=>{
              const label = k==='companyLinkedIn'?"Company LI":k==='personLinkedIn'?"Person LI":k==='decisionMaker'?"Decision maker":k==='bad_match'?"Bad match":k.charAt(0).toUpperCase()+k.slice(1);
              const val = (crmEntry && crmEntry.verified && crmEntry.verified[k]) || false;
              return (
                <label key={k} style={{fontSize:12,opacity:.9,display:"inline-flex",alignItems:"center",gap:6}}>
                  <input type="checkbox" checked={val} onChange={e=>onCrmSet(lead.id,{ verified: {...(crmEntry?.verified||{}), [k]: e.target.checked } })} /> {label}
                </label>
              );
            })}
          </div>

          <div style={{marginBottom:12}}>
            <div className="xl">Notes</div>
            <textarea
              placeholder="Quick notes — who you spoke to, next steps"
              style={{width:"100%",minHeight:64,marginTop:8,padding:8,borderRadius:8,background:"#0b1222",border:"1px solid rgba(255,255,255,.05)",color:"#e6eef8"}}
              value={crmEntry?.notes||""}
              onChange={e=>onCrmSet(lead.id,{ notes: e.target.value })}
            />
          </div>

          {/* Route grade / research reasons */}
          <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:8}}>
            <div className="xl">Route grade</div>
            <div style={{fontWeight:700,fontSize:16}}>{routeGrade}</div>
            {['C','D','E'].includes(routeGrade) && (
              <div style={{fontSize:12,color:"rgba(255,255,255,.4)",padding:8,background:"rgba(255,255,255,.02)",borderRadius:8}}>
                {routeGrade==='C' && 'Grade C: director found but weak contact evidence. Verify LinkedIn and finance contact.'}
                {routeGrade==='D' && 'Grade D: website found but no named person. Check about/team pages.'}
                {routeGrade==='E' && 'Grade E: little contact evidence — research Companies House and company site.'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
