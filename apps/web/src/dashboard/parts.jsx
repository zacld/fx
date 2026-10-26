// Small parts of a lead card: size, phone, financials, FX intelligence, status, copy.
// (Split out of App.jsx; no behaviour change.)
import { useEffect, useState, useRef } from "react";
import { CRM_COLORS, CRM_LABELS, CRM_STATUSES } from "./crm.js";
import { copy } from "./format.js";

// ─── HELPERS ──────────────────────────────────────────────────────
export function expConfLabel(conf) {
  if (conf === "high")   return "🔍 Exposure: High confidence";
  if (conf === "medium") return "🔍 Exposure: Medium confidence";
  if (conf === "low")    return "🔍 Exposure: Low confidence";
  return null;
}
export function expConfClass(conf) {
  if (conf === "high")   return "b b-site-high";
  if (conf === "medium") return "b b-site-med";
  return "b b-site-low";
}

export function siteConfLabel(conf, source) {
  if (!conf) return null;
  const srcAbbr = source === "domain_guess" ? "domain"
    : source === "ddg_search" ? "DDG"
    : source === "companies_house" ? "CH"
    : source === "legacy" ? ""
    : source || "";
  const label = conf === "high" ? "verified · high"
    : conf === "medium" ? "verified · med"
    : conf === "confirmed" ? "verified"
    : conf === "low" ? "guessed · low"
    : null;
  if (!label) return null;
  return srcAbbr ? `🌐 ${label} · ${srcAbbr}` : `🌐 ${label}`;
}

export function siteConfClass(conf) {
  if (conf === "high" || conf === "confirmed") return "b b-site-high";
  if (conf === "medium") return "b b-site-med";
  return "b b-site-low";
}

// ─── COMPANY SIZE HELPERS ────────────────────────────────────────
export function sizeBandColor(band) {
  if (!band || band === "unknown" || band === "dormant") return "#475569";
  if (band === "<£1m")         return "#64748B";  // gray — micro/very small
  if (band === "£1m–£5m")      return "#F59E0B";  // amber — SME sweet spot
  if (band === "£5m–£25m")     return "#10B981";  // green — ideal FX target
  if (band === "£25m–£100m")   return "#38BDF8";  // blue — medium-large
  if (band === "£100m+")       return "#818CF8";  // purple — large corp
  return "#475569";
}
export function sizeBandLabel(band) {
  if (!band || band === "unknown") return null;
  if (band === "dormant") return "dormant";
  return band;
}
export function accTypeLabel(t) {
  if (!t) return null;
  const m = { "micro-entity":"micro", small:"small", medium:"medium", full:"full", group:"group", abridged:"abridged", dormant:"dormant" };
  return m[t] || t;
}
export function fmtGBP(n) {
  if (n == null) return null;
  if (n >= 1_000_000) return `£${(n/1_000_000).toFixed(1)}m`;
  if (n >= 1_000)     return `£${(n/1_000).toFixed(0)}k`;
  return `£${n.toFixed(0)}`;
}

// ─── PHONE BADGE ─────────────────────────────────────────────────
export function PhoneBadge({ phone, sourceCount, large = false }) {
  const [copied, setCopied] = useState(false);
  if (!phone) return null;
  const confirmed = (sourceCount || 0) >= 2;
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        fontFamily: "'JetBrains Mono',monospace",
        fontSize: large ? 13 : 10,
        fontWeight: 700,
        color: "#10B981",
        cursor: "pointer",
        userSelect: "none",
      }}
      title={confirmed ? `${sourceCount}-source confirmed — click to copy` : "Click to copy"}
      onClick={e => { e.stopPropagation(); copy(phone); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
    >
      📞
      <a href={`tel:${phone.replace(/\s/g, "")}`}
        onClick={e => e.stopPropagation()}
        style={{color: "inherit", textDecoration: "none"}}
      >{phone}</a>
      {confirmed && <span style={{color:"rgba(16,185,129,.5)",fontSize:8}}>✓×{sourceCount}</span>}
      {copied && <span style={{fontSize:9,color:"#10B981",background:"rgba(16,185,129,.15)",padding:"0 4px",borderRadius:3}}>copied!</span>}
    </span>
  );
}

// ─── COMPANY FINANCIALS PANEL ────────────────────────────────────
export function CompanyFinancials({ lead }) {
  const band    = lead.company_size_band;
  const actype  = lead.accounts_type;
  const emp     = lead.employee_count;
  const empBand = lead.employee_band;
  const turnover= lead.turnover_amount;
  const netAss  = lead.net_assets;
  const lastDate= lead.last_accounts_date;

  if (!band && !actype && emp == null) return null;
  if (band === "unknown" && !actype && emp == null) return null;

  const bc = sizeBandColor(band);

  return (
    <div className="fin-panel">
      <div className="fin-row">
        {band && band !== "unknown" && (
          <div className="fin-item">
            <div className="fin-label">Est. Revenue</div>
            <div className="fin-value" style={{color:bc}}>{sizeBandLabel(band)}</div>
          </div>
        )}
        {actype && actype !== "unknown" && (
          <div className="fin-item">
            <div className="fin-label">Accounts type</div>
            <div className="fin-value" style={{color:actype==="dormant"?"#F87171":"rgba(255,255,255,.6)"}}>{accTypeLabel(actype)}</div>
          </div>
        )}
        {turnover != null && (
          <div className="fin-item">
            <div className="fin-label">Turnover</div>
            <div className="fin-value" style={{color:"#10B981"}}>{fmtGBP(turnover)}</div>
          </div>
        )}
        {netAss != null && turnover == null && (
          <div className="fin-item">
            <div className="fin-label">Net assets</div>
            <div className="fin-value">{fmtGBP(netAss)}</div>
          </div>
        )}
        {emp != null && (
          <div className="fin-item">
            <div className="fin-label">Employees</div>
            <div className="fin-value">{emp}</div>
          </div>
        )}
        {emp == null && empBand && empBand !== "unknown" && (
          <div className="fin-item">
            <div className="fin-label">Employees</div>
            <div className="fin-value" style={{color:"rgba(255,255,255,.5)"}}>{empBand}</div>
          </div>
        )}
      </div>
      {lastDate && (
        <div className="fin-date">Last accounts: {lastDate}</div>
      )}
    </div>
  );
}

