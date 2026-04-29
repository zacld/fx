import { useEffect, useState, useCallback } from "react";

async function fetchData() {
  const [evRes, ldRes] = await Promise.all([
    fetch(`${import.meta.env.BASE_URL}data/events.json?t=${Date.now()}`),
    fetch(`${import.meta.env.BASE_URL}data/leads.json?t=${Date.now()}`),
  ]);
  const evObj = evRes.ok ? await evRes.json() : {};
  const ldObj = ldRes.ok ? await ldRes.json() : {};
  return {
    events: Object.values(evObj).sort((a,b)=>new Date(b.detected_at||0)-new Date(a.detected_at||0)),
    leads:  Object.values(ldObj).sort((a,b)=>(b.score||0)-(a.score||0)),
  };
}

function timeAgo(iso){
  if(!iso)return"";
  const s=Math.floor((Date.now()-new Date(iso))/1000);
  if(s<60)return`${s}s ago`;
  if(s<3600)return`${Math.floor(s/60)}m ago`;
  if(s<86400)return`${Math.floor(s/3600)}h ago`;
  return`${Math.floor(s/86400)}d ago`;
}
const uc=s=>s>=8?"#10B981":s>=6?"#F59E0B":s>=4?"#6366F1":"#475569";
const pc=p=>p==="HOT"?"#10B981":p==="WARM"?"#F59E0B":"#6366F1";
const pcbg=p=>p==="HOT"?"rgba(16,185,129,0.1)":p==="WARM"?"rgba(245,158,11,0.1)":"rgba(99,102,241,0.1)";

