import { useEffect, useState, useCallback, useMemo } from "react";

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

const ago = iso => {
  if(!iso) return "";
  const s = Math.floor((Date.now()-new Date(iso))/1000);
  if(s<60) return`${s}s ago`; if(s<3600) return`${Math.floor(s/60)}m ago`;
  if(s<86400) return`${Math.floor(s/3600)}h ago`; return`${Math.floor(s/86400)}d ago`;
};

const urg = s => s>=8?"#10B981":s>=6?"#F59E0B":s>=4?"#6366F1":"#475569";
const pri = p => p==="HOT"?"#10B981":p==="WARM"?"#F59E0B":"#6366F1";

const expClass = l => l==="Very High"?"exp-vh":l==="High"?"exp-h":l==="Medium"?"exp-m":"exp-l";
const expLabel = l => l==="Very High"?"● Very High":l==="High"?"● High":l==="Medium"?"○ Medium":"○ Low";

const today = new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"});
const dateShort = new Date().toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"});

function copy(text) { navigator.clipboard.writeText(text).catch(()=>{}); }

const PRIORITY_COLORS = { HOT:"#10B981", WARM:"#F59E0B", COLD:"#475569", QUEUE:"#6366F1" };

const DEFAULT_FILTERS = {
  hotView: true,
  priorities: [],      // empty = all
  hasDirector: false,
  hasWebsite: false,
  minScore: 0,
  eventId: "all",
  exposureLevel: "all",
  newOnly: false,
};

const HOT_VIEW_FILTERS = {
  hotView: true,
  priorities: ["HOT"],
  hasDirector: false,
  hasWebsite: false,
  minScore: 0,
  eventId: "all",
  exposureLevel: "all",
  newOnly: false,
};

function applyFilters(leads, filters) {
  return leads.filter(l => {
    if (filters.priorities.length && !filters.priorities.includes(l.priority)) return false;
    if (filters.hasDirector && !l.director_name) return false;
    if (filters.hasWebsite && !l.website) return false;
    if (filters.minScore > 0 && (l.score||0) < filters.minScore) return false;
    if (filters.eventId !== "all" && l.event_id !== filters.eventId) return false;
    if (filters.exposureLevel !== "all" && l.exposure_level !== filters.exposureLevel) return false;
    if (filters.newOnly) {
      const age = Date.now() - new Date(l.created_at||0);
      if (age > 86400000) return false;
    }
    return true;
  });
}

// ─── STYLES ──────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:#07090F;color:#E2E8F0;font-family:'Inter',sans-serif;-webkit-font-smoothing:antialiased;font-size:14px;line-height:1.5}
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:rgba(16,185,129,.25);border-radius:2px}