// ─── FX INTELLIGENCE CARD ────────────────────────────────────────
export const FXI_GRADE_COLOR = { A:"#10B981", B:"#F59E0B", C:"#818CF8", D:"#475569" };

export function FxIntelCard({ lead }) {
  const [copiedAngle, setCopiedAngle] = useState(false);
  const grade = lead.fx_priority;
  if (!grade || grade === "D") return null;  // hide D — not enough to show

  const color     = FXI_GRADE_COLOR[grade] || "#475569";
  const cardCls   = `fxi-card fxi-card-${grade.toLowerCase()}`;
  const currencies= lead.fx_currencies_detected || [];
  const creditors = lead.fx_creditors_gbp;
  const debtors   = lead.fx_debtors_gbp;
  const oppLabel  = lead.fx_opportunity_label;
  const evidence  = lead.fx_evidence || [];
  const angle     = lead.fx_call_angle;

  const copyAngle = () => {
    if (angle) { copy(angle); setCopiedAngle(true); setTimeout(()=>setCopiedAngle(false), 2000); }
  };

  return (
    <div className={cardCls}>
      <div className="fxi-header">
        <span className="fxi-grade" style={{color}}>{grade}</span>
        <span className="fxi-title">FX Priority {grade}{grade==="A"?" — Disclosed exposure":grade==="B"?" — Policy confirmed":""}</span>
        {currencies.length > 0 && (
          <div className="fxi-currencies">
            {currencies.slice(0,4).map(c=>(
              <span key={c} className="fxi-cur">{c}</span>
            ))}
          </div>
        )}
      </div>

      <div>
        {creditors != null && (
          <div className="fxi-row">
            <span className="fxi-lbl">FX Creditors</span>
            <span className="fxi-val" style={{color:"#10B981"}}>£{creditors.toLocaleString()}</span>
          </div>
        )}
        {debtors != null && (
          <div className="fxi-row">
            <span className="fxi-lbl">FX Debtors</span>
            <span className="fxi-val" style={{color:"#38BDF8"}}>£{debtors.toLocaleString()}</span>
          </div>
        )}
        {oppLabel && (
          <div className="fxi-row">
            <span className="fxi-lbl">Est. annual FX</span>
            <span className="fxi-val" style={{color}}>{oppLabel}</span>
          </div>
        )}
        {lead.fx_has_hedging && (
          <div className="fxi-row">
            <span className="fxi-lbl">Hedging</span>
            <span className="fxi-val" style={{color:"#F59E0B"}}>Referenced in accounts</span>
          </div>
        )}
      </div>

      {evidence.length > 0 && (
        <div className="fxi-evidence">
          {evidence.map((e,i)=>(
            <div key={i} className="fxi-ev-item">{e}</div>
          ))}
        </div>
      )}

      {angle && (
        <div
          className="fxi-angle"
          onClick={copyAngle}
          title="Click to copy call opener"
        >
          {copiedAngle ? <span style={{color:"#10B981",fontStyle:"normal",fontSize:10}}>Copied ✓</span> : `"${angle}"`}
        </div>
      )}
    </div>
  );
}

// ─── CRM BADGE ───────────────────────────────────────────────────
export function CrmBadge({ leadId, status, onSet }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const color = CRM_COLORS[status] || "#6366F1";

  useEffect(() => {
    if (!open) return;
    function close(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={ref} style={{position:"relative",display:"inline-flex"}}>
      <span
        className="crm-badge"
        style={{color, borderColor:`${color}40`, background:`${color}12`}}
        onClick={e => { e.stopPropagation(); setOpen(o=>!o); }}
        title="Change status"
      >
        ● {CRM_LABELS[status] || status}
      </span>
      {open && (
        <div className="crm-menu" onClick={e=>e.stopPropagation()}>
          {CRM_STATUSES.map(s => (
            <div
              key={s}
              className={`crm-opt${s===status?" active":""}`}
              onClick={() => { onSet(leadId, { status: s }); setOpen(false); }}
            >
              <span className="crm-dot" style={{background:CRM_COLORS[s]}}/>
              <span style={{color:CRM_COLORS[s]}}>{CRM_LABELS[s]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── COPY BUTTON ─────────────────────────────────────────────────
export function CopyBtn({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`copy-btn${done?" copied":""}`}
      onClick={() => { copy(text); setDone(true); setTimeout(()=>setDone(false),2000); }}
    >
      {done ? "✓ Copied" : "Copy"}
    </button>
  );
}