// ─── STYLES ──────────────────────────────────────────────────────
const S=`
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#07090F;color:#E2E8F0;font-family:'Inter',sans-serif;-webkit-font-smoothing:antialiased;font-size:14px}
::-webkit-scrollbar{width:4px}
::-webkit-scrollbar-thumb{background:rgba(16,185,129,0.25);border-radius:2px}

/* TOP BAR */
.topbar{
  position:sticky;top:0;z-index:100;
  background:rgba(7,9,15,0.9);backdrop-filter:blur(20px);
  border-bottom:1px solid rgba(255,255,255,0.05);
  padding:0 32px;height:52px;
  display:flex;align-items:center;justify-content:space-between;
}
.topbar-left{display:flex;align-items:center;gap:12px}
.tbl-logo{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:#F8FAFC}
.tbl-mark{width:28px;height:28px;border-radius:7px;background:linear-gradient(135deg,#10B981,#059669);display:grid;place-items:center;font-size:12px;font-weight:800;color:#fff}
.tbl-sep{width:1px;height:14px;background:rgba(255,255,255,0.1)}
.tbl-tag{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.1em;color:rgba(255,255,255,.25);text-transform:uppercase}
.topbar-right{display:flex;align-items:center;gap:10px}
.live{display:flex;align-items:center;gap:5px;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.08em;color:#10B981}
.live-dot{width:5px;height:5px;border-radius:50%;background:#10B981;box-shadow:0 0 6px #10B981;animation:lp 2s ease-in-out infinite}
@keyframes lp{0%,100%{opacity:1}50%{opacity:.3}}
.tbr-time{font-family:'JetBrains Mono',monospace;font-size:10px;color:rgba(255,255,255,.2)}
.btn-refresh{padding:6px 14px;border-radius:7px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.5);font-family:'Inter',sans-serif;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s}
.btn-refresh:hover{background:rgba(255,255,255,.08);color:#fff}

/* HERO BANNER */
.hero{
  padding:56px 32px 48px;
  border-bottom:1px solid rgba(255,255,255,.05);
  position:relative;overflow:hidden;
}
.hero::after{
  content:'';position:absolute;top:-120px;right:-60px;
  width:500px;height:500px;border-radius:50%;
  background:radial-gradient(circle,rgba(16,185,129,.06) 0%,transparent 70%);
  pointer-events:none;
}
.hero-eyebrow{
  display:inline-flex;align-items:center;gap:6px;
  font-family:'JetBrains Mono',monospace;font-size:10px;
  letter-spacing:.14em;text-transform:uppercase;
  color:#10B981;margin-bottom:18px;
  padding:4px 10px;border-radius:20px;
  background:rgba(16,185,129,.07);border:1px solid rgba(16,185,129,.2);
}
.hero-date{color:rgba(255,255,255,.35);margin-left:4px}
.hero-h1{font-size:clamp(32px,5vw,52px);font-weight:900;letter-spacing:-.04em;line-height:1.05;color:#F8FAFC;margin-bottom:14px}
.hero-h1 em{font-style:normal;background:linear-gradient(135deg,#10B981,#34D399);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.hero-sub{font-size:16px;line-height:1.7;color:rgba(255,255,255,.4);max-width:580px;margin-bottom:32px}
.hero-ctas{display:flex;gap:10px;flex-wrap:wrap}
.cta-primary{
  padding:12px 24px;border-radius:10px;
  background:linear-gradient(135deg,#10B981,#059669);
  color:#fff;font-size:14px;font-weight:700;
  border:none;cursor:pointer;font-family:'Inter',sans-serif;
  display:inline-flex;align-items:center;gap:7px;
  box-shadow:0 4px 24px rgba(16,185,129,.3);
  transition:all .2s;
}
.cta-primary:hover{transform:translateY(-2px);box-shadow:0 8px 32px rgba(16,185,129,.4)}
.cta-secondary{
  padding:12px 24px;border-radius:10px;
  background:rgba(255,255,255,.04);
  border:1px solid rgba(255,255,255,.1);
  color:rgba(255,255,255,.65);font-size:14px;font-weight:600;
  cursor:pointer;font-family:'Inter',sans-serif;
  display:inline-flex;align-items:center;gap:7px;
  transition:all .2s;
}
.cta-secondary:hover{background:rgba(255,255,255,.08);color:#fff}

/* STATS BAR */
.stats-bar{
  display:flex;gap:0;
  border-bottom:1px solid rgba(255,255,255,.05);
  padding:0 32px;
}
.stat-item{
  padding:14px 24px 14px 0;margin-right:24px;
  border-right:1px solid rgba(255,255,255,.05);
  display:flex;align-items:center;gap:10px;
}
.stat-item:last-child{border-right:none}
.stat-num{font-size:22px;font-weight:800;line-height:1}
.stat-info{}
.stat-label{font-size:11px;font-weight:500;color:rgba(255,255,255,.3);letter-spacing:.04em;text-transform:uppercase;display:block}
.stat-sub{font-family:'JetBrains Mono',monospace;font-size:9px;color:rgba(255,255,255,.15);letter-spacing:.06em;margin-top:1px;display:block}

/* MAIN LAYOUT */
.main{max-width:1440px;margin:0 auto;padding:0 32px 80px;display:grid;grid-template-columns:1fr 380px;gap:32px;align-items:start}
@media(max-width:1100px){.main{grid-template-columns:1fr}}
@media(max-width:600px){.main{padding:0 16px 60px}}

/* EVENT FEED */
.feed-header{
  display:flex;align-items:center;justify-content:space-between;
  padding:28px 0 18px;
}
.feed-title{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.3)}
.feed-count{font-family:'JetBrains Mono',monospace;font-size:10px;color:rgba(255,255,255,.2)}
.feed-list{display:flex;flex-direction:column;gap:0}

/* EVENT ITEM */
.ev-item{border-bottom:1px solid rgba(255,255,255,.05)}
.ev-item:last-child{border-bottom:none}
.ev-collapsed{
  padding:20px 0;cursor:pointer;
  display:grid;grid-template-columns:auto 1fr auto;
  gap:16px;align-items:start;
  transition:opacity .15s;
}
.ev-collapsed:hover{opacity:.85}
.ev-num{
  font-family:'JetBrains Mono',monospace;font-size:11px;
  color:rgba(255,255,255,.15);padding-top:3px;
  width:20px;flex-shrink:0;
}
.ev-main{}
.ev-meta-row{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.ev-type{
  font-family:'JetBrains Mono',monospace;font-size:9px;
  letter-spacing:.1em;text-transform:uppercase;
  padding:3px 8px;border-radius:5px;
  background:var(--ec-bg);border:1px solid var(--ec-border);
  color:var(--ec-color);
}
.ev-urgency-chip{
  display:flex;align-items:center;gap:5px;
  font-family:'JetBrains Mono',monospace;font-size:10px;
  color:var(--ec-color);
}
.ev-urgency-track{width:36px;height:2px;background:rgba(255,255,255,.08);border-radius:1px;overflow:hidden}
.ev-urgency-fill{height:100%;background:var(--ec-color)}
.ev-time{font-family:'JetBrains Mono',monospace;font-size:9px;color:rgba(255,255,255,.15);letter-spacing:.04em}
.ev-headline{font-size:17px;font-weight:700;line-height:1.4;color:#F8FAFC;letter-spacing:-.02em;margin-bottom:6px}
.ev-hook{font-size:13px;line-height:1.6;color:rgba(255,255,255,.4)}
.ev-right{display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex-shrink:0}
.ev-pairs{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}
.ev-pair{
  font-family:'JetBrains Mono',monospace;font-size:10px;
  padding:2px 7px;border-radius:4px;
  background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.2);color:#10B981;
}
.ev-lead-count{
  font-family:'JetBrains Mono',monospace;font-size:9px;
  color:rgba(255,255,255,.2);text-align:right;
}
.ev-expand-hint{
  font-size:11px;color:rgba(255,255,255,.2);
  display:flex;align-items:center;gap:4px;
  transition:color .15s;
}
.ev-item:hover .ev-expand-hint{color:#10B981}

/* EVENT EXPANDED SECTION */
.ev-expanded{
  padding:0 0 28px 36px;
  animation:fadeIn .2s ease;
}
@keyframes fadeIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
.ev-detail-grid{
  display:grid;grid-template-columns:1fr 1fr;gap:14px;
  margin-bottom:20px;
}
@media(max-width:700px){.ev-detail-grid{grid-template-columns:1fr}}
.ev-detail-block{}
.ev-detail-label{
  font-family:'JetBrains Mono',monospace;font-size:9px;
  letter-spacing:.14em;text-transform:uppercase;
  color:rgba(255,255,255,.2);margin-bottom:5px;
}
.ev-detail-value{font-size:13px;line-height:1.65;color:rgba(255,255,255,.55)}
.ev-impact-box{
  background:rgba(16,185,129,.04);
  border:1px solid rgba(16,185,129,.1);
  border-left:3px solid rgba(16,185,129,.4);
  border-radius:0 8px 8px 0;
  padding:12px 14px;margin-bottom:20px;
}
.ev-impact-label{
  font-family:'JetBrains Mono',monospace;font-size:9px;
  letter-spacing:.14em;text-transform:uppercase;
  color:#10B981;margin-bottom:4px;
}
.ev-impact-text{font-size:13px;line-height:1.65;color:rgba(255,255,255,.55)}
.ev-sectors-label{
  font-family:'JetBrains Mono',monospace;font-size:9px;
  letter-spacing:.14em;text-transform:uppercase;
  color:rgba(255,255,255,.2);margin-bottom:10px;
}
.ev-sectors-list{display:flex;flex-direction:column;gap:6px;margin-bottom:20px}
.ev-sector-row{
  display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:9px 14px;
  background:rgba(255,255,255,.025);
  border:1px solid rgba(255,255,255,.06);
  border-radius:8px;
  cursor:pointer;transition:all .15s;
}
.ev-sector-row:hover{background:rgba(255,255,255,.04);border-color:rgba(16,185,129,.2)}
.ev-sector-name{font-size:13px;font-weight:500;color:rgba(255,255,255,.7)}
.ev-sector-right{display:flex;align-items:center;gap:8px}
.ev-sector-count{font-family:'JetBrains Mono',monospace;font-size:9px;color:#10B981;padding:1px 6px;border-radius:3px;background:rgba(16,185,129,.1)}
.ev-sector-arrow{font-size:11px;color:rgba(255,255,255,.2);transition:color .15s}
.ev-sector-row:hover .ev-sector-arrow{color:#10B981}
.ev-companies-btn{
  display:flex;align-items:center;justify-content:center;gap:7px;
  width:100%;padding:11px;border-radius:9px;
  background:rgba(16,185,129,.1);
  border:1px solid rgba(16,185,129,.25);
  color:#10B981;font-size:13px;font-weight:700;
  cursor:pointer;transition:all .15s;font-family:'Inter',sans-serif;
}
.ev-companies-btn:hover{background:rgba(16,185,129,.18)}

/* COMPANY DRAWER */
.company-drawer{
  border-top:1px solid rgba(255,255,255,.05);
  padding:16px 0 24px;
  animation:fadeIn .2s ease;
}
.cd-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.cd-title{font-size:12px;font-weight:700;color:rgba(255,255,255,.5);letter-spacing:.04em}
.cd-back{font-size:11px;color:rgba(255,255,255,.25);background:none;border:none;cursor:pointer;font-family:'Inter',sans-serif;transition:color .15s}
.cd-back:hover{color:#10B981}
.cd-list{display:flex;flex-direction:column;gap:8px}

/* COMPANY CARD */
.cc{
  background:rgba(255,255,255,.025);
  border:1px solid rgba(255,255,255,.06);
  border-left:3px solid var(--cc-pc);
  border-radius:10px;overflow:hidden;
  transition:border-color .2s,box-shadow .2s;
}
.cc:hover{border-color:rgba(255,255,255,.1);box-shadow:0 4px 20px rgba(0,0,0,.3)}
.cc-main{padding:14px 16px 14px 14px;cursor:pointer;display:grid;grid-template-columns:1fr auto;gap:12px;align-items:start}
.cc-name{font-size:14px;font-weight:700;color:#F8FAFC;letter-spacing:-.01em;margin-bottom:4px}
.cc-sub{font-family:'JetBrains Mono',monospace;font-size:10px;color:rgba(255,255,255,.2);margin-bottom:8px;letter-spacing:.04em}
.cc-badges{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px}
.badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:500;border:1px solid transparent}
.badge-p{color:var(--cc-pc);background:rgba(0,0,0,.2);border-color:color-mix(in srgb,var(--cc-pc) 30%,transparent)}
.badge-sector{color:rgba(255,255,255,.4);background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.07)}
.badge-fx{color:#818CF8;background:rgba(129,140,248,.07);border-color:rgba(129,140,248,.18)}
.cc-meta{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:rgba(255,255,255,.3);margin-bottom:8px}
.cc-dir{display:inline-flex;align-items:center;gap:6px;font-size:12px}
.cc-dir-name{font-weight:600;color:rgba(255,255,255,.6)}
.cc-dir-role{color:rgba(255,255,255,.25)}
.cc-angle{font-size:11px;line-height:1.55;color:rgba(255,255,255,.4);padding:6px 10px;background:rgba(16,185,129,.03);border:1px solid rgba(16,185,129,.08);border-radius:6px}
.cc-score{display:flex;flex-direction:column;align-items:center;gap:2px;flex-shrink:0}
.cc-score-num{font-size:22px;font-weight:800;line-height:1;color:var(--cc-pc)}
.cc-score-lbl{font-family:'JetBrains Mono',monospace;font-size:8px;letter-spacing:.1em;text-transform:uppercase;color:var(--cc-pc);opacity:.6}
.cc-chevron{font-size:10px;color:rgba(255,255,255,.2);margin-top:4px;transition:color .15s}
.cc:hover .cc-chevron{color:rgba(255,255,255,.4)}

/* COMPANY EXPANDED */
.cc-expanded{
  border-top:1px solid rgba(255,255,255,.05);
  padding:14px 16px 16px;
  background:rgba(0,0,0,.15);
  animation:fadeIn .15s ease;
}
.cce-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px}
@media(max-width:600px){.cce-grid{grid-template-columns:1fr}}
.cce-label{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.2);margin-bottom:4px}
.cce-value{font-size:12px;line-height:1.6;color:rgba(255,255,255,.5)}
.cce-dir-card{display:inline-flex;align-items:center;gap:8px;padding:7px 12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:7px}
.cce-avatar{width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,rgba(16,185,129,.3),rgba(99,102,241,.3));border:1px solid rgba(16,185,129,.2);display:grid;place-items:center;font-size:10px;font-weight:700;color:#10B981;flex-shrink:0}
.cce-dname{font-size:13px;font-weight:600;color:#F8FAFC}
.cce-drole{font-family:'JetBrains Mono',monospace;font-size:10px;color:#10B981}
.opener-box{padding:10px 12px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.05);border-left:3px solid #10B981;border-radius:0 7px 7px 0;margin-bottom:12px}
.opener-label{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:#10B981;margin-bottom:3px}
.opener-text{font-size:12px;line-height:1.6;color:rgba(255,255,255,.45);font-style:italic}
.signal-list{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.sig{font-family:'JetBrains Mono',monospace;font-size:9px;padding:2px 6px;border-radius:3px;background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.15);color:rgba(129,140,248,.7)}
.action-row{display:flex;gap:6px;flex-wrap:wrap}
.act{flex:1;min-width:80px;padding:8px 10px;border-radius:7px;font-size:11px;font-weight:600;cursor:pointer;transition:all .15s;font-family:'Inter',sans-serif;display:flex;align-items:center;justify-content:center;gap:4px;border:none;text-decoration:none}
.act-call{background:rgba(16,185,129,.1);color:#10B981;border:1px solid rgba(16,185,129,.2)!important}
.act-call:hover{background:rgba(16,185,129,.18)}
.act-email{background:rgba(99,102,241,.1);color:#818CF8;border:1px solid rgba(99,102,241,.2)!important}
.act-email:hover{background:rgba(99,102,241,.18)}
.act-li{background:rgba(14,165,233,.1);color:#38BDF8;border:1px solid rgba(14,165,233,.2)!important}
.act-li:hover{background:rgba(14,165,233,.18)}
.act-web{background:rgba(255,255,255,.04);color:rgba(255,255,255,.4);border:1px solid rgba(255,255,255,.08)!important}
.act-web:hover{background:rgba(255,255,255,.07);color:rgba(255,255,255,.7)}

/* SIDEBAR */
.sidebar{padding-top:28px}
.sidebar-block{
  background:rgba(255,255,255,.025);
  border:1px solid rgba(255,255,255,.06);
  border-radius:12px;margin-bottom:14px;overflow:hidden;
}
.sb-title{
  padding:12px 16px;
  font-family:'JetBrains Mono',monospace;font-size:10px;
  letter-spacing:.12em;text-transform:uppercase;
  color:rgba(255,255,255,.3);
  border-bottom:1px solid rgba(255,255,255,.05);
}
.sb-stat-row{padding:12px 16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,.04)}
.sb-stat-row:last-child{border-bottom:none}
.sb-stat-label{font-size:12px;color:rgba(255,255,255,.4)}
.sb-stat-val{font-size:14px;font-weight:700}
.sb-event-item{
  padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.04);
  cursor:pointer;transition:background .15s;
}
.sb-event-item:last-child{border-bottom:none}
.sb-event-item:hover{background:rgba(255,255,255,.03)}
.sb-ev-type{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--suc);margin-bottom:3px}
.sb-ev-headline{font-size:12px;font-weight:600;color:rgba(255,255,255,.65);line-height:1.4;margin-bottom:4px}
.sb-ev-meta{font-family:'JetBrains Mono',monospace;font-size:9px;color:rgba(255,255,255,.2)}

/* EMPTY */
.empty{text-align:center;padding:60px 24px;color:rgba(255,255,255,.2)}
.empty-icon{font-size:36px;margin-bottom:12px}
.empty-title{font-size:15px;font-weight:600;color:rgba(255,255,255,.3);margin-bottom:6px}
.empty-sub{font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.8;color:rgba(255,255,255,.15)}
.empty-sub code{color:rgba(16,185,129,.5)}

@media(max-width:768px){
  .hero{padding:36px 16px 32px}
  .stats-bar{padding:0 16px;flex-wrap:wrap}
  .stat-item{padding:12px 16px 12px 0;margin-right:16px}
  .hero-h1{font-size:30px}
  .topbar{padding:0 16px}
}
`;