/* TOPBAR */
.tb{position:sticky;top:0;z-index:100;background:rgba(7,9,15,.92);backdrop-filter:blur(20px);border-bottom:1px solid rgba(255,255,255,.05);padding:0 40px;height:52px;display:flex;align-items:center;justify-content:space-between}
.tb-l{display:flex;align-items:center;gap:12px}
.tb-logo{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:#F8FAFC;text-decoration:none}
.tb-mark{width:28px;height:28px;border-radius:7px;background:linear-gradient(135deg,#10B981,#059669);display:grid;place-items:center;font-size:12px;font-weight:800;color:#fff;flex-shrink:0}
.tb-sep{width:1px;height:14px;background:rgba(255,255,255,.1)}
.tb-tag{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.1em;color:rgba(255,255,255,.25);text-transform:uppercase}
.tb-r{display:flex;align-items:center;gap:10px}
.live{display:flex;align-items:center;gap:5px;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.08em;color:#10B981}
.live-dot{width:5px;height:5px;border-radius:50%;background:#10B981;box-shadow:0 0 6px #10B981;animation:lp 2s ease-in-out infinite}
@keyframes lp{0%,100%{opacity:1}50%{opacity:.3}}
.tb-time{font-family:'JetBrains Mono',monospace;font-size:10px;color:rgba(255,255,255,.2)}
.btn-sm{padding:6px 14px;border-radius:7px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.5);font-family:'Inter',sans-serif;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s}
.btn-sm:hover{background:rgba(255,255,255,.08);color:#fff}
@media(max-width:600px){.tb{padding:0 16px}.tb-tag{display:none}}

/* HERO */
.hero{padding:60px 40px 52px;border-bottom:1px solid rgba(255,255,255,.05);position:relative;overflow:hidden}
.hero::after{content:'';position:absolute;top:-100px;right:-80px;width:480px;height:480px;border-radius:50%;background:radial-gradient(circle,rgba(16,185,129,.07) 0%,transparent 70%);pointer-events:none}
.hero-eyebrow{display:inline-flex;align-items:center;gap:6px;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#10B981;margin-bottom:20px;padding:4px 10px;border-radius:20px;background:rgba(16,185,129,.07);border:1px solid rgba(16,185,129,.2)}
.hero-h1{font-size:clamp(34px,4.5vw,54px);font-weight:900;letter-spacing:-.04em;line-height:1.05;color:#F8FAFC;margin-bottom:14px}
.hero-h1 em{font-style:normal;background:linear-gradient(135deg,#10B981,#34D399);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.hero-sub{font-size:16px;line-height:1.7;color:rgba(255,255,255,.4);max-width:600px;margin-bottom:32px}
.hero-ctas{display:flex;gap:10px;flex-wrap:wrap}
.cta-p{padding:12px 24px;border-radius:10px;background:linear-gradient(135deg,#10B981,#059669);color:#fff;font-size:14px;font-weight:700;border:none;cursor:pointer;font-family:'Inter',sans-serif;display:inline-flex;align-items:center;gap:7px;box-shadow:0 4px 24px rgba(16,185,129,.3);transition:all .2s}
.cta-p:hover{transform:translateY(-2px);box-shadow:0 8px 32px rgba(16,185,129,.4)}
.cta-s{padding:12px 24px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.65);font-size:14px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;display:inline-flex;align-items:center;gap:7px;transition:all .2s}
.cta-s:hover{background:rgba(255,255,255,.08);color:#fff}
@media(max-width:600px){.hero{padding:36px 16px 32px}.hero-ctas{flex-direction:column}}

/* STATS BAR */
.stats{display:flex;gap:0;border-bottom:1px solid rgba(255,255,255,.05);padding:0 40px;overflow-x:auto}
.stat{padding:14px 28px 14px 0;margin-right:28px;border-right:1px solid rgba(255,255,255,.05);display:flex;align-items:center;gap:10px;white-space:nowrap;flex-shrink:0}
.stat:last-child{border-right:none}
.stat-n{font-size:22px;font-weight:800;line-height:1}
.stat-l{font-size:11px;font-weight:500;color:rgba(255,255,255,.3);text-transform:uppercase;letter-spacing:.04em;display:block}
.stat-s{font-family:'JetBrains Mono',monospace;font-size:9px;color:rgba(255,255,255,.15);letter-spacing:.06em;display:block;margin-top:1px}
@media(max-width:600px){.stats{padding:0 16px}}

/* FILTER BAR */
.fb{padding:12px 40px;border-bottom:1px solid rgba(255,255,255,.05);display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:rgba(255,255,255,.015)}
.fb-group{display:flex;align-items:center;gap:5px}
.fb-label{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.18);white-space:nowrap;margin-right:3px}
.fb-sep{width:1px;height:20px;background:rgba(255,255,255,.07);flex-shrink:0}
.chip{padding:4px 11px;border-radius:20px;font-size:11px;font-weight:600;cursor:pointer;border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.03);color:rgba(255,255,255,.3);transition:all .15s;font-family:'Inter',sans-serif;white-space:nowrap;user-select:none}
.chip:hover{border-color:rgba(255,255,255,.18);color:rgba(255,255,255,.6)}
.chip.on{background:rgba(16,185,129,.12);border-color:rgba(16,185,129,.35);color:#10B981}
.chip.hot-on{background:rgba(16,185,129,.12);border-color:rgba(16,185,129,.35);color:#10B981}
.chip.warm-on{background:rgba(245,158,11,.1);border-color:rgba(245,158,11,.35);color:#F59E0B}
.chip.queue-on{background:rgba(99,102,241,.1);border-color:rgba(99,102,241,.35);color:#818CF8}
.chip.hv{background:rgba(16,185,129,.08);border-color:rgba(16,185,129,.25);color:#10B981;font-weight:700}
.chip.hv.on{background:rgba(16,185,129,.18);border-color:#10B981;box-shadow:0 0 0 1px rgba(16,185,129,.3)}
.fb-select{padding:4px 8px;border-radius:7px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);color:rgba(255,255,255,.35);font-family:'Inter',sans-serif;font-size:11px;cursor:pointer;outline:none;transition:all .15s}
.fb-select:focus,.fb-select:hover{border-color:rgba(16,185,129,.25);color:rgba(255,255,255,.6)}
.fb-select option{background:#111}
.fb-count{font-family:'JetBrains Mono',monospace;font-size:10px;color:rgba(16,185,129,.8);background:rgba(16,185,129,.07);padding:3px 9px;border-radius:4px;border:1px solid rgba(16,185,129,.15);margin-left:auto;white-space:nowrap}
.fb-reset{padding:4px 10px;border-radius:7px;background:none;border:1px solid rgba(255,255,255,.07);color:rgba(255,255,255,.2);font-size:11px;cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s;white-space:nowrap}
.fb-reset:hover{border-color:rgba(255,255,255,.18);color:rgba(255,255,255,.5)}
@media(max-width:600px){.fb{padding:10px 16px}.fb-sep{display:none}}

/* HOT VIEW BANNER */
.hv-bar{padding:8px 40px;background:rgba(16,185,129,.04);border-bottom:1px solid rgba(16,185,129,.1);display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.hv-tag{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:#10B981;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.2);padding:2px 8px;border-radius:4px;flex-shrink:0}
.hv-desc{font-size:12px;color:rgba(255,255,255,.3)}
.hv-clear{margin-left:auto;padding:3px 10px;border-radius:5px;background:none;border:1px solid rgba(16,185,129,.2);color:rgba(16,185,129,.6);font-size:11px;cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s}
.hv-clear:hover{background:rgba(16,185,129,.08);color:#10B981}
@media(max-width:600px){.hv-bar{padding:8px 16px}}

/* LAYOUT */
.layout{max-width:1500px;margin:0 auto;padding:0 40px 80px;display:grid;grid-template-columns:1fr 340px;gap:40px;align-items:start}
@media(max-width:1080px){.layout{grid-template-columns:1fr}}
@media(max-width:600px){.layout{padding:0 16px 60px;gap:24px}}

/* FEED */
.feed-hdr{display:flex;align-items:center;justify-content:space-between;padding:32px 0 16px;gap:12px}
.feed-title{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.3)}
.feed-date{font-family:'JetBrains Mono',monospace;font-size:10px;color:rgba(255,255,255,.15)}
.feed{display:flex;flex-direction:column}

/* EVENT ROW */
.ev{border-bottom:1px solid rgba(255,255,255,.05)}
.ev:last-child{border-bottom:none}
.ev-row{padding:24px 0;cursor:pointer;display:grid;grid-template-columns:28px 1fr auto;gap:16px;align-items:start}
.ev-num{font-family:'JetBrains Mono',monospace;font-size:11px;color:rgba(255,255,255,.15);padding-top:4px}
.ev-body{}
.ev-tags{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}
.ev-type{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.1em;text-transform:uppercase;padding:3px 8px;border-radius:5px;border:1px solid;white-space:nowrap}
.ev-urg{display:flex;align-items:center;gap:5px;font-family:'JetBrains Mono',monospace;font-size:10px}
.ev-track{width:36px;height:2px;background:rgba(255,255,255,.08);border-radius:1px;overflow:hidden}
.ev-fill{height:100%;border-radius:1px}
.ev-when{font-family:'JetBrains Mono',monospace;font-size:9px;color:rgba(255,255,255,.15)}
.ev-headline{font-size:19px;font-weight:800;line-height:1.35;color:#F8FAFC;letter-spacing:-.025em;margin-bottom:8px}
.ev-summary{font-size:13px;line-height:1.65;color:rgba(255,255,255,.4);margin-bottom:0}
.ev-meta{display:flex;align-items:center;gap:10px;margin-top:12px;flex-wrap:wrap}
.ev-pairs{display:flex;gap:4px}
.ev-pair{font-family:'JetBrains Mono',monospace;font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.2);color:#10B981}
.ev-lcount{font-family:'JetBrains Mono',monospace;font-size:10px;color:rgba(255,255,255,.2)}
.ev-right{display:flex;flex-direction:column;align-items:flex-end;gap:10px;flex-shrink:0;min-width:80px}
.ev-hint{font-size:11px;color:rgba(255,255,255,.18);transition:color .15s}
.ev:hover .ev-hint{color:#10B981}
.ev-open-btn{display:inline-flex;align-items:center;gap:5px;padding:7px 14px;border-radius:7px;background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.2);color:#10B981;font-size:12px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s;white-space:nowrap}
.ev-open-btn:hover{background:rgba(16,185,129,.15)}

/* EVENT EXPANDED */
.ev-expanded{padding:0 0 28px 44px;animation:fi .2s ease}
@keyframes fi{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}
.ev-detail-row{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:20px}
@media(max-width:640px){.ev-detail-row{grid-template-columns:1fr}}
.ev-dl{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.2);margin-bottom:5px}
.ev-dv{font-size:13px;line-height:1.65;color:rgba(255,255,255,.5)}
.ev-fx-box{background:rgba(16,185,129,.04);border:1px solid rgba(16,185,129,.1);border-left:3px solid rgba(16,185,129,.4);border-radius:0 9px 9px 0;padding:14px 16px;margin-bottom:20px}
.ev-fx-label{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#10B981;margin-bottom:5px}
.ev-fx-text{font-size:13px;line-height:1.65;color:rgba(255,255,255,.6);font-weight:500}
.niche-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.niche-label{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.2)}
.niche-hint{font-size:11px;color:rgba(255,255,255,.2)}
.niches{display:flex;flex-direction:column;gap:4px;margin-bottom:20px}
.niche-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.05);border-radius:8px;cursor:pointer;transition:all .15s}
.niche-row:hover{background:rgba(255,255,255,.04);border-color:rgba(16,185,129,.2)}
.niche-left{display:flex;align-items:center;gap:10px}
.niche-idx{font-family:'JetBrains Mono',monospace;font-size:10px;color:rgba(255,255,255,.15);width:20px;flex-shrink:0}
.niche-name{font-size:13px;font-weight:500;color:rgba(255,255,255,.7)}
.niche-right{display:flex;align-items:center;gap:8px}
.niche-badge{font-family:'JetBrains Mono',monospace;font-size:9px;padding:2px 7px;border-radius:4px;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.2);color:#10B981}
.niche-arr{font-size:11px;color:rgba(255,255,255,.2);transition:color .15s}
.niche-row:hover .niche-arr{color:#10B981}
.show-companies-btn{width:100%;padding:10px;border-radius:8px;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.25);color:#10B981;font-size:13px;font-weight:700;cursor:pointer;transition:all .15s;font-family:'Inter',sans-serif;display:flex;align-items:center;justify-content:center;gap:6px}
.show-companies-btn:hover{background:rgba(16,185,129,.18)}

/* COMPANY DRAWER */
.co-drawer{border-top:1px solid rgba(255,255,255,.05);padding:20px 0 4px;animation:fi .2s ease}
.co-drawer-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px}
.co-drawer-title{font-size:12px;font-weight:700;color:rgba(255,255,255,.4);letter-spacing:.04em}
.co-back{font-size:11px;color:rgba(255,255,255,.25);background:none;border:none;cursor:pointer;font-family:'Inter',sans-serif;transition:color .15s}
.co-back:hover{color:#10B981}
.co-list{display:flex;flex-direction:column;gap:8px}
.co-filtered-note{font-family:'JetBrains Mono',monospace;font-size:10px;color:rgba(16,185,129,.5);background:rgba(16,185,129,.05);border:1px solid rgba(16,185,129,.1);padding:4px 10px;border-radius:5px}

/* COMPANY CARD */
.cc{background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.06);border-left:3px solid var(--pc);border-radius:11px;overflow:hidden;transition:border-color .2s,box-shadow .2s}
.cc:hover{border-color:rgba(255,255,255,.1);box-shadow:0 4px 20px rgba(0,0,0,.3)}
.cc-top{padding:16px 18px 16px 15px;cursor:pointer;display:grid;grid-template-columns:1fr auto;gap:12px;align-items:start}
.cc-name{font-size:15px;font-weight:700;color:#F8FAFC;letter-spacing:-.01em;margin-bottom:3px}
.cc-meta{font-family:'JetBrains Mono',monospace;font-size:10px;color:rgba(255,255,255,.2);margin-bottom:8px}
.cc-badges{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px}
.b{display:inline-flex;align-items:center;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:500;border:1px solid transparent}
.b-p{color:var(--pc);background:rgba(0,0,0,.15)}
.b-sec{color:rgba(255,255,255,.4);background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.07)}
.b-fx{color:#818CF8;background:rgba(129,140,248,.07);border-color:rgba(129,140,248,.18)}
.cc-info{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:rgba(255,255,255,.3);margin-bottom:8px}
.cc-dir{display:inline-flex;align-items:center;gap:5px}
.cc-dir b{color:rgba(255,255,255,.55);font-weight:600}
.cc-angle{font-size:11px;line-height:1.55;color:rgba(255,255,255,.4);padding:7px 10px;background:rgba(16,185,129,.03);border:1px solid rgba(16,185,129,.08);border-radius:6px}
.cc-score{display:flex;flex-direction:column;align-items:center;gap:2px;flex-shrink:0}
.cc-sn{font-size:22px;font-weight:800;line-height:1;color:var(--pc)}
.cc-sl{font-family:'JetBrains Mono',monospace;font-size:8px;letter-spacing:.1em;text-transform:uppercase;color:var(--pc);opacity:.6}
.cc-chev{font-size:10px;color:rgba(255,255,255,.18);margin-top:4px;transition:color .15s}
.cc:hover .cc-chev{color:rgba(255,255,255,.35)}

/* COMPANY EXPANDED */
.cc-exp{border-top:1px solid rgba(255,255,255,.05);padding:14px 18px 18px 15px;background:rgba(0,0,0,.15);animation:fi .15s ease}
.cc-exp-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px}
@media(max-width:500px){.cc-exp-grid{grid-template-columns:1fr}}
.xl{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.2);margin-bottom:4px}
.xv{font-size:12px;line-height:1.6;color:rgba(255,255,255,.5)}
.dir-card{display:inline-flex;align-items:center;gap:8px;padding:7px 12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:7px}
.dir-av{width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,rgba(16,185,129,.3),rgba(99,102,241,.3));border:1px solid rgba(16,185,129,.2);display:grid;place-items:center;font-size:10px;font-weight:700;color:#10B981;flex-shrink:0}
.dir-nm{font-size:13px;font-weight:600;color:#F8FAFC}
.dir-rl{font-family:'JetBrains Mono',monospace;font-size:10px;color:#10B981}

/* OUTREACH PANEL */
.outreach{margin-bottom:14px}
.out-tabs{display:flex;gap:2px;margin-bottom:0;border-bottom:1px solid rgba(255,255,255,.06)}
.out-tab{padding:6px 12px;font-size:11px;font-weight:500;cursor:pointer;background:none;border:none;color:rgba(255,255,255,.3);font-family:'Inter',sans-serif;border-bottom:2px solid transparent;margin-bottom:-1px;transition:all .15s}
.out-tab:hover{color:rgba(255,255,255,.6)}
.out-tab.active{color:#10B981;border-bottom-color:#10B981}
.out-content{position:relative;margin-top:0}
.out-text{font-size:12px;line-height:1.7;color:rgba(255,255,255,.5);padding:12px 14px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06);border-top:none;border-radius:0 0 8px 8px;white-space:pre-wrap;word-break:break-word;min-height:60px}
.out-subject{font-family:'JetBrains Mono',monospace;font-size:10px;color:#10B981;padding:6px 14px;background:rgba(16,185,129,.05);border:1px solid rgba(16,185,129,.12);border-bottom:none;border-radius:8px 8px 0 0}
.copy-btn{position:absolute;top:8px;right:8px;padding:4px 10px;border-radius:5px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.4);font-size:10px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s}
.copy-btn:hover{background:rgba(255,255,255,.1);color:#fff}
.copy-btn.copied{background:rgba(16,185,129,.15);border-color:rgba(16,185,129,.3);color:#10B981}

/* LINKEDIN LINKS */
.li-section{margin-bottom:14px}
.li-company-btn{display:flex;align-items:center;gap:6px;width:100%;padding:9px 12px;border-radius:7px;background:rgba(14,165,233,.07);border:1px solid rgba(14,165,233,.18);color:#38BDF8;font-size:12px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s;text-decoration:none;margin-bottom:8px}
.li-company-btn:hover{background:rgba(14,165,233,.13)}
.li-people{display:flex;flex-wrap:wrap;gap:5px}
.li-person-btn{display:inline-flex;align-items:center;gap:4px;padding:5px 10px;border-radius:6px;background:rgba(14,165,233,.05);border:1px solid rgba(14,165,233,.13);color:#38BDF8;font-size:11px;font-weight:500;cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s;text-decoration:none}
.li-person-btn:hover{background:rgba(14,165,233,.1)}

/* ACTION BUTTONS */
.actions{display:flex;gap:6px;flex-wrap:wrap}
.act{flex:1;min-width:80px;padding:8px 10px;border-radius:7px;font-size:11px;font-weight:600;cursor:pointer;transition:all .15s;font-family:'Inter',sans-serif;display:flex;align-items:center;justify-content:center;gap:4px;border:none;text-decoration:none}
.a-call{background:rgba(16,185,129,.1);color:#10B981;border:1px solid rgba(16,185,129,.2)!important}
.a-call:hover{background:rgba(16,185,129,.18)}
.a-email{background:rgba(99,102,241,.1);color:#818CF8;border:1px solid rgba(99,102,241,.2)!important}
.a-email:hover{background:rgba(99,102,241,.18)}
.a-web{background:rgba(255,255,255,.04);color:rgba(255,255,255,.4);border:1px solid rgba(255,255,255,.08)!important}
.a-web:hover{background:rgba(255,255,255,.07);color:rgba(255,255,255,.7)}

/* SIGNALS */
.sigs{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.sig{font-family:'JetBrains Mono',monospace;font-size:9px;padding:2px 6px;border-radius:3px;background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.14);color:rgba(129,140,248,.65)}

/* SIDEBAR */
.sidebar{padding-top:28px}
.sb{background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.06);border-radius:12px;margin-bottom:14px;overflow:hidden}
.sb-h{padding:12px 16px;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.3);border-bottom:1px solid rgba(255,255,255,.05)}
.sb-row{padding:11px 16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,.04)}
.sb-row:last-child{border-bottom:none}
.sb-l{font-size:12px;color:rgba(255,255,255,.4)}
.sb-v{font-size:14px;font-weight:700}
.sb-ev{padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.04);cursor:pointer;transition:background .15s}
.sb-ev:last-child{border-bottom:none}
.sb-ev:hover{background:rgba(255,255,255,.03)}
.sb-et{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.1em;text-transform:uppercase;margin-bottom:3px}
.sb-eh{font-size:12px;font-weight:600;color:rgba(255,255,255,.6);line-height:1.4;margin-bottom:3px}
.sb-em{font-family:'JetBrains Mono',monospace;font-size:9px;color:rgba(255,255,255,.2)}

/* EXPOSURE */
.exp-level{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:5px;font-size:11px;font-weight:600;border:1px solid;font-family:'Inter',sans-serif}
.exp-vh{color:#10B981;background:rgba(16,185,129,.1);border-color:rgba(16,185,129,.3)}
.exp-h{color:#F59E0B;background:rgba(245,158,11,.1);border-color:rgba(245,158,11,.3)}
.exp-m{color:#6366F1;background:rgba(99,102,241,.1);border-color:rgba(99,102,241,.3)}
.exp-l{color:#475569;background:rgba(71,85,105,.1);border-color:rgba(71,85,105,.3)}
.thesis-box{padding:10px 14px;background:rgba(16,185,129,.03);border:1px solid rgba(16,185,129,.08);border-left:3px solid rgba(16,185,129,.4);border-radius:0 8px 8px 0;margin-bottom:12px}
.thesis-label{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#10B981;margin-bottom:4px}
.thesis-text{font-size:12px;line-height:1.65;color:rgba(255,255,255,.6)}
.why-box{padding:8px 12px;background:rgba(245,158,11,.04);border:1px solid rgba(245,158,11,.1);border-radius:7px;margin-bottom:10px}
.why-label{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:#F59E0B;margin-bottom:3px}
.why-text{font-size:12px;line-height:1.6;color:rgba(255,255,255,.5)}

/* EMPTY */
.empty{text-align:center;padding:64px 24px;color:rgba(255,255,255,.2)}
.empty-i{font-size:36px;margin-bottom:12px}
.empty-t{font-size:15px;font-weight:600;color:rgba(255,255,255,.3);margin-bottom:6px}
.empty-s{font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.8;color:rgba(255,255,255,.15)}
.empty-s code{color:rgba(16,185,129,.5)}
`;

// ─── COPY BUTTON ─────────────────────────────────────────────────
function CopyBtn({ text }) {
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

// ─── OUTREACH PANEL ──────────────────────────────────────────────
function OutreachPanel({ outreach }) {
  const [tab, setTab] = useState("li_connect");
  if (!outreach) return null;

  const tabs = [
    { id:"li_connect", label:"LI Connect",    text: outreach.linkedin_connection },
    { id:"li_follow",  label:"LI Follow-up",  text: outreach.linkedin_follow_up  },
    { id:"call",       label:"Call opener",   text: outreach.call_opener         },
    { id:"email",      label:"Email",         text: outreach.email_body, subject: outreach.email_subject },
  ];

  const current = tabs.find(t=>t.id===tab);

  return (
    <div className="outreach">
      <div className="xl" style={{marginBottom:8}}>Outreach drafts — copy and send manually</div>
      <div className="out-tabs">
        {tabs.map(t=>(
          <button key={t.id} className={`out-tab${tab===t.id?" active":""}`} onClick={()=>setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      <div className="out-content">
        {current?.subject && <div className="out-subject">Subject: {current.subject}</div>}
        <div className="out-text">{current?.text || "—"}</div>
        <CopyBtn text={current?.text || ""} />
      </div>
    </div>
  );
}

// ─── COMPANY CARD ────────────────────────────────────────────────
function CompanyCard({ lead }) {
  const [open, setOpen] = useState(false);
  const color = pri(lead.priority);
  const initials = (lead.director_name||"").split(" ").slice(0,2).map(w=>w[0]||"").join("").toUpperCase()||"?";
  const li = lead.linkedin_assist;

  return (
    <div className="cc" style={{"--pc":color}}>
      <div className="cc-top" onClick={()=>setOpen(o=>!o)}>
        <div>
          <div className="cc-name">{lead.company_name}</div>
          <div className="cc-meta">
            {[lead.company_type?.toUpperCase(), lead.company_number&&`CH ${lead.company_number}`, lead.incorporated&&`Est. ${lead.incorporated.slice(0,4)}`].filter(Boolean).join(" · ")}
          </div>
          <div className="cc-badges">
            <span className="b b-p">● {lead.priority}</span>
            {lead.exposure_level && <span className={`exp-level ${expClass(lead.exposure_level)}`}>{expLabel(lead.exposure_level)}</span>}
            {lead.exposure_type && <span className="b b-sec" style={{color:"rgba(255,255,255,.4)"}}>{lead.exposure_type.slice(0,40)}</span>}
            {lead.fx_exposure && <span className="b b-fx">{lead.fx_exposure}</span>}
          </div>
          <div className="cc-info">
            {lead.address && <span>📍 {lead.address.split(",").slice(-2).join(",").trim()}</span>}
            {lead.company_status && <span style={{color:lead.company_status==="active"?"#10B981":"#F59E0B"}}>● {lead.company_status}</span>}
          </div>
          {lead.director_name && (
            <div className="cc-dir" style={{marginBottom:8}}>
              <span style={{fontSize:11,color:"rgba(255,255,255,.2)"}}>👤</span>
              <b>{lead.director_name}</b>
              <span style={{color:"rgba(255,255,255,.25)"}}>· {lead.director_role}</span>
            </div>
          )}
          {(lead.exposure_thesis || lead.fx_reason) && (
            <div className="cc-angle">
              {(lead.exposure_thesis || lead.fx_reason).slice(0,150)}
              {(lead.exposure_thesis || lead.fx_reason).length > 150 ? "…" : ""}
            </div>
          )}
        </div>
        <div className="cc-score">
          <div className="cc-sn">{lead.score}</div>
          <div className="cc-sl">Score</div>
          <div className="cc-chev">{open?"▲":"▼"}</div>
        </div>
      </div>

      {open && (
        <div className="cc-exp">
          <div className="cc-exp-grid">
            {lead.director_name && (
              <div>
                <div className="xl">Decision maker</div>
                <div className="dir-card">
                  <div className="dir-av">{initials}</div>
                  <div>
                    <div className="dir-nm">{lead.director_name}</div>
                    <div className="dir-rl">{lead.director_role}</div>
                  </div>
                </div>
              </div>
            )}
            <div>
              <div className="xl">Why they pay FX</div>
              <div className="xv">{lead.fx_payment_logic || lead.fx_reason || "—"}</div>
            </div>
            {(lead.fx_payment_signals||lead.import_export_signals||[]).length > 0 && (
              <div>
                <div className="xl">Website signals</div>
                <div className="sigs">
                  {(lead.fx_payment_signals||lead.import_export_signals||[]).slice(0,8).map(s=>(
                    <span key={s} className="sig">{s}</span>
                  ))}
                </div>
              </div>
            )}
            {(lead.scoring_reasons||[]).length > 0 && (
              <div>
                <div className="xl">Scoring rationale</div>
                <div className="xv" style={{fontSize:11,lineHeight:1.7}}>
                  {lead.scoring_reasons.slice(0,3).map((r,i)=><div key={i}>· {r}</div>)}
                </div>
              </div>
            )}
          </div>

          {li && (
            <div className="li-section">
              <div className="xl" style={{marginBottom:8}}>LinkedIn — open manually, do not automate</div>
              <a href={li.company_search} target="_blank" rel="noreferrer" className="li-company-btn">
                💼 Open Company on LinkedIn →
              </a>
              <div className="li-people">
                {(li.people_searches||[]).slice(0,5).map(p=>(
                  <a key={p.role} href={p.url} target="_blank" rel="noreferrer" className="li-person-btn">
                    {p.role} →
                  </a>
                ))}
              </div>
            </div>
          )}

          <OutreachPanel outreach={lead.outreach} />

          <div className="actions">
            <button className="act a-call">📞 Call</button>
            <button className="act a-email" onClick={()=>lead.outreach?.email_body&&copy(lead.outreach.email_body)}>✉ Copy Email</button>
            {lead.website && <a href={lead.website} target="_blank" rel="noreferrer" className="act a-web">🌐 Website</a>}
            {lead.company_number && (
              <a href={`https://find-and-update.company-information.service.gov.uk/company/${lead.company_number}`} target="_blank" rel="noreferrer" className="act a-web">🏛 CH</a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── FILTER BAR ──────────────────────────────────────────────────
function FilterBar({ filters, setFilters, leads, events, filteredCount }) {
  const priorities = useMemo(()=>[...new Set(leads.map(l=>l.priority))].sort(),[leads]);
  const exposureLevels = useMemo(()=>[...new Set(leads.map(l=>l.exposure_level).filter(Boolean))],[leads]);

  function toggleHotView() {
    setFilters(f => f.hotView ? {...DEFAULT_FILTERS, hotView:false} : HOT_VIEW_FILTERS);
  }

  function togglePriority(p) {
    setFilters(f => {
      const next = f.priorities.includes(p)
        ? f.priorities.filter(x=>x!==p)
        : [...f.priorities, p];
      return {...f, hotView:false, priorities:next};
    });
  }

  function toggleBool(key) {
    setFilters(f => ({...f, hotView:false, [key]:!f[key]}));
  }

  function setSelect(key, val) {
    setFilters(f => ({...f, hotView:false, [key]:val}));
  }

  const isActive = f => !f.hotView && (
    f.priorities.length || f.hasDirector || f.hasWebsite ||
    f.minScore > 0 || f.eventId !== "all" || f.exposureLevel !== "all" || f.newOnly
  );

  const priChipClass = p => {
    const on = filters.priorities.includes(p);
    if (!on) return "chip";
    if (p==="HOT") return "chip hot-on";
    if (p==="WARM") return "chip warm-on";
    if (p==="QUEUE") return "chip queue-on";
    return "chip on";
  };

  return (
    <div className="fb">
      {/* HOT view toggle */}
      <div className="fb-group">
        <button
          className={`chip hv${filters.hotView?" on":""}`}
          onClick={toggleHotView}
          title="Show HOT priority leads only"
        >
          ⚡ HOT view
        </button>
      </div>

      <div className="fb-sep"/>

      {/* Priority */}
      <div className="fb-group">
        <span className="fb-label">Priority</span>
        {priorities.map(p=>(
          <button key={p} className={priChipClass(p)} onClick={()=>togglePriority(p)}>{p}</button>
        ))}
      </div>

      <div className="fb-sep"/>

      {/* Toggle chips */}
      <div className="fb-group">
        <button className={`chip${filters.hasDirector?" on":""}`} onClick={()=>toggleBool("hasDirector")}>Has director</button>
        <button className={`chip${filters.hasWebsite?" on":""}`} onClick={()=>toggleBool("hasWebsite")}>Has website</button>
        <button className={`chip${filters.newOnly?" on":""}`} onClick={()=>toggleBool("newOnly")}>New (24h)</button>
      </div>

      <div className="fb-sep"/>

      {/* Dropdowns */}
      <div className="fb-group">
        <select
          className="fb-select"
          value={filters.eventId}
          onChange={e=>setSelect("eventId", e.target.value)}
        >
          <option value="all">All events</option>
          {events.map(ev=>(
            <option key={ev.id} value={ev.id}>{ev.headline.slice(0,45)}…</option>
          ))}
        </select>
      </div>

      {exposureLevels.length > 1 && (
        <div className="fb-group">
          <select
            className="fb-select"
            value={filters.exposureLevel}
            onChange={e=>setSelect("exposureLevel", e.target.value)}
          >
            <option value="all">All exposure</option>
            {exposureLevels.map(l=><option key={l} value={l}>{l}</option>)}
          </select>
        </div>
      )}

      <div className="fb-group">
        <select
          className="fb-select"
          value={filters.minScore}
          onChange={e=>setSelect("minScore", Number(e.target.value))}
        >
          <option value={0}>Any score</option>
          <option value={60}>Score ≥ 60</option>
          <option value={70}>Score ≥ 70</option>
          <option value={80}>Score ≥ 80</option>
          <option value={90}>Score ≥ 90</option>
        </select>
      </div>

      {/* Count + reset */}
      <span className="fb-count">{filteredCount} showing</span>
      {isActive(filters) && (
        <button className="fb-reset" onClick={()=>setFilters(DEFAULT_FILTERS)}>
          Clear filters
        </button>
      )}
    </div>
  );
}

// ─── EVENT ITEM ──────────────────────────────────────────────────
function EventItem({ event, leads, allLeads, index }) {
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
            <span className="ev-type" style={{color, background:`${color}12`, borderColor:`${color}35`}}>
              {event.event_type||"Event"}
            </span>
            <div className="ev-urg" style={{color}}>
              <div className="ev-track"><div className="ev-fill" style={{width:`${(event.urgency_score||0)*10}%`,background:color}}/></div>
              {event.urgency_score}/10
            </div>
            {event.detected_at && <span className="ev-when">{ago(event.detected_at)}</span>}
          </div>
          <div className="ev-headline">{event.headline}</div>
          <div className="ev-summary">{event.summary?.slice(0,150)}{(event.summary?.length||0)>150?"…":""}</div>
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
          <div className="ev-detail-row">
            {event.summary && (
              <div style={{gridColumn:"1/-1"}}>
                <div className="ev-dl">What happened</div>
                <div className="ev-dv">{event.summary}</div>
              </div>
            )}
            {event.sales_angle && (
              <div>
                <div className="ev-dl">Sales angle today</div>
                <div className="ev-dv" style={{fontStyle:"italic",color:"rgba(255,255,255,.4)"}}>"{event.sales_angle}"</div>
              </div>
            )}
            {(event.who_is_hurt||[]).length > 0 && (
              <div>
                <div className="ev-dl">Who is hurt</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:4}}>
                  {(event.who_is_hurt||[]).slice(0,4).map(h=>(
                    <span key={h} style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,padding:"2px 7px",borderRadius:4,background:"rgba(239,68,68,.06)",border:"1px solid rgba(239,68,68,.14)",color:"rgba(252,165,165,.65)"}}>▼ {h}</span>
                  ))}
                </div>
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
                <div className="niche-label">{niches.length} types of business affected</div>
                <div className="niche-hint">Click any to find companies</div>
              </div>
              <div className="niches">
                {niches.map((n,i)=>{
                  const nStr = typeof n === "object" ? (n.segment_name||"") : (n||"");
                  const nExp = typeof n === "object" ? n.exposure_level : null;
                  const nl = eventLeads.filter(l=>(l.sector||"").toLowerCase().includes(nStr.toLowerCase().slice(0,12))||nStr.toLowerCase().includes((l.sector||"").toLowerCase().slice(0,12)));
                  return (
                    <div key={i} className="niche-row" onClick={e=>{e.stopPropagation();setShow(true)}}>
                      <div className="niche-left">
                        <span className="niche-idx">{String(i+1).padStart(2,"0")}</span>
                        <span className="niche-name">{nStr}</span>
                      </div>
                      <div className="niche-right">
                        {nExp && (
                          <span className={`exp-level ${expClass(nExp)}`} style={{fontSize:9,padding:"1px 6px"}}>{nExp}</span>
                        )}
                        {nl.length>0 && <span className="niche-badge">{nl.length} found</span>}
                        <span className="niche-arr">→</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              {eventLeads.length > 0 && (
                <button className="show-companies-btn" onClick={e=>{e.stopPropagation();setShow(true)}}>
                  View {eventLeads.length}{isFiltered?` filtered`:""} companies →
                </button>
              )}
              {allEventLeads.length === 0 && (
                <div style={{padding:"16px 0",textAlign:"center",fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:"rgba(255,255,255,.2)"}}>
                  No companies found yet · run <code style={{color:"rgba(16,185,129,.5)"}}>discover.py</code>
                </div>
              )}
              {allEventLeads.length > 0 && eventLeads.length === 0 && (
                <div style={{padding:"16px 0",textAlign:"center",fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:"rgba(255,255,255,.2)"}}>
                  {allEventLeads.length} companies hidden by filters
                </div>
              )}
            </>
          )}

          {showCompanies && (
            <div className="co-drawer" onClick={e=>e.stopPropagation()}>
              <div className="co-drawer-hdr">
                <div className="co-drawer-title">
                  {eventLeads.length} companies · sorted by score
                </div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  {isFiltered && (
                    <span className="co-filtered-note">{allEventLeads.length - eventLeads.length} hidden by filters</span>
                  )}
                  <button className="co-back" onClick={e=>{e.stopPropagation();setShow(false)}}>← Back to niches</button>
                </div>
              </div>
              {eventLeads.length > 0
                ? <div className="co-list">{eventLeads.map(l=><CompanyCard key={l.id} lead={l}/>)}</div>
                : <div style={{padding:"20px 0",textAlign:"center",fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:"rgba(255,255,255,.2)"}}>All companies hidden by active filters</div>
              }
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── ROOT APP ────────────────────────────────────────────────────
export default function App() {
  const [events,      setEvents]  = useState([]);
  const [leads,       setLeads]   = useState([]);
  const [loading,     setLoading] = useState(true);
  const [lastRefresh, setLast]    = useState(null);
  const [filters,     setFilters] = useState(HOT_VIEW_FILTERS);

  const load = useCallback(async()=>{
    setLoading(true);
    try {
      const d = await fetchData();
      setEvents(d.events); setLeads(d.leads);
      setLast(new Date());
    } catch(e){console.error(e);}
    finally{setLoading(false);}
  },[]);

  useEffect(()=>{ load(); },[load]);

  const filteredLeads = useMemo(()=>applyFilters(leads, filters),[leads, filters]);

  const hot      = leads.filter(l=>l.priority==="HOT").length;
  const warm     = leads.filter(l=>l.priority==="WARM").length;
  const fHot     = filteredLeads.filter(l=>l.priority==="HOT").length;
  const fVisible = filteredLeads.length;

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
          <div className="live"><div className="live-dot"/>LIVE</div>
          {lastRefresh && <span className="tb-time">{ago(lastRefresh)}</span>}
          <button className="btn-sm" onClick={load} disabled={loading}>{loading?"…":"↻ Refresh"}</button>
        </div>
      </div>

      {/* HERO */}
      <div className="hero">
        <div className="hero-eyebrow"><span>●</span> Live market intelligence · {dateShort}</div>
        <h1 className="hero-h1">What happened today —<br/><em>and who you should call</em></h1>
        <p className="hero-sub">
          Every market event mapped to the specific UK businesses writing cheques in foreign currency.
          Click any event for the full picture — niches, companies, decision makers, and a ready-to-send message.
        </p>
        <div className="hero-ctas">
          <button className="cta-p" onClick={load}>⚡ Refresh Intelligence</button>
          <button className="cta-s" onClick={()=>document.querySelector(".feed")?.scrollIntoView({behavior:"smooth"})}>
            ↓ {events.length > 0 ? `${events.length} events today` : "View events"}
          </button>
        </div>
      </div>

      {/* STATS */}
      <div className="stats">
        {[
          {n:events.length, l:"Events",         s:"Detected",                     c:"#10B981"},
          {n:hot,           l:"HOT leads",       s:"Scored + verified",            c:"#10B981"},
          {n:warm,          l:"Warm leads",      s:"Score 60+",                    c:"#F59E0B"},
          {n:leads.length,  l:"Total pipeline",  s:"All events",                   c:"#6366F1"},
          {n:fVisible,      l:"Showing",         s:filters.hotView?"HOT view":"Filtered", c: filters.hotView?"#10B981":"#F59E0B"},
        ].map(({n,l,s,c})=>(
          <div className="stat" key={l}>
            <div className="stat-n" style={{color:c}}>{n}</div>
            <div><span className="stat-l">{l}</span><span className="stat-s">{s}</span></div>
          </div>
        ))}
      </div>

      {/* FILTER BAR */}
      <FilterBar
        filters={filters}
        setFilters={setFilters}
        leads={leads}
        events={events}
        filteredCount={fVisible}
      />

      {/* HOT VIEW BANNER */}
      {filters.hotView && (
        <div className="hv-bar">
          <span className="hv-tag">⚡ HOT view active</span>
          <span className="hv-desc">Showing HOT priority leads only — {fHot} companies ready to call</span>
          <button className="hv-clear" onClick={()=>setFilters(DEFAULT_FILTERS)}>Show all leads</button>
        </div>
      )}

      {/* MAIN LAYOUT */}
      <div className="layout">
        <div>
          <div className="feed-hdr">
            <div className="feed-title">Today's market events</div>
            <div className="feed-date">{today}</div>
          </div>

          {events.length === 0 ? (
            <div className="empty">
              <div className="empty-i">📡</div>
              <div className="empty-t">No events yet</div>
              <div className="empty-s">Run <code>python3 scripts/ingest.py</code> to pull today's market events<br/>then <code>python3 scripts/discover.py</code> to find affected companies</div>
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
                />
              ))}
            </div>
          )}
        </div>

        {/* SIDEBAR */}
        <div className="sidebar">
          <div className="sb">
            <div className="sb-h">Pipeline summary</div>
            {[
              {l:"HOT leads",        v:hot,           c:"#10B981"},
              {l:"Showing now",      v:fVisible,      c: filters.hotView?"#10B981":"#F59E0B"},
              {l:"Total pipeline",   v:leads.length,  c:"#6366F1"},
              {l:"Events tracked",   v:events.length, c:"#10B981"},
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
                <div key={ev.id} className="sb-ev" onClick={()=>{
                  document.getElementById(ev.id)?.scrollIntoView({behavior:"smooth"});
                }}>
                  <div className="sb-et" style={{color:urg(ev.urgency_score||0)}}>{ev.event_type} · {ev.urgency_score}/10</div>
                  <div className="sb-eh">{ev.headline.slice(0,58)}{ev.headline.length>58?"…":""}</div>
                  <div className="sb-em">{(ev.currency_pairs||[]).join(" · ")} · {ago(ev.detected_at)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