// ─── COMPANY CARD ───────────────────────────────────────────────
function CompanyCard({lead}){
  const [open,setOpen]=useState(false);
  const color=pc(lead.priority);
  const initials=(lead.director_name||"").split(" ").slice(0,2).map(w=>w[0]||"").join("").toUpperCase()||"?";
  return(
    <div className="cc" style={{"--cc-pc":color}}>
      <div className="cc-main" onClick={()=>setOpen(o=>!o)}>
        <div>
          <div className="cc-name">{lead.company_name}</div>
          <div className="cc-sub">
            {[lead.company_type?.toUpperCase(),lead.company_number&&`CH ${lead.company_number}`,lead.incorporated&&`Est. ${lead.incorporated.slice(0,4)}`].filter(Boolean).join(" · ")}
          </div>
          <div className="cc-badges">
            <span className="badge badge-p">● {lead.priority}</span>
            {lead.sector&&<span className="badge badge-sector">{lead.sector.slice(0,35)}</span>}
            {lead.fx_exposure&&<span className="badge badge-fx">{lead.fx_exposure}</span>}
          </div>
          <div className="cc-meta">
            {lead.address&&<span>📍 {lead.address.split(",").slice(-2).join(",").trim()}</span>}
            {lead.company_status&&<span style={{color:lead.company_status==="active"?"#10B981":"#F59E0B"}}>● {lead.company_status}</span>}
          </div>
          {lead.director_name&&(
            <div className="cc-dir" style={{marginBottom:8}}>
              <span style={{fontSize:11,color:"rgba(255,255,255,.2)"}}>👤</span>
              <span className="cc-dir-name">{lead.director_name}</span>
              <span className="cc-dir-role">· {lead.director_role}</span>
            </div>
          )}
          {lead.fx_reason&&<div className="cc-angle">{lead.fx_reason.slice(0,120)}{lead.fx_reason.length>120?"…":""}</div>}
        </div>
        <div className="cc-score">
          <div className="cc-score-num">{lead.score}</div>
          <div className="cc-score-lbl">Score</div>
          <div className="cc-chevron">{open?"▲":"▼"}</div>
        </div>
      </div>
      {open&&(
        <div className="cc-expanded">
          <div className="cce-grid">
            {lead.director_name&&(
              <div>
                <div className="cce-label">Decision maker</div>
                <div className="cce-dir-card">
                  <div className="cce-avatar">{initials}</div>
                  <div>
                    <div className="cce-dname">{lead.director_name}</div>
                    <div className="cce-drole">{lead.director_role}</div>
                  </div>
                </div>
              </div>
            )}
            <div>
              <div className="cce-label">FX exposure</div>
              <div className="cce-value">{lead.fx_payment_logic||lead.fx_reason||"—"}</div>
            </div>
            {(lead.fx_payment_signals||lead.import_export_signals||[]).length>0&&(
              <div>
                <div className="cce-label">Website signals</div>
                <div className="signal-list">
                  {(lead.fx_payment_signals||lead.import_export_signals||[]).slice(0,8).map(s=>(
                    <span key={s} className="sig">{s}</span>
                  ))}
                </div>
              </div>
            )}
            {(lead.scoring_reasons||[]).length>0&&(
              <div>
                <div className="cce-label">Why this score</div>
                <div className="cce-value" style={{fontSize:11,lineHeight:1.7}}>
                  {lead.scoring_reasons.slice(0,3).map((r,i)=><div key={i}>· {r}</div>)}
                </div>
              </div>
            )}
          </div>
          {lead.suggested_next_step&&(
            <div className="opener-box">
              <div className="opener-label">Suggested opener</div>
              <div className="opener-text">{lead.suggested_next_step}</div>
            </div>
          )}
          <div className="action-row">
            <button className="act act-call">📞 Call</button>
            <button className="act act-email">✉ Email</button>
            <button className="act act-li">💼 LinkedIn</button>
            {lead.website&&<a href={lead.website} target="_blank" rel="noreferrer" className="act act-web">🌐 Web</a>}
            {lead.company_number&&(
              <a href={`https://find-and-update.company-information.service.gov.uk/company/${lead.company_number}`} target="_blank" rel="noreferrer" className="act act-web">🏛 CH</a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── EVENT ITEM ─────────────────────────────────────────────────
function EventItem({event, leads, index}){
  const [open,setOpen]=useState(false);
  const [showCompanies,setShowCompanies]=useState(false);
  const color=uc(event.urgency_score||0);
  const eventLeads=leads.filter(l=>l.event_id===event.id);
  const sectors=event.who_pays_fx||event.affected_sectors||[];

  return(
    <div className="ev-item">
      {/* COLLAPSED ROW — always visible */}
      <div
        className="ev-collapsed"
        style={{"--ec-color":color,"--ec-bg":`${color}12`,"--ec-border":`${color}35`}}
        onClick={()=>{setOpen(o=>!o);if(open)setShowCompanies(false)}}
      >
        <div className="ev-num">{String(index+1).padStart(2,"0")}</div>
        <div className="ev-main">
          <div className="ev-meta-row">
            <span className="ev-type">{event.event_type||"Event"}</span>
            <div className="ev-urgency-chip">
              <div className="ev-urgency-track"><div className="ev-urgency-fill" style={{width:`${(event.urgency_score||0)*10}%`}}/></div>
              {event.urgency_score}/10
            </div>
            {event.detected_at&&<span className="ev-time">{timeAgo(event.detected_at)}</span>}
          </div>
          <div className="ev-headline">{event.headline}</div>
          <div className="ev-hook">{event.summary?.slice(0,120)}{(event.summary?.length||0)>120?"…":""}</div>
        </div>
        <div className="ev-right">
          <div className="ev-pairs">{(event.currency_pairs||[]).map(p=><span key={p} className="ev-pair">{p}</span>)}</div>
          {eventLeads.length>0&&<div className="ev-lead-count">{eventLeads.length} companies found</div>}
          <div className="ev-expand-hint">{open?"▲ less":"▼ more"}</div>
        </div>
      </div>

      {/* EXPANDED DETAIL */}
      {open&&(
        <div className="ev-expanded">
          {/* Full summary */}
          <div className="ev-detail-grid">
            {event.summary&&(
              <div className="ev-detail-block" style={{gridColumn:"1/-1"}}>
                <div className="ev-detail-label">What happened</div>
                <div className="ev-detail-value">{event.summary}</div>
              </div>
            )}
            {event.sales_angle&&(
              <div className="ev-detail-block">
                <div className="ev-detail-label">Sales angle</div>
                <div className="ev-detail-value" style={{fontStyle:"italic",color:"rgba(255,255,255,.4)"}}>"{event.sales_angle}"</div>
              </div>
            )}
            {(event.who_is_hurt||[]).length>0&&(
              <div className="ev-detail-block">
                <div className="ev-detail-label">Who is hurt</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:5,marginTop:4}}>
                  {(event.who_is_hurt||[]).slice(0,4).map(h=>(
                    <span key={h} style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,padding:"2px 7px",borderRadius:4,background:"rgba(239,68,68,.06)",border:"1px solid rgba(239,68,68,.15)",color:"rgba(252,165,165,.7)"}}>▼ {h}</span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* FX impact box */}
          {event.fx_payment_logic&&(
            <div className="ev-impact-box">
              <div className="ev-impact-label">Why businesses pay FX because of this</div>
              <div className="ev-impact-text">{event.fx_payment_logic}</div>
            </div>
          )}

          {/* Sectors list */}
          {sectors.length>0&&!showCompanies&&(
            <>
              <div className="ev-sectors-label">{sectors.length} types of business affected — click to see companies</div>
              <div className="ev-sectors-list">
                {sectors.map((s,i)=>{
                  const sLeads=eventLeads.filter(l=>(l.sector||"").toLowerCase().includes(s.toLowerCase().slice(0,12))||s.toLowerCase().includes((l.sector||"").toLowerCase().slice(0,12)));
                  return(
                    <div key={s} className="ev-sector-row" onClick={e=>{e.stopPropagation();setShowCompanies(true)}}>
                      <div style={{display:"flex",alignItems:"center",gap:10}}>
                        <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"rgba(255,255,255,.15)",width:18}}>{String(i+1).padStart(2,"0")}</span>
                        <span className="ev-sector-name">{s}</span>
                      </div>
                      <div className="ev-sector-right">
                        {sLeads.length>0&&<span className="ev-sector-count">{sLeads.length} found</span>}
                        <span className="ev-sector-arrow">→</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              {eventLeads.length>0&&(
                <button className="ev-companies-btn" onClick={e=>{e.stopPropagation();setShowCompanies(true)}}>
                  View all {eventLeads.length} affected companies →
                </button>
              )}
              {eventLeads.length===0&&(
                <div style={{padding:"12px 0",textAlign:"center",fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:"rgba(255,255,255,.2)"}}>
                  No companies found yet · run <code style={{color:"rgba(16,185,129,.5)"}}>discover.py</code> to populate
                </div>
              )}
            </>
          )}

          {/* Companies drawer */}
          {showCompanies&&eventLeads.length>0&&(
            <div className="company-drawer" onClick={e=>e.stopPropagation()}>
              <div className="cd-header">
                <div className="cd-title">{eventLeads.length} companies with FX exposure · sorted by score</div>
                <button className="cd-back" onClick={e=>{e.stopPropagation();setShowCompanies(false)}}>← Back to sectors</button>
              </div>
              <div className="cd-list">
                {eventLeads.map(lead=><CompanyCard key={lead.id} lead={lead}/>)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── ROOT APP ───────────────────────────────────────────────────
export default function App(){
  const [events,setEvents]=useState([]);
  const [leads,setLeads]=useState([]);
  const [loading,setLoading]=useState(true);
  const [lastRefresh,setLastRefresh]=useState(null);

  const loadData=useCallback(async()=>{
    setLoading(true);
    try{
      const d=await fetchData();
      setEvents(d.events);setLeads(d.leads);
      setLastRefresh(new Date());
    }catch(e){console.error(e);}
    finally{setLoading(false);}
  },[]);

  useEffect(()=>{loadData();},[loadData]);

  const hot=leads.filter(l=>l.priority==="HOT").length;
  const warm=leads.filter(l=>l.priority==="WARM").length;
  const today=new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"});

  return(
    <>
      <style>{S}</style>

      {/* TOP BAR */}
      <div className="topbar">
        <div className="topbar-left">
          <div className="tbl-logo"><div className="tbl-mark">FX</div>Universal Partners</div>
          <div className="tbl-sep"/>
          <div className="tbl-tag">Discovery Engine</div>
        </div>
        <div className="topbar-right">
          <div className="live"><div className="live-dot"/>LIVE</div>
          {lastRefresh&&<span className="tbr-time">{timeAgo(lastRefresh)}</span>}
          <button className="btn-refresh" onClick={loadData} disabled={loading}>{loading?"…":"↻ Refresh"}</button>
        </div>
      </div>

      {/* HERO */}
      <div className="hero">
        <div className="hero-eyebrow">
          <span>●</span> Live market intelligence
          <span className="hero-date">· {new Date().toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"})}</span>
        </div>
        <h1 className="hero-h1">What happened today —<br/><em>and who you should call</em></h1>
        <p className="hero-sub">Every market event, tariff, rate decision and geopolitical shock mapped to the exact UK businesses writing cheques in foreign currency. Click any event to see the full picture.</p>
        <div className="hero-ctas">
          <button className="cta-primary" onClick={loadData}>⚡ Refresh Intelligence</button>
          <button className="cta-secondary" onClick={()=>document.querySelector(".feed-list")?.scrollIntoView({behavior:"smooth"})}>
            {events.length>0?`↓ ${events.length} events today`:"↓ View events"}
          </button>
        </div>
      </div>

      {/* STATS BAR */}
      <div className="stats-bar">
        {[
          {num:events.length,label:"Events today",sub:"Detected",color:"#10B981"},
          {num:hot,label:"Hot companies",sub:"Score 80+",color:"#10B981"},
          {num:warm,label:"Warm companies",sub:"Score 60+",color:"#F59E0B"},
          {num:leads.length,label:"Total leads",sub:"All events",color:"#6366F1"},
        ].map(({num,label,sub,color})=>(
          <div className="stat-item" key={label}>
            <div className="stat-num" style={{color}}>{num}</div>
            <div className="stat-info">
              <span className="stat-label">{label}</span>
              <span className="stat-sub">{sub}</span>
            </div>
          </div>
        ))}
      </div>

      {/* MAIN */}
      <div className="main">
        {/* FEED */}
        <div>
          <div className="feed-header">
            <div className="feed-title">Today's market events</div>
            <div className="feed-count">{today}</div>
          </div>

          {events.length===0?(
            <div className="empty">
              <div className="empty-icon">📡</div>
              <div className="empty-title">No events detected yet</div>
              <div className="empty-sub">Run <code>python3 scripts/ingest.py</code> to pull today's market events<br/>then <code>python3 scripts/discover.py</code> to find affected companies</div>
            </div>
          ):(
            <div className="feed-list">
              {events.map((ev,i)=>(
                <EventItem key={ev.id} event={ev} leads={leads} index={i}/>
              ))}
            </div>
          )}
        </div>

        {/* SIDEBAR */}
        <div className="sidebar">
          <div className="sidebar-block">
            <div className="sb-title">Intelligence summary</div>
            {[
              {label:"Events detected",val:events.length,color:"#10B981"},
              {label:"Hot leads",val:hot,color:"#10B981"},
              {label:"Warm leads",val:warm,color:"#F59E0B"},
              {label:"Total companies",val:leads.length,color:"#6366F1"},
            ].map(({label,val,color})=>(
              <div className="sb-stat-row" key={label}>
                <span className="sb-stat-label">{label}</span>
                <span className="sb-stat-val" style={{color}}>{val}</span>
              </div>
            ))}
          </div>

          {events.length>0&&(
            <div className="sidebar-block">
              <div className="sb-title">Event index</div>
              {events.map(ev=>(
                <div
                  key={ev.id}
                  className="sb-event-item"
                  style={{"--suc":uc(ev.urgency_score||0)}}
                  onClick={()=>{
                    document.querySelector(\`[data-ev-id="${ev.id}"]\`)?.scrollIntoView({behavior:"smooth"});
                  }}
                >
                  <div className="sb-ev-type">{ev.event_type} · {ev.urgency_score}/10</div>
                  <div className="sb-ev-headline">{ev.headline.slice(0,60)}{ev.headline.length>60?"…":""}</div>
                  <div className="sb-ev-meta">{(ev.currency_pairs||[]).join(" · ")} · {timeAgo(ev.detected_at)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
// v9 Wed Apr 29 11:57:02 UTC 2026
