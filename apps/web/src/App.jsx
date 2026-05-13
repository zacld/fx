import { useEffect, useState, useCallback, useMemo, useRef } from "react";

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
  if (!iso) return "";
  const s = Math.floor((Date.now()-new Date(iso))/1000);
  if (s<60) return`${s}s ago`; if (s<3600) return`${Math.floor(s/60)}m ago`;
  if (s<86400) return`${Math.floor(s/3600)}h ago`; return`${Math.floor(s/86400)}d ago`;
};

const urg  = s => s>=8?"#10B981":s>=6?"#F59E0B":s>=4?"#6366F1":"#475569";
const pri  = p => p==="HOT"?"#10B981":p==="WARM"?"#F59E0B":"#6366F1";
const expClass = l => l==="Very High"?"exp-vh":l==="High"?"exp-h":l==="Medium"?"exp-m":"exp-l";
const expLabel = l => l==="Very High"?"● Very High":l==="High"?"● High":l==="Medium"?"○ Medium":"○ Low";
// Route grade helpers
const GRADE_COLOR = {A:"#10B981",B:"#34D399",C:"#F59E0B",D:"#94A3B8",E:"#64748B",F:"#475569"};
const GRADE_BG    = {A:"rgba(16,185,129,.12)",B:"rgba(52,211,153,.08)",C:"rgba(245,158,11,.1)",D:"rgba(148,163,184,.07)",E:"rgba(100,116,139,.06)",F:"rgba(71,85,105,.06)"};
const GRADE_TIP   = {A:"Named FD/CFO/MD + verified contact",B:"Named FD/CFO/MD + guessed email/contact page",C:"Named director + phone or email",D:"Company phone/email, no named person",E:"Website only",F:"No contact route found"};
const gradeColor  = g => GRADE_COLOR[g] || "#475569";
const gradeBg     = g => GRADE_BG[g]    || "rgba(71,85,105,.06)";
// Call readiness helpers
const CR_COLOR = {READY:"#10B981",REVIEW:"#F59E0B",HOLD:"#64748B"};
const CR_BG    = {READY:"rgba(16,185,129,.12)",REVIEW:"rgba(245,158,11,.1)",HOLD:"rgba(100,116,139,.07)"};
const CR_ORDER = {READY:0,REVIEW:1,HOLD:2,undefined:3};
const crColor  = r => CR_COLOR[r] || "#64748B";
const crBg     = r => CR_BG[r]    || "rgba(100,116,139,.07)";
const gradeTip    = g => GRADE_TIP[g]   || "";
const TIER_COLOR  = {1:"#10B981",2:"#F59E0B",3:"#64748B"};
const tierColor   = t => TIER_COLOR[t]  || "#64748B";
// FX likelihood score helpers
const fxLikColor  = s => s>=70?"#10B981":s>=45?"#F59E0B":s>=25?"#818CF8":"#475569";
const fxLikLabel  = s => s>=70?"Strong FX evidence":s>=45?"Moderate FX evidence":s>=25?"Some FX evidence":"Weak evidence";
const today    = new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"});
const dateShort= new Date().toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"});

function copy(text) { navigator.clipboard.writeText(text).catch(()=>{}); }

// ─── CRM ───────────────────────────────────────────────────────────
const CRM_KEY      = "fx_crm_state";
const CRM_STATUSES = ["new","reviewed","saved","contacted","follow_up","meeting_booked","passed_to_closer","not_relevant"];
const CRM_LABELS   = {
  new:             "New",
  reviewed:        "Reviewed",
  saved:           "Saved",
  contacted:       "Contacted",
  follow_up:       "Follow up",
  meeting_booked:  "Meeting booked",
  passed_to_closer:"Passed to closer",
  not_relevant:    "Not relevant",
};
const CRM_COLORS   = {
  new:             "#6366F1",
  reviewed:        "#F59E0B",
  saved:           "#10B981",
  contacted:       "#38BDF8",
  follow_up:       "#F97316",
  meeting_booked:  "#10B981",
  passed_to_closer:"#A855F7",
  not_relevant:    "#475569",
};

function isoDaysFromNow(days) {
  const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString();
}

function scheduleNextFollowUp(touchCount, action) {
  // touchCount is after increment
  if (action === "replied") return null;
  if (action === "meeting_booked") return null;
  if (action === "not_relevant") return null;
  if (touchCount <= 1) return isoDaysFromNow(2);
  if (touchCount === 2) return isoDaysFromNow(4);
  if (touchCount === 3) return isoDaysFromNow(7);
  return null; // move to nurture
}

function computeRouteGrade(lead) {
  // Derive a simple route grade (A/B/C/D) from available contact signals
  const hasDirector = !!lead.director_name;
  const hasEmailGuess = (lead.guessed_emails||[]).length>0;
  const siteConf = lead.website_confidence||"low";
  const hasPhone = !!lead.phone;
  const fxSigs = (lead.fx_payment_signals||[]).length + (lead.pays_fx_confirmed?1:0);

  // Grade A: director + email or phone + site_conf high + FX signals
  if (hasDirector && (hasEmailGuess || hasPhone) && siteConf === "high" && fxSigs>=1) return "A";
  // Grade B: director + (email|phone) and site_conf >= medium
  if (hasDirector && (hasEmailGuess || hasPhone) && (siteConf === "medium" || siteConf === "high")) return "B";
  // Grade C: director present but weak contact evidence
  if (hasDirector) return "C";
  // Grade D: no director, website only
  if (lead.website) return "D";
  return "E";
}

function useCrmState() {
  const [state, setState] = useState(() => {
    try { return JSON.parse(localStorage.getItem(CRM_KEY)||"{}"); } catch { return {}; }
  });

  const persist = useCallback((next) => {
    try { localStorage.setItem(CRM_KEY, JSON.stringify(next)); } catch {}
  }, []);

  const updateLead = useCallback((leadId, patch) => {
    setState(prev => {
      const cur = prev[leadId] || {};
      const next = {...prev, [leadId]: {...cur, ...patch}};
      persist(next);
      return next;
    });
  }, [persist]);

  const getLead = useCallback((lead) => {
    return {...(state[lead.id]||{}), status: (state[lead.id]&&state[lead.id].status) || lead.status || "new" };
  }, [state]);

  const getStatus = useCallback((lead) => (state[lead.id] && state[lead.id].status) || lead.status || "new", [state]);

  const performAction = useCallback((lead, action) => {
    const id = lead.id;
    setState(prev => {
      const cur = prev[id] || {};
      const touch = (cur.touch_count||0) + (action === "follow_later"?0:1);
      const last_channel = action === "called" ? "phone" : action === "email_sent" ? "email" : action === "linkedin_sent" ? "linkedin" : action === "replied" ? "reply" : action === "meeting_booked" ? "meeting" : cur.last_channel || null;
      const status = action === "not_relevant" ? "not_relevant" : action === "replied" ? "reviewed" : action === "meeting_booked" ? "meeting_booked" : "contacted";
      const next_follow_up_at = scheduleNextFollowUp(touch, action);
      const next = {
        ...prev,
        [id]: {
          ...cur,
          last_contacted_at: action === "follow_later" ? cur.last_contacted_at || null : new Date().toISOString(),
          last_channel,
          touch_count: touch,
          status,
          next_follow_up_at,
        }
      };
      persist(next);
      return next;
    });
  }, [persist]);

  return { state, updateLead, getLead, getStatus, performAction };
}

// ─── FILTER STATE ──────────────────────────────────────────────────
// view: "call_list" | "research" | "all"
const BLANK_FILTERS = {
  view:         "call_list",
  priorities:   [],
  siteConfs:    [],
  hasFxSignals: false,
  hasWebsite:   false,
  hasDirector:  false,
  minScore:     0,
  eventId:      "all",
  currencyPair: "all",
  segment:      "all",
  statuses:     [],
  grades:       [],
  sortBy:       "score",    // "score" | "readiness" | "grade" | "confidence" | "fx_likelihood"
  search:       "",
};

const CALL_LIST_FILTERS = { ...BLANK_FILTERS, view: "call_list", sortBy: "readiness" };
const RESEARCH_FILTERS  = { ...BLANK_FILTERS, view: "research"  };
const ALL_FILTERS       = { ...BLANK_FILTERS, view: "all"       };

function isCallListEligible(l) {
  // Daily Call List: 5-gate check per CLAUDE.md
  // Gate 1: real company (director name as proxy — ensures CH registration found)
  // Gate 2: FX evidence (direct FX signal on website OR pays_fx_confirmed)
  // Gate 3: verified website (confidence high or medium)
  // Gate 4: commercial fit (HOT or WARM score — means scoring passed B2B/segment filters)
  // Gate 5: contact route (director name = CH-verified contact exists)
  const hasWebConf    = ["high","medium","confirmed"].includes(l.website_confidence);
  const hasWebsite    = !!l.website;
  const hasFxEvidence = (l.fx_payment_signals||[]).length > 0 || !!l.pays_fx_confirmed;
  const hotOrWarm     = l.priority==="HOT" || l.priority==="WARM";
  const notExcluded   = !["not_relevant"].includes(l.outreach_status);
  const hasDirector   = !!l.director_name;
  return hotOrWarm && hasWebsite && hasWebConf && hasFxEvidence && hasDirector && notExcluded;
}

const CALL_LIST_MAX = 25;

function applyFilters(leads, filters, getCrmStatus) {
  let r = leads;

  // Primary view filter
  // call_list = top CALL_LIST_MAX eligible leads sorted by score (already sorted from fetchData)
  // research  = everything NOT in the top-25 call list (overflow HOT/WARM + QUEUE)
  if (filters.view === "call_list") {
    r = r.filter(isCallListEligible).slice(0, CALL_LIST_MAX);
  } else if (filters.view === "research") {
    const callListIds = new Set(
      leads.filter(isCallListEligible).slice(0, CALL_LIST_MAX).map(l => l.website_domain || l.company_number)
    );
    r = r.filter(l => !callListIds.has(l.website_domain || l.company_number));
  }

  // Additional filters
  if (filters.priorities.length)    r = r.filter(l => filters.priorities.includes(l.priority));
  if (filters.siteConfs.length)     r = r.filter(l => filters.siteConfs.includes(l.website_confidence));
  if (filters.hasFxSignals)         r = r.filter(l => (l.fx_payment_signals||[]).length > 0);
  if (filters.hasWebsite)           r = r.filter(l => l.website);
  if (filters.hasDirector)          r = r.filter(l => l.director_name);
  if (filters.minScore > 0)         r = r.filter(l => (l.score||0) >= filters.minScore);
  if (filters.eventId !== "all")    r = r.filter(l => l.event_id === filters.eventId);
  if (filters.currencyPair !== "all") r = r.filter(l => (l.fx_exposure||"").includes(filters.currencyPair));
  if (filters.segment !== "all")    r = r.filter(l => (l.segment_name||"")===filters.segment);
  if (filters.statuses.length)      r = r.filter(l => filters.statuses.includes(getCrmStatus(l)));
  if (filters.grades.length)        r = r.filter(l => filters.grades.includes(l.route_grade));
  if (filters.search) {
    const q = filters.search.toLowerCase();
    r = r.filter(l =>
      (l.company_name||"").toLowerCase().includes(q) ||
      (l.director_name||"").toLowerCase().includes(q)
    );
  }
  // Sort
  const GRADE_ORDER = {A:0,B:1,C:2,D:3,E:4,F:5};
  if (filters.sortBy === "readiness") {
    r = [...r].sort((a,b) => {
      const rd = (CR_ORDER[a.call_readiness]??3) - (CR_ORDER[b.call_readiness]??3);
      return rd !== 0 ? rd : (b.score||0) - (a.score||0);
    });
  } else if (filters.sortBy === "grade") {
    r = [...r].sort((a,b) => {
      const gd = (GRADE_ORDER[a.route_grade]??9) - (GRADE_ORDER[b.route_grade]??9);
      return gd !== 0 ? gd : (b.score||0) - (a.score||0);
    });
  } else if (filters.sortBy === "confidence") {
    r = [...r].sort((a,b) => (b.contact_confidence||0) - (a.contact_confidence||0));
  } else if (filters.sortBy === "fx_likelihood") {
    r = [...r].sort((a,b) => (b.fx_likelihood_score||0) - (a.fx_likelihood_score||0));
  }
  // default "score" sort: leads already come in score order from fetchData
  return r;
}

// ─── CSS ──────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:#07090F;color:#E2E8F0;font-family:'Inter',sans-serif;-webkit-font-smoothing:antialiased;font-size:14px;line-height:1.5}
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:rgba(16,185,129,.25);border-radius:2px}

/* TOPBAR */
.tb{position:sticky;top:0;z-index:100;background:rgba(7,9,15,.92);backdrop-filter:blur(20px);border-bottom:1px solid rgba(255,255,255,.05);padding:0 40px;height:52px;display:flex;align-items:center;justify-content:space-between}
.tb-l{display:flex;align-items:center;gap:12px}
.tb-logo{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:#F8FAFC}
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
.hero{padding:48px 40px 40px;border-bottom:1px solid rgba(255,255,255,.05);position:relative;overflow:hidden}
.hero::after{content:'';position:absolute;top:-100px;right:-80px;width:480px;height:480px;border-radius:50%;background:radial-gradient(circle,rgba(16,185,129,.07) 0%,transparent 70%);pointer-events:none}
.hero-eyebrow{display:inline-flex;align-items:center;gap:6px;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#10B981;margin-bottom:16px;padding:4px 10px;border-radius:20px;background:rgba(16,185,129,.07);border:1px solid rgba(16,185,129,.2)}
.hero-h1{font-size:clamp(30px,4vw,48px);font-weight:900;letter-spacing:-.04em;line-height:1.05;color:#F8FAFC;margin-bottom:10px}
.hero-h1 em{font-style:normal;background:linear-gradient(135deg,#10B981,#34D399);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.hero-sub{font-size:14px;line-height:1.7;color:rgba(255,255,255,.35);max-width:540px}
@media(max-width:600px){.hero{padding:32px 16px 28px}}

/* STATS BAR */
.stats{display:flex;gap:0;border-bottom:1px solid rgba(255,255,255,.05);padding:0 40px;overflow-x:auto}
.stat{padding:12px 24px 12px 0;margin-right:24px;border-right:1px solid rgba(255,255,255,.05);display:flex;align-items:center;gap:10px;white-space:nowrap;flex-shrink:0}
.stat:last-child{border-right:none}
.stat-n{font-size:20px;font-weight:800;line-height:1}
.stat-l{font-size:11px;font-weight:500;color:rgba(255,255,255,.3);text-transform:uppercase;letter-spacing:.04em;display:block}
.stat-s{font-family:'JetBrains Mono',monospace;font-size:9px;color:rgba(255,255,255,.15);letter-spacing:.06em;display:block;margin-top:1px}
@media(max-width:600px){.stats{padding:0 16px}}

/* VIEW SWITCHER BANNER */
.view-banner{padding:10px 40px;border-bottom:1px solid rgba(255,255,255,.05);display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.view-tabs{display:flex;gap:3px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:9px;padding:3px}
.view-tab{padding:5px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;background:none;border:none;color:rgba(255,255,255,.3);font-family:'Inter',sans-serif;transition:all .15s;white-space:nowrap}
.view-tab:hover{color:rgba(255,255,255,.6)}
.view-tab.active-cl{background:rgba(16,185,129,.15);color:#10B981}
.view-tab.active-rq{background:rgba(245,158,11,.12);color:#F59E0B}
.view-tab.active-all{background:rgba(255,255,255,.06);color:rgba(255,255,255,.7)}
.view-desc{font-size:12px;color:rgba(255,255,255,.25);flex:1}
.view-count{font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;padding:4px 12px;border-radius:6px;white-space:nowrap}
.view-count-cl{background:rgba(16,185,129,.1);color:#10B981;border:1px solid rgba(16,185,129,.2)}
.view-count-rq{background:rgba(245,158,11,.08);color:#F59E0B;border:1px solid rgba(245,158,11,.2)}
.view-count-all{background:rgba(255,255,255,.04);color:rgba(255,255,255,.4);border:1px solid rgba(255,255,255,.08)}
@media(max-width:600px){.view-banner{padding:10px 16px}}

/* FILTER BAR */
.fb{padding:10px 40px;border-bottom:1px solid rgba(255,255,255,.05);display:flex;align-items:center;gap:7px;flex-wrap:wrap;background:rgba(255,255,255,.012)}
.fb-group{display:flex;align-items:center;gap:4px}
.fb-label{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.18);white-space:nowrap;margin-right:2px}
.fb-sep{width:1px;height:18px;background:rgba(255,255,255,.07);flex-shrink:0}
.chip{padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;cursor:pointer;border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.03);color:rgba(255,255,255,.3);transition:all .15s;font-family:'Inter',sans-serif;white-space:nowrap;user-select:none}
.chip:hover{border-color:rgba(255,255,255,.18);color:rgba(255,255,255,.6)}
.chip.on{background:rgba(16,185,129,.12);border-color:rgba(16,185,129,.35);color:#10B981}
.chip.hot-on{background:rgba(16,185,129,.12);border-color:rgba(16,185,129,.35);color:#10B981}
.chip.warm-on{background:rgba(245,158,11,.1);border-color:rgba(245,158,11,.35);color:#F59E0B}
.chip.queue-on{background:rgba(99,102,241,.1);border-color:rgba(99,102,241,.35);color:#818CF8}
.chip.hi-on{background:rgba(16,185,129,.12);border-color:rgba(16,185,129,.35);color:#10B981}
.chip.med-on{background:rgba(245,158,11,.1);border-color:rgba(245,158,11,.35);color:#F59E0B}
.chip.low-on{background:rgba(71,85,105,.12);border-color:rgba(71,85,105,.35);color:#94A3B8}
.fb-select{padding:3px 7px;border-radius:7px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);color:rgba(255,255,255,.35);font-family:'Inter',sans-serif;font-size:11px;cursor:pointer;outline:none;transition:all .15s}
.fb-select:focus,.fb-select:hover{border-color:rgba(16,185,129,.25);color:rgba(255,255,255,.6)}
.fb-select option{background:#111}
.fb-search{padding:3px 10px;border-radius:7px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);color:rgba(255,255,255,.6);font-family:'Inter',sans-serif;font-size:11px;outline:none;transition:all .15s;width:160px}
.fb-search:focus{border-color:rgba(16,185,129,.25);background:rgba(255,255,255,.06)}
.fb-search::placeholder{color:rgba(255,255,255,.2)}
.fb-count{font-family:'JetBrains Mono',monospace;font-size:10px;color:rgba(16,185,129,.8);background:rgba(16,185,129,.07);padding:3px 9px;border-radius:4px;border:1px solid rgba(16,185,129,.15);margin-left:auto;white-space:nowrap}
.fb-reset{padding:3px 9px;border-radius:7px;background:none;border:1px solid rgba(255,255,255,.07);color:rgba(255,255,255,.2);font-size:11px;cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s;white-space:nowrap}
.fb-reset:hover{border-color:rgba(255,255,255,.18);color:rgba(255,255,255,.5)}
@media(max-width:600px){.fb{padding:8px 16px}.fb-sep{display:none}.fb-search{width:120px}}

/* LAYOUT */
.layout{max-width:1500px;margin:0 auto;padding:0 40px 80px;display:grid;grid-template-columns:1fr 320px;gap:40px;align-items:start}
@media(max-width:1080px){.layout{grid-template-columns:1fr}}
@media(max-width:600px){.layout{padding:0 16px 60px;gap:20px}}

/* FEED */
.feed-hdr{display:flex;align-items:center;justify-content:space-between;padding:28px 0 14px;gap:12px}
.feed-title{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.3)}
.feed-date{font-family:'JetBrains Mono',monospace;font-size:10px;color:rgba(255,255,255,.15)}
.feed{display:flex;flex-direction:column}

/* EVENT ROW */
.ev{border-bottom:1px solid rgba(255,255,255,.05)}
.ev:last-child{border-bottom:none}
.ev-row{padding:22px 0;cursor:pointer;display:grid;grid-template-columns:28px 1fr auto;gap:16px;align-items:start}
.ev-num{font-family:'JetBrains Mono',monospace;font-size:11px;color:rgba(255,255,255,.15);padding-top:4px}
.ev-tags{display:flex;align-items:center;gap:8px;margin-bottom:9px;flex-wrap:wrap}
.ev-type{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.1em;text-transform:uppercase;padding:3px 8px;border-radius:5px;border:1px solid;white-space:nowrap}
.ev-urg{display:flex;align-items:center;gap:5px;font-family:'JetBrains Mono',monospace;font-size:10px}
.ev-track{width:36px;height:2px;background:rgba(255,255,255,.08);border-radius:1px;overflow:hidden}
.ev-fill{height:100%;border-radius:1px}
.ev-when{font-family:'JetBrains Mono',monospace;font-size:9px;color:rgba(255,255,255,.15)}
.ev-headline{font-size:18px;font-weight:800;line-height:1.35;color:#F8FAFC;letter-spacing:-.025em;margin-bottom:7px}
.ev-summary{font-size:13px;line-height:1.65;color:rgba(255,255,255,.4)}
.ev-meta{display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap}
.ev-pairs{display:flex;gap:4px}
.ev-pair{font-family:'JetBrains Mono',monospace;font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.2);color:#10B981}
.ev-lcount{font-family:'JetBrains Mono',monospace;font-size:10px;color:rgba(255,255,255,.2)}
.ev-right{display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex-shrink:0;min-width:80px}
.ev-hint{font-size:11px;color:rgba(255,255,255,.18);transition:color .15s}
.ev:hover .ev-hint{color:#10B981}
.ev-open-btn{display:inline-flex;align-items:center;gap:5px;padding:6px 12px;border-radius:7px;background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.2);color:#10B981;font-size:12px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s;white-space:nowrap}
.ev-open-btn:hover{background:rgba(16,185,129,.15)}

/* EVENT EXPANDED */
.ev-expanded{padding:0 0 24px 44px;animation:fi .2s ease}
@keyframes fi{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}
.ev-detail-row{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px}
@media(max-width:640px){.ev-detail-row{grid-template-columns:1fr}}
.ev-dl{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.2);margin-bottom:5px}
.ev-dv{font-size:13px;line-height:1.65;color:rgba(255,255,255,.5)}
.ev-fx-box{background:rgba(16,185,129,.04);border:1px solid rgba(16,185,129,.1);border-left:3px solid rgba(16,185,129,.4);border-radius:0 9px 9px 0;padding:12px 16px;margin-bottom:18px}
.ev-fx-label{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#10B981;margin-bottom:5px}
.ev-fx-text{font-size:13px;line-height:1.65;color:rgba(255,255,255,.6);font-weight:500}
.niche-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.niche-label{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.2)}
.niche-hint{font-size:11px;color:rgba(255,255,255,.2)}
.niche-funnel-stats{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.nf-stat{font-size:11px;color:rgba(255,255,255,.35)}
.nf-stat strong{color:rgba(255,255,255,.65);font-weight:600}
.nf-sep{font-size:11px;color:rgba(255,255,255,.15)}
.niches{display:flex;flex-direction:column;gap:4px;margin-bottom:18px}
.niche-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 14px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.05);border-radius:8px;cursor:pointer;transition:all .15s}
.niche-row:hover{background:rgba(255,255,255,.04);border-color:rgba(16,185,129,.2)}
.niche-left{display:flex;align-items:center;gap:10px}
.niche-idx{font-family:'JetBrains Mono',monospace;font-size:10px;color:rgba(255,255,255,.15);width:20px;flex-shrink:0}
.niche-name{font-size:13px;font-weight:500;color:rgba(255,255,255,.7)}
.niche-right{display:flex;align-items:center;gap:8px}
.niche-badge{font-family:'JetBrains Mono',monospace;font-size:9px;padding:2px 7px;border-radius:4px;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.2);color:#10B981}
.niche-arr{font-size:11px;color:rgba(255,255,255,.2);transition:color .15s}
.niche-row:hover .niche-arr{color:#10B981}
.show-companies-btn{width:100%;padding:9px;border-radius:8px;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.25);color:#10B981;font-size:13px;font-weight:700;cursor:pointer;transition:all .15s;font-family:'Inter',sans-serif;display:flex;align-items:center;justify-content:center;gap:6px}
.show-companies-btn:hover{background:rgba(16,185,129,.18)}

/* COMPANY DRAWER */
.co-drawer{border-top:1px solid rgba(255,255,255,.05);padding:18px 0 4px;animation:fi .2s ease}
.co-drawer-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px}
.co-drawer-title{font-size:12px;font-weight:700;color:rgba(255,255,255,.4);letter-spacing:.04em}
.co-back{font-size:11px;color:rgba(255,255,255,.25);background:none;border:none;cursor:pointer;font-family:'Inter',sans-serif;transition:color .15s}
.co-back:hover{color:#10B981}
.co-list{display:flex;flex-direction:column;gap:8px}
.co-filtered-note{font-family:'JetBrains Mono',monospace;font-size:10px;color:rgba(16,185,129,.5);background:rgba(16,185,129,.05);border:1px solid rgba(16,185,129,.1);padding:4px 10px;border-radius:5px}

/* COMPANY CARD */
.cc{background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.06);border-left:3px solid var(--pc);border-radius:11px;overflow:hidden;transition:border-color .2s,box-shadow .2s}
.cc:hover{border-color:rgba(255,255,255,.1);box-shadow:0 4px 20px rgba(0,0,0,.3)}
.cc-top{padding:14px 16px 14px 13px;cursor:pointer;display:grid;grid-template-columns:1fr auto;gap:12px;align-items:start}
.cc-name{font-size:14px;font-weight:700;color:#F8FAFC;letter-spacing:-.01em;margin-bottom:2px}
.cc-meta{font-family:'JetBrains Mono',monospace;font-size:10px;color:rgba(255,255,255,.2);margin-bottom:7px}
.cc-badges{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;align-items:center}
.b{display:inline-flex;align-items:center;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:600;border:1px solid transparent}
.b-p{color:var(--pc);background:rgba(0,0,0,.2)}
.b-sec{color:rgba(255,255,255,.4);background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.07)}
.b-fx{color:#818CF8;background:rgba(129,140,248,.07);border-color:rgba(129,140,248,.18)}
.b-site-high{color:#10B981;background:rgba(16,185,129,.08);border-color:rgba(16,185,129,.25)}
.b-site-med{color:#F59E0B;background:rgba(245,158,11,.08);border-color:rgba(245,158,11,.25)}
.b-site-low{color:#64748B;background:rgba(100,116,139,.06);border-color:rgba(100,116,139,.2)}
.cc-info{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:rgba(255,255,255,.3);margin-bottom:7px}
.cc-dir{display:inline-flex;align-items:center;gap:5px}
.cc-dir b{color:rgba(255,255,255,.55);font-weight:600}
.cc-angle{font-size:11px;line-height:1.55;color:rgba(255,255,255,.38);padding:6px 10px;background:rgba(16,185,129,.025);border:1px solid rgba(16,185,129,.07);border-radius:6px}
.cc-score{display:flex;flex-direction:column;align-items:center;gap:2px;flex-shrink:0}
.cc-sn{font-size:20px;font-weight:800;line-height:1;color:var(--pc)}
.cc-sl{font-family:'JetBrains Mono',monospace;font-size:8px;letter-spacing:.1em;text-transform:uppercase;color:var(--pc);opacity:.6}
.cc-chev{font-size:10px;color:rgba(255,255,255,.18);margin-top:4px;transition:color .15s}
.cc:hover .cc-chev{color:rgba(255,255,255,.35)}

/* CALL INTELLIGENCE PANEL */
.ci-panel{background:rgba(16,185,129,.025);border:1px solid rgba(16,185,129,.1);border-left:3px solid rgba(16,185,129,.4);border-radius:0 9px 9px 0;padding:12px 16px;margin-bottom:14px}
.ci-header{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.ci-title{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:#10B981;font-weight:700}
.ci-pairs{display:flex;gap:4px;flex-wrap:wrap}
.ci-pair{font-family:'JetBrains Mono',monospace;font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.2);color:#10B981;font-weight:700}
.ci-countries{font-size:11px;color:rgba(255,255,255,.4)}
.ci-fx-score{font-family:'JetBrains Mono',monospace;font-size:10px;padding:2px 8px;border-radius:4px;border:1px solid transparent;font-weight:700}
.ci-snippets{display:flex;flex-direction:column;gap:5px}
.ci-snippet{font-size:12px;line-height:1.6;color:rgba(255,255,255,.6);padding:7px 10px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.06);border-left:2px solid rgba(16,185,129,.3);border-radius:0 6px 6px 0;font-style:italic}
.ci-no-evidence{font-size:11px;color:rgba(255,255,255,.2);font-style:italic}
.ci-size-signals{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px}
.ci-size-tag{font-family:'JetBrains Mono',monospace;font-size:9px;padding:2px 6px;border-radius:3px;background:rgba(99,102,241,.07);border:1px solid rgba(99,102,241,.15);color:rgba(129,140,248,.6)}

/* COMPANY EXPANDED */
.cc-exp{border-top:1px solid rgba(255,255,255,.05);padding:12px 16px 16px 13px;background:rgba(0,0,0,.15);animation:fi .15s ease}
.cc-exp-grid{display:grid;grid-template-columns:1fr 1fr;gap:11px;margin-bottom:12px}
@media(max-width:500px){.cc-exp-grid{grid-template-columns:1fr}}
.xl{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.2);margin-bottom:4px}
.xv{font-size:12px;line-height:1.6;color:rgba(255,255,255,.5)}
.dir-card{display:inline-flex;align-items:center;gap:8px;padding:7px 12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:7px}
.dir-av{width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,rgba(16,185,129,.3),rgba(99,102,241,.3));border:1px solid rgba(16,185,129,.2);display:grid;place-items:center;font-size:10px;font-weight:700;color:#10B981;flex-shrink:0}
.dir-nm{font-size:13px;font-weight:600;color:#F8FAFC}
.dir-rl{font-family:'JetBrains Mono',monospace;font-size:10px;color:#10B981}
.site-detail{font-family:'JetBrains Mono',monospace;font-size:10px;color:rgba(255,255,255,.3);margin-top:3px}

/* OUTREACH */
/* call opener generator */
.opener-panel{margin-bottom:14px;border:1px solid rgba(16,185,129,.18);border-radius:10px;background:rgba(16,185,129,.04);overflow:hidden}
.opener-tabs{display:flex;border-bottom:1px solid rgba(16,185,129,.12)}
.opener-tab{flex:1;padding:7px 0;font-size:11px;font-weight:600;cursor:pointer;background:none;border:none;color:rgba(255,255,255,.3);font-family:'Inter',sans-serif;transition:all .15s;letter-spacing:.02em}
.opener-tab:hover{color:rgba(255,255,255,.6)}
.opener-tab.active{color:#10B981;background:rgba(16,185,129,.07)}
.opener-body{position:relative;padding:12px 14px}
.opener-text{font-size:12px;line-height:1.75;color:rgba(255,255,255,.65);white-space:pre-wrap;word-break:break-word;padding-right:60px}
.opener-label{font-family:'JetBrains Mono',monospace;font-size:9px;color:rgba(16,185,129,.6);letter-spacing:.08em;text-transform:uppercase;margin-bottom:5px}
.opener-char{font-family:'JetBrains Mono',monospace;font-size:9px;color:rgba(255,255,255,.2);margin-top:6px}
.outreach{margin-bottom:12px}
/* legacy out-* classes kept for backward compat */
.out-tabs{display:flex;gap:2px;margin-bottom:0;border-bottom:1px solid rgba(255,255,255,.06)}
.out-tab{padding:5px 11px;font-size:11px;font-weight:500;cursor:pointer;background:none;border:none;color:rgba(255,255,255,.3);font-family:'Inter',sans-serif;border-bottom:2px solid transparent;margin-bottom:-1px;transition:all .15s}
.out-tab:hover{color:rgba(255,255,255,.6)}
.out-tab.active{color:#10B981;border-bottom-color:#10B981}
.out-content{position:relative;margin-top:0}
.out-text{font-size:12px;line-height:1.7;color:rgba(255,255,255,.5);padding:10px 14px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06);border-top:none;border-radius:0 0 8px 8px;white-space:pre-wrap;word-break:break-word;min-height:56px}
.out-subject{font-family:'JetBrains Mono',monospace;font-size:10px;color:#10B981;padding:5px 14px;background:rgba(16,185,129,.05);border:1px solid rgba(16,185,129,.12);border-bottom:none;border-radius:8px 8px 0 0}
/* message ammo panel */
.ammo-grid{display:flex;flex-direction:column;gap:8px}
.ammo-row{position:relative;border:1px solid rgba(255,255,255,.07);border-radius:8px;background:rgba(255,255,255,.02);padding:10px 12px 10px 12px}
.ammo-header{display:flex;align-items:center;gap:6px;margin-bottom:5px}
.ammo-icon{font-size:12px;opacity:.7}
.ammo-label{font-size:10px;font-weight:700;color:rgba(255,255,255,.5);letter-spacing:.05em;text-transform:uppercase;font-family:'JetBrains Mono',monospace}
.ammo-help{font-size:10px;color:rgba(255,255,255,.2);font-family:'JetBrains Mono',monospace;margin-left:auto}
.ammo-text{font-size:12px;line-height:1.65;color:rgba(255,255,255,.55);white-space:pre-wrap;word-break:break-word;padding-right:54px}
/* copy button — inline inside ammo rows */
.copy-btn{position:absolute;top:9px;right:9px;padding:3px 9px;border-radius:5px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.4);font-size:10px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s}
.copy-btn:hover{background:rgba(255,255,255,.1);color:#fff}
.copy-btn.copied{background:rgba(16,185,129,.15);border-color:rgba(16,185,129,.3);color:#10B981}

/* EMAIL PATTERNS */
.email-section{margin-bottom:12px}
.email-patterns{display:flex;flex-direction:column;gap:3px;margin-top:5px}
.email-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 10px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.05);border-radius:6px}
.email-pattern{font-family:'JetBrains Mono',monospace;font-size:9px;color:rgba(255,255,255,.2);width:110px;flex-shrink:0}
.email-addr{font-family:'JetBrains Mono',monospace;font-size:11px;color:rgba(255,255,255,.55);flex:1;word-break:break-all}
.email-copy{padding:2px 7px;border-radius:4px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);color:rgba(255,255,255,.3);font-size:10px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s;white-space:nowrap;flex-shrink:0}
.email-copy:hover{background:rgba(255,255,255,.09);color:rgba(255,255,255,.6)}
.email-copy.copied{background:rgba(16,185,129,.12);border-color:rgba(16,185,129,.25);color:#10B981}
.email-note{font-family:'JetBrains Mono',monospace;font-size:9px;color:rgba(255,255,255,.15);margin-top:4px;line-height:1.5}

/* ROUTE GRADE BADGE */
.grade-badge{display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;border:1px solid transparent;cursor:default}
.size-badge{display:inline-flex;align-items:center;padding:1px 6px;border-radius:3px;font-family:'JetBrains Mono',monospace;font-size:9px;border:1px solid transparent;cursor:default}
/* FINANCIALS PANEL */
.fin-panel{background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:10px 14px;margin-bottom:12px}
.fin-row{display:flex;gap:24px;flex-wrap:wrap;margin-bottom:6px}
.fin-item{display:flex;flex-direction:column;gap:2px}
.fin-label{font-family:'JetBrains Mono',monospace;font-size:9px;color:rgba(255,255,255,.25);text-transform:uppercase;letter-spacing:.04em}
.fin-value{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;color:rgba(255,255,255,.7)}
.fin-date{font-size:10px;color:rgba(255,255,255,.2);margin-top:4px}
.phone-row{display:flex;align-items:center;gap:8px;margin-top:4px;padding:5px 0}
.phone-val{font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:700;color:#10B981;letter-spacing:.03em}
.phone-src{font-family:'JetBrains Mono',monospace;font-size:9px;color:rgba(255,255,255,.25)}
.phone-src-high{color:#10B981}
.conf-bar{display:flex;align-items:center;gap:5px;font-family:'JetBrains Mono',monospace;font-size:9px;color:rgba(255,255,255,.3)}
.conf-track{width:48px;height:3px;background:rgba(255,255,255,.08);border-radius:2px;overflow:hidden}
.conf-fill{height:100%;border-radius:2px;transition:width .3s}

/* DECISION MAKERS PANEL */
.dm-panel{margin-bottom:12px}
.dm-panel-hdr{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.dm-list{display:flex;flex-direction:column;gap:6px}
.dm-card{display:flex;align-items:flex-start;gap:10px;padding:9px 12px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.06);border-radius:8px;position:relative}
.dm-card.tier-1{border-left:2px solid rgba(16,185,129,.35)}
.dm-card.tier-2{border-left:2px solid rgba(245,158,11,.25)}
.dm-av{width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,rgba(16,185,129,.3),rgba(99,102,241,.3));border:1px solid rgba(16,185,129,.2);display:grid;place-items:center;font-size:10px;font-weight:700;color:#10B981;flex-shrink:0;margin-top:1px}
.dm-info{flex:1;min-width:0}
.dm-nm{font-size:13px;font-weight:600;color:#F8FAFC;line-height:1.3;display:flex;align-items:center;gap:6px}
.dm-tier-badge{font-size:9px;padding:1px 5px;border-radius:3px;font-family:'JetBrains Mono',monospace;font-weight:700;flex-shrink:0}
.dm-rl{font-family:'JetBrains Mono',monospace;font-size:9px;margin-bottom:4px}
.dm-email{font-family:'JetBrains Mono',monospace;font-size:10px;color:rgba(255,255,255,.45);display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:2px}
.dm-verified{font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.25);color:#10B981}
.dm-guessed{font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(245,158,11,.07);border:1px solid rgba(245,158,11,.2);color:#F59E0B}
.dm-links{display:flex;flex-direction:column;gap:3px;align-items:flex-end;flex-shrink:0}
.dm-li-btn{display:inline-flex;align-items:center;gap:3px;padding:3px 8px;border-radius:5px;background:rgba(14,165,233,.07);border:1px solid rgba(14,165,233,.15);color:#38BDF8;font-size:10px;font-weight:600;text-decoration:none;font-family:'Inter',sans-serif;transition:all .15s;white-space:nowrap}
.dm-li-btn:hover{background:rgba(14,165,233,.13)}
.dm-copy-btn{padding:2px 6px;border-radius:4px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);color:rgba(255,255,255,.3);font-size:9px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s}
.dm-copy-btn:hover{background:rgba(255,255,255,.09);color:#fff}
.dm-copy-btn.copied{background:rgba(16,185,129,.12);border-color:rgba(16,185,129,.25);color:#10B981}
.dm-appointed{font-family:'JetBrains Mono',monospace;font-size:9px;color:rgba(255,255,255,.2);margin-top:1px}

/* LINKEDIN */
.li-section{margin-bottom:12px}
.li-company-btn{display:flex;align-items:center;gap:6px;width:100%;padding:8px 12px;border-radius:7px;background:rgba(14,165,233,.07);border:1px solid rgba(14,165,233,.18);color:#38BDF8;font-size:12px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s;text-decoration:none;margin-bottom:7px}
.li-company-btn:hover{background:rgba(14,165,233,.13)}
.li-people{display:flex;flex-wrap:wrap;gap:4px}
.li-person-btn{display:inline-flex;align-items:center;gap:4px;padding:4px 9px;border-radius:6px;background:rgba(14,165,233,.05);border:1px solid rgba(14,165,233,.13);color:#38BDF8;font-size:11px;font-weight:500;cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s;text-decoration:none}
.li-person-btn:hover{background:rgba(14,165,233,.1)}

/* ACTIONS */
.actions{display:flex;gap:5px;flex-wrap:wrap}
.act{flex:1;min-width:76px;padding:7px 9px;border-radius:7px;font-size:11px;font-weight:600;cursor:pointer;transition:all .15s;font-family:'Inter',sans-serif;display:flex;align-items:center;justify-content:center;gap:4px;border:none;text-decoration:none}
.a-call{background:rgba(16,185,129,.1);color:#10B981;border:1px solid rgba(16,185,129,.2)!important}
.a-call:hover{background:rgba(16,185,129,.18)}
.a-email{background:rgba(99,102,241,.1);color:#818CF8;border:1px solid rgba(99,102,241,.2)!important}
.a-email:hover{background:rgba(99,102,241,.18)}
.a-web{background:rgba(255,255,255,.04);color:rgba(255,255,255,.4);border:1px solid rgba(255,255,255,.08)!important}
.a-web:hover{background:rgba(255,255,255,.07);color:rgba(255,255,255,.7)}

/* SIGNALS */
.sigs{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.sig{font-family:'JetBrains Mono',monospace;font-size:9px;padding:2px 6px;border-radius:3px;background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.14);color:rgba(129,140,248,.65)}

/* SIDEBAR */
.sidebar{padding-top:24px}
.sb{background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.06);border-radius:12px;margin-bottom:12px;overflow:hidden}
.sb-h{padding:10px 16px;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.3);border-bottom:1px solid rgba(255,255,255,.05)}
.sb-row{padding:10px 16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,.04)}
.sb-row:last-child{border-bottom:none}
.sb-l{font-size:12px;color:rgba(255,255,255,.4)}
.sb-v{font-size:14px;font-weight:700}
.sb-ev{padding:11px 16px;border-bottom:1px solid rgba(255,255,255,.04);cursor:pointer;transition:background .15s}
.sb-ev:last-child{border-bottom:none}
.sb-ev:hover{background:rgba(255,255,255,.03)}
.sb-et{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.1em;text-transform:uppercase;margin-bottom:3px}
.sb-eh{font-size:12px;font-weight:600;color:rgba(255,255,255,.6);line-height:1.4;margin-bottom:3px}
.sb-em{font-family:'JetBrains Mono',monospace;font-size:9px;color:rgba(255,255,255,.2)}

/* EXPOSURE */
.exp-level{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:5px;font-size:10px;font-weight:600;border:1px solid}
.exp-vh{color:#10B981;background:rgba(16,185,129,.1);border-color:rgba(16,185,129,.3)}
.exp-h{color:#F59E0B;background:rgba(245,158,11,.1);border-color:rgba(245,158,11,.3)}
.exp-m{color:#6366F1;background:rgba(99,102,241,.1);border-color:rgba(99,102,241,.3)}
.exp-l{color:#475569;background:rgba(71,85,105,.1);border-color:rgba(71,85,105,.3)}
.thesis-box{padding:10px 14px;background:rgba(16,185,129,.03);border:1px solid rgba(16,185,129,.08);border-left:3px solid rgba(16,185,129,.4);border-radius:0 8px 8px 0;margin-bottom:10px}
.thesis-label{font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#10B981;margin-bottom:4px}
.thesis-text{font-size:12px;line-height:1.65;color:rgba(255,255,255,.6)}

/* CRM STATUS */
.crm-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:600;border:1px solid;cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s;white-space:nowrap;user-select:none;position:relative}
.crm-badge:hover{filter:brightness(1.15)}
.crm-menu{position:absolute;top:calc(100% + 4px);right:0;z-index:50;background:#111827;border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:4px;display:flex;flex-direction:column;gap:1px;min-width:130px;box-shadow:0 8px 24px rgba(0,0,0,.5)}
.crm-opt{padding:6px 10px;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;transition:background .1s;display:flex;align-items:center;gap:6px}
.crm-opt:hover{background:rgba(255,255,255,.06)}
.crm-opt.active{background:rgba(255,255,255,.04)}
.crm-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}

/* EMPTY */
.empty{text-align:center;padding:56px 24px;color:rgba(255,255,255,.2)}
.empty-i{font-size:32px;margin-bottom:10px}
.empty-t{font-size:15px;font-weight:600;color:rgba(255,255,255,.3);margin-bottom:6px}
.empty-s{font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.8;color:rgba(255,255,255,.15)}
.empty-s code{color:rgba(16,185,129,.5)}
`;

// ─── HELPERS ──────────────────────────────────────────────────────
function expConfLabel(conf) {
  if (conf === "high")   return "🔍 Exposure: High confidence";
  if (conf === "medium") return "🔍 Exposure: Medium confidence";
  if (conf === "low")    return "🔍 Exposure: Low confidence";
  return null;
}
function expConfClass(conf) {
  if (conf === "high")   return "b b-site-high";
  if (conf === "medium") return "b b-site-med";
  return "b b-site-low";
}

function siteConfLabel(conf, source) {
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

function siteConfClass(conf) {
  if (conf === "high" || conf === "confirmed") return "b b-site-high";
  if (conf === "medium") return "b b-site-med";
  return "b b-site-low";
}

// ─── COMPANY SIZE HELPERS ────────────────────────────────────────
function sizeBandColor(band) {
  if (!band || band === "unknown" || band === "dormant") return "#475569";
  if (band === "<£1m")         return "#64748B";  // gray — micro/very small
  if (band === "£1m–£5m")      return "#F59E0B";  // amber — SME sweet spot
  if (band === "£5m–£25m")     return "#10B981";  // green — ideal FX target
  if (band === "£25m–£100m")   return "#38BDF8";  // blue — medium-large
  if (band === "£100m+")       return "#818CF8";  // purple — large corp
  return "#475569";
}
function sizeBandLabel(band) {
  if (!band || band === "unknown") return null;
  if (band === "dormant") return "dormant";
  return band;
}
function accTypeLabel(t) {
  if (!t) return null;
  const m = { "micro-entity":"micro", small:"small", medium:"medium", full:"full", group:"group", abridged:"abridged", dormant:"dormant" };
  return m[t] || t;
}
function fmtGBP(n) {
  if (n == null) return null;
  if (n >= 1_000_000) return `£${(n/1_000_000).toFixed(1)}m`;
  if (n >= 1_000)     return `£${(n/1_000).toFixed(0)}k`;
  return `£${n.toFixed(0)}`;
}

// ─── COMPANY FINANCIALS PANEL ────────────────────────────────────
function CompanyFinancials({ lead }) {
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

// ─── CRM BADGE ───────────────────────────────────────────────────
function CrmBadge({ leadId, status, onSet }) {
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

// ─── MESSAGE AMMO PANEL ──────────────────────────────────────────
function MessageAmmoPanel({ ingredients, outreach }) {
  // Support both new message_ingredients field and legacy outreach field
  const mi = ingredients || null;
  if (!mi && !outreach) return null;

  // If we only have legacy outreach (old format), show a simplified panel
  if (!mi && outreach) {
    return (
      <div className="outreach">
        <div className="xl" style={{marginBottom:7}}>Message notes — write in your own tone</div>
        {outreach.call_opener && (
          <div className="ammo-row">
            <div className="ammo-header">
              <span className="ammo-icon">📞</span>
              <span className="ammo-label">Call opener</span>
            </div>
            <div className="ammo-text">{outreach.call_opener}</div>
            <CopyBtn text={outreach.call_opener} />
          </div>
        )}
        {outreach.linkedin_connection && (
          <div className="ammo-row">
            <div className="ammo-header">
              <span className="ammo-icon">💼</span>
              <span className="ammo-label">LinkedIn note</span>
            </div>
            <div className="ammo-text">{outreach.linkedin_connection}</div>
            <CopyBtn text={outreach.linkedin_connection} />
          </div>
        )}
      </div>
    );
  }

  const rows = [
    { key:"event_hook",       label:"Event hook",        icon:"📡", help:"Open with this — then adapt" },
    { key:"why_it_matters",   label:"Why it matters",    icon:"💡", help:"Their specific situation" },
    { key:"likely_exposure",  label:"Likely exposure",   icon:"💱", help:"The payment/currency flow" },
    { key:"pain_point",       label:"Pain point",        icon:"⚡", help:"The commercial issue" },
    { key:"sales_angle",      label:"Suggested angle",   icon:"🎯", help:"How to approach it" },
    { key:"opening_question", label:"Opening question",  icon:"❓", help:"Get them talking" },
    { key:"soft_cta",         label:"Soft CTA options",  icon:"→",  help:"Low-pressure close" },
    { key:"linkedin_note",    label:"LinkedIn note",     icon:"💼", help:"Connection request starter" },
    { key:"call_opener",      label:"Call opener",       icon:"📞", help:"Phone approach" },
  ].filter(r => mi[r.key]);

  return (
    <div className="outreach">
      <div className="xl" style={{marginBottom:3}}>Message ammo — write in your own tone</div>
      <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"rgba(255,255,255,.2)",marginBottom:12}}>
        Sharp context for each channel · copy what's useful · discard the rest
      </div>
      <div className="ammo-grid">
        {rows.map(({key,label,icon,help}) => (
          <div key={key} className="ammo-row">
            <div className="ammo-header">
              <span className="ammo-icon">{icon}</span>
              <span className="ammo-label">{label}</span>
              <span className="ammo-help">{help}</span>
            </div>
            <div className="ammo-text">{mi[key]}</div>
            <CopyBtn text={mi[key]} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── CALL INTELLIGENCE PANEL ─────────────────────────────────────
function CallIntelligencePanel({ lead }) {
  const snippets  = lead.fx_evidence_snippets || [];
  const countries = lead.country_evidence || [];
  const pairs     = lead.inferred_currency_pairs || [];
  const supplier  = lead.supplier_evidence || [];
  const ieEvidence= lead.import_export_evidence || [];
  const sizeSignals = lead.size_signals || [];
  const fxScore   = lead.fx_likelihood_score;
  const reason    = lead.currency_reason || "";

  // Combine evidence into best display text: snippets first, then supplier phrases
  const allEvidence = [...snippets, ...supplier.filter(s => !snippets.some(sn=>sn.includes(s.slice(0,20))))];

  // Only show panel if there's something useful
  if (!pairs.length && !allEvidence.length && !countries.length && fxScore == null) return null;

  const fc = fxScore != null ? fxLikColor(fxScore) : "#475569";

  return (
    <div className="ci-panel">
      <div className="ci-header">
        <span className="ci-title">Why call today</span>
        {pairs.length > 0 && (
          <div className="ci-pairs">
            {pairs.slice(0,3).map(p=><span key={p} className="ci-pair">{p}</span>)}
          </div>
        )}
        {countries.length > 0 && (
          <span className="ci-countries">
            {countries.slice(0,4).join(" · ")}
          </span>
        )}
        {fxScore != null && (
          <span
            className="ci-fx-score"
            style={{color:fc,background:`${fc}14`,borderColor:`${fc}30`}}
            title={fxLikLabel(fxScore)}
          >
            FX {fxScore}%
          </span>
        )}
      </div>

      <div className="ci-snippets">
        {allEvidence.length > 0 ? (
          allEvidence.slice(0,3).map((s,i)=>(
            <div key={i} className="ci-snippet">"{s}"</div>
          ))
        ) : ieEvidence.length > 0 ? (
          ieEvidence.slice(0,2).map((s,i)=>(
            <div key={i} className="ci-snippet">"{s}"</div>
          ))
        ) : (
          <div className="ci-no-evidence">No direct evidence text extracted — check website manually</div>
        )}
      </div>

      {sizeSignals.length > 0 && (
        <div className="ci-size-signals">
          {sizeSignals.map(s=><span key={s} className="ci-size-tag">{s}</span>)}
        </div>
      )}

      {lead.website_confidence_reason && (
        <div style={{marginTop:6,fontSize:10,color:"rgba(255,255,255,.2)",fontFamily:"'JetBrains Mono',monospace",lineHeight:1.5}}>
          {lead.website_confidence_reason}
        </div>
      )}
    </div>
  );
}

// ─── EMAIL PATTERNS ──────────────────────────────────────────────
function EmailPatterns({ emails }) {
  const [copied, setCopied] = useState(null);
  if (!emails?.length) return null;
  function doCopy(email, idx) { copy(email); setCopied(idx); setTimeout(()=>setCopied(null),2000); }
  return (
    <div className="email-section">
      <div className="xl" style={{marginBottom:4}}>Email patterns — try in order</div>
      <div className="email-patterns">
        {emails.map((e,i) => (
          <div key={i} className="email-row">
            <span className="email-pattern">{e.pattern}</span>
            <span className="email-addr">{e.email}</span>
            <button className={`email-copy${copied===i?" copied":""}`} onClick={()=>doCopy(e.email,i)}>
              {copied===i?"✓":"Copy"}
            </button>
          </div>
        ))}
      </div>
      <div className="email-note">Guessed from director name + domain · verify before sending</div>
    </div>
  );
}

// ─── DECISION MAKERS PANEL ───────────────────────────────────────
function DMEmailCopy({ email }) {
  const [c, setC] = useState(false);
  return (
    <button className={`dm-copy-btn${c?" copied":""}`} onClick={()=>{copy(email);setC(true);setTimeout(()=>setC(false),2000);}}>
      {c?"✓":"Copy"}
    </button>
  );
}

function DMCard({ dm, co }) {
  const initials    = [dm.first_name, dm.last_name].filter(Boolean).map(w=>(w||"")[0]||"").join("").toUpperCase() || "?";
  const verifiedEmail = dm.email_verified && dm.email ? dm.email : null;
  const guessedTop  = !verifiedEmail && dm.email_guesses?.length ? dm.email_guesses[0]?.email : null;
  const bestEmail   = verifiedEmail || guessedTop;
  const liUrl       = dm.linkedin_search || (dm.name ? `https://www.google.com/search?q=site:linkedin.com/in+%22${encodeURIComponent(dm.name)}%22+%22${encodeURIComponent((co||"").split(" ").slice(0,3).join(" "))}%22` : null);
  const since       = dm.appointed_on ? dm.appointed_on.slice(0,7) : null;
  const tier        = dm.tier || 3;
  const tc          = tierColor(tier);
  const tlabel      = dm.tier_label || (tier===1?"Primary":tier===2?"Secondary":"Fallback");
  return (
    <div className={`dm-card tier-${tier}`}>
      <div className="dm-av" style={{borderColor:`${tc}40`,color:tc}}>{initials}</div>
      <div className="dm-info">
        <div className="dm-nm">
          {dm.name || [dm.first_name, dm.last_name].filter(Boolean).join(" ")}
          <span className="dm-tier-badge" style={{color:tc,background:`${tc}18`,border:`1px solid ${tc}35`}}>{tlabel}</span>
        </div>
        <div className="dm-rl" style={{color:tc}}>{dm.role || "Director"}</div>
        {since && <div className="dm-appointed">Appointed {since}</div>}
        {bestEmail && (
          <div className="dm-email">
            <span style={{color:verifiedEmail?"#10B981":"#F59E0B"}}>{verifiedEmail?"✓":"~"}</span>
            <span style={{wordBreak:"break-all"}}>{bestEmail}</span>
            {verifiedEmail ? <span className="dm-verified">verified</span> : <span className="dm-guessed">guessed</span>}
            <DMEmailCopy email={bestEmail} />
          </div>
        )}
      </div>
      <div className="dm-links">
        {liUrl && <a href={liUrl} target="_blank" rel="noreferrer" className="dm-li-btn">🔍 LinkedIn →</a>}
        {dm.google_email_search && !verifiedEmail && (
          <a href={dm.google_email_search} target="_blank" rel="noreferrer" className="dm-li-btn" style={{background:"rgba(245,158,11,.07)",borderColor:"rgba(245,158,11,.18)",color:"#F59E0B"}}>📧 email →</a>
        )}
      </div>
    </div>
  );
}

function GradeBadge({ grade }) {
  if (!grade) return null;
  const gc = gradeColor(grade);
  return (
    <span
      className="grade-badge"
      style={{color:gc, background:gradeBg(grade), borderColor:`${gc}35`}}
      title={gradeTip(grade)}
    >
      {grade}
    </span>
  );
}

function ReadinessBadge({ lead }) {
  const cr = lead.call_readiness;
  if (!cr) return null;
  const col = crColor(cr);
  const reasons = lead.call_readiness_reasons || [];
  const tip = cr === "READY"
    ? "READY — Grade A/B + strong FX evidence + high/medium website confidence"
    : cr === "REVIEW"
    ? `REVIEW — ${reasons.join(" · ")}`
    : `HOLD — ${reasons.join(" · ")}`;
  return (
    <span
      className="grade-badge"
      style={{color:col, background:crBg(cr), borderColor:`${col}35`, letterSpacing:"0.02em"}}
      title={tip}
    >
      {cr}
    </span>
  );
}

function ConfidenceBar({ value }) {
  if (value == null) return null;
  const pct = Math.min(100, Math.max(0, value));
  const c   = pct >= 70 ? "#10B981" : pct >= 45 ? "#F59E0B" : "#64748B";
  return (
    <div className="conf-bar">
      <div className="conf-track">
        <div className="conf-fill" style={{width:`${pct}%`, background:c}} />
      </div>
      <span style={{color:c}}>{pct}%</span>
    </div>
  );
}

function DecisionMakers({ lead }) {
  const dms     = lead.decision_makers;
  const grade   = lead.route_grade;
  const conf    = lead.contact_confidence;
  const hasDMs  = dms && dms.length > 0;

  if (!hasDMs) {
    if (!lead.director_name && !grade) return null;
    const initials = (lead.director_name||"").split(" ").slice(0,2).map(w=>w[0]||"").join("").toUpperCase()||"?";
    return (
      <div style={{gridColumn:"1/-1"}}>
        <div className="dm-panel-hdr">
          <div className="xl" style={{margin:0}}>Decision maker</div>
          {grade && <GradeBadge grade={grade} />}
          <ConfidenceBar value={conf} />
        </div>
        {lead.director_name && (
          <div className="dir-card" style={{marginTop:4}}>
            <div className="dir-av">{initials}</div>
            <div>
              <div className="dir-nm">{lead.director_name}</div>
              <div className="dir-rl">{lead.director_role}</div>
            </div>
          </div>
        )}
      </div>
    );
  }

  const verifiedCount = dms.filter(d=>d.email_verified && d.email).length;
  const tier1Count    = dms.filter(d=>d.tier === 1).length;

  return (
    <div className="dm-panel" style={{gridColumn:"1/-1"}}>
      <div className="dm-panel-hdr">
        <div className="xl" style={{margin:0}}>
          Decision makers · {dms.length} director{dms.length>1?"s":""}
        </div>
        {grade && <GradeBadge grade={grade} />}
        <ConfidenceBar value={conf} />
        {verifiedCount > 0 && (
          <span style={{fontSize:10,color:"#10B981",fontFamily:"'JetBrains Mono',monospace"}}>
            ✓ {verifiedCount} verified
          </span>
        )}
        {tier1Count > 0 && (
          <span style={{fontSize:10,color:"rgba(255,255,255,.25)",fontFamily:"'JetBrains Mono',monospace"}}>
            {tier1Count} FD/MD/CFO
          </span>
        )}
      </div>
      <div className="dm-list">
        {dms.map((dm,i) => <DMCard key={i} dm={dm} co={lead.company_name} />)}
      </div>
    </div>
  );
}

// ─── CALL OPENER GENERATOR ───────────────────────────────────────
function generateOpener(lead, ev) {
  ev = ev || {};
  const co        = lead.company_name || "";
  const coShort   = co.split(" ").slice(0, 4).join(" ");
  const dirName   = lead.director_name || "";
  const firstName = dirName.split(" ")[0] || "there";
  const segment   = lead.segment_name || "";

  // Currency
  const pairs      = lead.inferred_currency_pairs || [];
  const pair       = pairs[0] || lead.fx_exposure || (ev.currency_pairs||[])[0] || "GBP/EUR";
  const parts      = pair.split("/");
  const foreignCcy = parts[0] === "GBP" ? (parts[1] || "EUR") : (parts[0] || "EUR");
  const isEur      = pair.includes("EUR");
  const isUsd      = pair.includes("USD");

  // Evidence
  const snippets  = (lead.fx_evidence_snippets || []).filter(s => s && s.length > 8);
  const suppliers = (lead.supplier_evidence     || []).filter(s => s && s.length > 5);
  const countries = (lead.country_evidence      || []).filter(s => s && s.length > 2);

  // Build evidence hook + type
  let evidenceHook = "";
  let evidenceType = "generic";

  if (snippets.length > 0) {
    const best = snippets[0].slice(0, 90);
    evidenceHook = `I noticed on your website: "${best}${snippets[0].length > 90 ? "…" : ""}"`;
    evidenceType = "snippet";
  } else if (suppliers.length > 0) {
    const sup = suppliers[0];
    const supLower = sup.toLowerCase();
    evidenceHook = (supLower.startsWith("source") || supLower.startsWith("import") || supLower.startsWith("buy"))
      ? `I noticed ${co} ${sup.slice(0, 70)}`
      : `I noticed ${co} sources ${sup.slice(0, 60)}`;
    evidenceType = "supplier";
  } else if (countries.length > 0) {
    const ctry = countries.slice(0, 2).join(" and ");
    evidenceHook = `I noticed ${co} works with suppliers or partners in ${ctry}`;
    evidenceType = "country";
  } else {
    const segPhrase = segment ? `as a ${segment.slice(0, 40).toLowerCase()}` : "as a UK business";
    evidenceHook = `I came across ${co} — ${segPhrase}, you're likely managing regular ${foreignCcy} payments`;
    evidenceType = "generic";
  }

  // Payment flow follow-on (for non-generic)
  let paymentBridge = "";
  if (evidenceType !== "generic") {
    paymentBridge = isEur
      ? ` — so EUR supplier or customer payments are probably a regular part of your costs`
      : isUsd
      ? ` — so USD payments are likely a regular part of your costs`
      : ` — so ${foreignCcy} payments are probably part of your regular costs`;
  }

  // Event tie-in
  const evLine = ev.headline
    ? `With ${pair} moving${ev.sales_angle ? ` — ${ev.sales_angle.slice(0, 70).toLowerCase()}` : " this week"}`
    : `With recent ${pair} moves`;

  // Ask
  const ask = dirName
    ? `Is this something that sits with you, or is there someone in finance I should speak to?`
    : `Are you the right person for this, or would it be better to speak to whoever handles your overseas payments?`;

  // ── CALL OPENER ──
  const call = evidenceType === "generic"
    ? `${evidenceHook}.\n${evLine}, I wanted to check in on how you're protecting against those moves.\n${ask}`
    : `${evidenceHook}${paymentBridge}.\n${evLine}, I wanted to reach out about how you're managing those costs.\n${ask}`;

  // ── LINKEDIN (≤300 chars) ──
  const liSnippet = evidenceType === "snippet"
    ? `I noticed ${coShort} sources internationally`
    : evidenceType === "supplier"
    ? `I noticed ${coShort} ${suppliers[0]?.slice(0, 35)?.toLowerCase() || "works with overseas suppliers"}`
    : evidenceType === "country"
    ? `I noticed ${coShort} works with suppliers in ${countries[0] || "Europe"}`
    : `${coShort} ${segment ? "— as a " + segment.slice(0, 30).toLowerCase() : "as a UK business"}`;

  let linkedin = `Hi ${firstName}, ${liSnippet}. With ${pair} moving this week, wanted to connect on how you're managing those FX costs. Happy to share what's useful.`;
  if (linkedin.length > 300) {
    linkedin = `Hi ${firstName}, with ${pair} moving this week, wanted to connect around how ${coShort} is managing ${foreignCcy} payment costs. Happy to share what's useful.`;
  }
  if (linkedin.length > 300) linkedin = linkedin.slice(0, 297) + "...";

  // ── EMAIL ──
  const subject  = `${foreignCcy} costs for ${coShort} — ${pair} move`;
  const emailBody = evidenceType !== "generic"
    ? `Hi ${firstName},\n\n${evidenceHook}${paymentBridge}.\n\n${evLine}, so I wanted to reach out. A lot of businesses managing ${foreignCcy} payments find the bank rate isn't the sharpest available — often there's a meaningful saving to be made.\n\nWould it be worth a quick conversation to see if there's anything useful for ${coShort}?`
    : `Hi ${firstName},\n\n${evidenceHook}.\n\n${evLine}, so I wanted to reach out. Businesses like ${coShort} often find they can reduce ${foreignCcy} payment costs by reviewing their FX setup — it usually only takes one conversation to find out.\n\nWould it be worth a quick call?`;

  return { call, linkedin, subject, emailBody };
}

function CallOpenerPanel({ lead, event }) {
  const [tab, setTab]     = useState("call");
  const [copied, setCopied] = useState(false);
  const opener = useMemo(() => generateOpener(lead, event), [lead, event]);

  function doCopy(text) { copy(text); setCopied(true); setTimeout(()=>setCopied(false), 2000); }

  const content = tab === "call"
    ? opener.call
    : tab === "linkedin"
    ? opener.linkedin
    : opener.emailBody;

  const charCount = tab === "linkedin" ? opener.linkedin.length : null;

  // Don't show if there's no meaningful evidence to work from AND no event context
  const hasContext = (lead.fx_evidence_snippets||[]).length > 0
    || (lead.supplier_evidence||[]).length > 0
    || (lead.country_evidence||[]).length > 0
    || lead.segment_name
    || event?.headline;
  if (!hasContext) return null;

  return (
    <div className="opener-panel">
      <div className="opener-tabs">
        <button className={`opener-tab${tab==="call"?" active":""}`}     onClick={()=>setTab("call")}>📞 Call</button>
        <button className={`opener-tab${tab==="linkedin"?" active":""}`} onClick={()=>setTab("linkedin")}>💼 LinkedIn</button>
        <button className={`opener-tab${tab==="email"?" active":""}`}    onClick={()=>setTab("email")}>✉ Email</button>
      </div>
      <div className="opener-body">
        {tab === "email" && (
          <div className="opener-label">Subject: {opener.subject}</div>
        )}
        <div className="opener-text">{content}</div>
        {charCount !== null && (
          <div className="opener-char" style={{color: charCount > 300 ? "#F87171" : "rgba(255,255,255,.2)"}}>
            {charCount}/300 chars{charCount > 300 ? " ⚠" : ""}
          </div>
        )}
        <button
          className={`copy-btn${copied?" copied":""}`}
          style={{top:10,right:10}}
          onClick={()=>doCopy(tab==="email"?`Subject: ${opener.subject}\n\n${opener.emailBody}`:content)}
        >
          {copied ? "✓ Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

// ─── COMPANY CARD ────────────────────────────────────────────────
function CompanyCard({ lead, crmStatus, onCrmSet, performAction, crmEntry, event }) {
  const [open, setOpen] = useState(false);
  const color       = pri(lead.priority);
  const initials    = (lead.director_name||"").split(" ").slice(0,2).map(w=>w[0]||"").join("").toUpperCase()||"?";
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
            {lead.contact_phone && (
              <span style={{color:"#10B981",fontFamily:"'JetBrains Mono',monospace",fontSize:10,fontWeight:700}}>
                📞 {lead.contact_phone}
                {(lead.phone_source_count||0) >= 2 && <span style={{color:"rgba(16,185,129,.5)",fontSize:9,marginLeft:4}}>✓×{lead.phone_source_count}</span>}
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
                  <span className="phone-val">{lead.contact_phone}</span>
                  {lead.phone_source_count >= 2 && (
                    <span className="phone-src phone-src-high">✓ {lead.phone_source_count} sources</span>
                  )}
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
            const coUrl    = `https://www.google.com/search?q=site:linkedin.com/company+%22${encodeURIComponent(co)}%22`;
            const dirUrl   = dir ? `https://www.google.com/search?q=site:linkedin.com/in+%22${encodeURIComponent(dir)}%22` : null;
            const dirCoUrl = dir ? `https://www.google.com/search?q=site:linkedin.com/in+%22${encodeURIComponent(dir)}%22+%22${encodeURIComponent(co.split(" ").slice(0,3).join(" "))}%22` : null;
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
                    {(li?.people_searches||[]).filter(p=>!p.role.includes("direct search")).slice(0,3).map(p=>(
                      <a key={p.role} href={`https://www.google.com/search?q=site:linkedin.com/in+${encodeURIComponent(co.split(" ").slice(0,3).join(" "))}+${encodeURIComponent(p.role.replace(/ →$/,""))}`} target="_blank" rel="noreferrer" className="li-person-btn">{p.role} →</a>
                    ))}
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

// ─── FILTER BAR ──────────────────────────────────────────────────
function FilterBar({ filters, setFilters, leads, events, filteredCount, crmState }) {
  const priorities  = useMemo(()=>[...new Set(leads.map(l=>l.priority))].filter(Boolean).sort(),[leads]);
  const siteConfOpts= ["high","medium","confirmed","low"];
  const segments    = useMemo(()=>[...new Set(leads.map(l=>l.segment_name).filter(Boolean))].sort(),[leads]);
  const currencyPairs = useMemo(()=>{
    const s = new Set();
    leads.forEach(l=>{ if(l.fx_exposure) l.fx_exposure.split(",").forEach(p=>s.add(p.trim())); });
    return [...s].filter(Boolean).sort();
  },[leads]);

  function set(key, val) { setFilters(f=>({...f,[key]:val})); }
  function toggleArr(key, val) {
    setFilters(f=>{
      const cur = f[key]||[];
      const next= cur.includes(val)?cur.filter(x=>x!==val):[...cur,val];
      return {...f,[key]:next};
    });
  }

  const statusCounts = useMemo(()=>{
    const c={};
    leads.forEach(l=>{ const s=crmState[l.id]||l.status||"new"; c[s]=(c[s]||0)+1; });
    return c;
  },[leads,crmState]);

  const hasExtra = filters.priorities.length||filters.siteConfs.length||filters.hasFxSignals||
    filters.hasWebsite||filters.hasDirector||filters.minScore>0||
    filters.eventId!=="all"||filters.currencyPair!=="all"||filters.segment!=="all"||
    filters.statuses.length||filters.grades.length||filters.sortBy!=="score"||filters.search;

  const priChipCls = p => {
    const on = filters.priorities.includes(p);
    if (!on) return "chip";
    if (p==="HOT") return "chip hot-on";
    if (p==="WARM") return "chip warm-on";
    if (p==="QUEUE") return "chip queue-on";
    return "chip on";
  };
  const siteChipCls = c => {
    const on = filters.siteConfs.includes(c);
    if (!on) return "chip";
    if (c==="high"||c==="confirmed") return "chip hi-on";
    if (c==="medium") return "chip med-on";
    return "chip low-on";
  };

  return (
    <div className="fb">
      {/* Priority */}
      <div className="fb-group">
        <span className="fb-label">Priority</span>
        {priorities.map(p=>(
          <button key={p} className={priChipCls(p)} onClick={()=>toggleArr("priorities",p)}>{p}</button>
        ))}
      </div>

      <div className="fb-sep"/>

      {/* Site confidence */}
      <div className="fb-group">
        <span className="fb-label">Site</span>
        {siteConfOpts.filter(c=>leads.some(l=>l.website_confidence===c)).map(c=>(
          <button key={c} className={siteChipCls(c)} onClick={()=>toggleArr("siteConfs",c)}>
            {c==="high"?"High":c==="medium"?"Med":c==="confirmed"?"Conf":"Low"}
          </button>
        ))}
      </div>

      <div className="fb-sep"/>

      {/* Route grade filter */}
      <div className="fb-group">
        <span className="fb-label">Grade</span>
        {["A","B","C","D","E"].map(g=>(
          <button
            key={g}
            className={`chip${filters.grades.includes(g)?" on":""}`}
            style={filters.grades.includes(g)?{background:gradeBg(g),borderColor:`${gradeColor(g)}55`,color:gradeColor(g)}:{}}
            onClick={()=>toggleArr("grades",g)}
            title={gradeTip(g)}
          >{g}</button>
        ))}
      </div>

      <div className="fb-sep"/>

      {/* Sort */}
      <div className="fb-group">
        <span className="fb-label">Sort</span>
        <select className="fb-select" value={filters.sortBy} onChange={e=>set("sortBy",e.target.value)}>
          <option value="readiness">Call readiness</option>
          <option value="score">Score</option>
          <option value="grade">Route grade</option>
          <option value="confidence">Confidence</option>
          <option value="fx_likelihood">FX likelihood</option>
        </select>
      </div>

      <div className="fb-sep"/>

      {/* Toggles */}
      <div className="fb-group">
        <button className={`chip${filters.hasFxSignals?" on":""}`} onClick={()=>set("hasFxSignals",!filters.hasFxSignals)}>Has FX signals</button>
        <button className={`chip${filters.hasWebsite?" on":""}`} onClick={()=>set("hasWebsite",!filters.hasWebsite)}>Has website</button>
        <button className={`chip${filters.hasDirector?" on":""}`} onClick={()=>set("hasDirector",!filters.hasDirector)}>Has director</button>
      </div>

      <div className="fb-sep"/>

      {/* Dropdowns */}
      <div className="fb-group">
        <select className="fb-select" value={filters.eventId} onChange={e=>set("eventId",e.target.value)}>
          <option value="all">All events</option>
          {events.map(ev=><option key={ev.id} value={ev.id}>{ev.headline.slice(0,42)}…</option>)}
        </select>
      </div>

      {currencyPairs.length > 0 && (
        <div className="fb-group">
          <select className="fb-select" value={filters.currencyPair} onChange={e=>set("currencyPair",e.target.value)}>
            <option value="all">All currencies</option>
            {currencyPairs.map(p=><option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      )}

      {segments.length > 1 && (
        <div className="fb-group">
          <select className="fb-select" value={filters.segment} onChange={e=>set("segment",e.target.value)}>
            <option value="all">All segments</option>
            {segments.map(s=><option key={s} value={s}>{s.slice(0,35)}</option>)}
          </select>
        </div>
      )}

      <div className="fb-sep"/>

      {/* CRM status */}
      <div className="fb-group">
        {CRM_STATUSES.filter(s=>statusCounts[s]>0).map(s=>(
          <button
            key={s}
            className={`chip${filters.statuses.includes(s)?" on":""}`}
            style={filters.statuses.includes(s)?{background:`${CRM_COLORS[s]}15`,borderColor:`${CRM_COLORS[s]}55`,color:CRM_COLORS[s]}:{}}
            onClick={()=>toggleArr("statuses",s)}
          >
            {CRM_LABELS[s]} <span style={{opacity:.5,fontSize:9}}>({statusCounts[s]})</span>
          </button>
        ))}
      </div>

      <div className="fb-sep"/>

      {/* Search */}
      <input
        className="fb-search"
        placeholder="🔍  Company or director…"
        value={filters.search}
        onChange={e=>set("search",e.target.value)}
      />

      {/* Count + reset */}
      <span className="fb-count">{filteredCount} showing</span>
      {hasExtra && (
        <button className="fb-reset" onClick={()=>setFilters(f=>({...BLANK_FILTERS,view:f.view}))}>
          Clear filters
        </button>
      )}
    </div>
  );
}

// ─── EVENT ITEM ──────────────────────────────────────────────────
function EventItem({ event, leads, allLeads, index, getCrmStatus, onCrmSet, getLead, performAction }) {
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

// ─── ROOT APP ────────────────────────────────────────────────────
export default function App() {
  const [events,  setEvents]  = useState([]);
  const [leads,   setLeads]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [lastRef, setLast]    = useState(null);
  const [filters, setFilters] = useState(CALL_LIST_FILTERS);
  const { state: crmState, getLead, getStatus: getCrmStatus, updateLead, performAction } = useCrmState();

  const load = useCallback(async()=>{
    setLoading(true);
    try {
      const d = await fetchData();
      setEvents(d.events); setLeads(d.leads); setLast(new Date());
    } catch(e){console.error(e);}
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
  // callListLeads = top CALL_LIST_MAX eligible leads (same slice as applyFilters call_list view)
  const callListLeads  = useMemo(()=>leads.filter(isCallListEligible).slice(0, CALL_LIST_MAX),[leads]);
  const researchLeads  = useMemo(()=>{
    const ids = new Set(callListLeads.map(l => l.website_domain || l.company_number));
    return leads.filter(l => !ids.has(l.website_domain || l.company_number));
  },[leads, callListLeads]);

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

  const viewDesc = filters.view === "call_list"
    ? `Top ${CALL_LIST_MAX} leads · verified website · FX signals · contact route confirmed`
    : filters.view === "research"
    ? "Remaining leads — needs review before calling"
    : "All leads across all events";

  const viewCountCls = filters.view === "call_list" ? "view-count view-count-cl"
    : filters.view === "research" ? "view-count view-count-rq"
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
          <div className="live"><div className="live-dot"/>LIVE</div>
          {lastRef && <span className="tb-time">{ago(lastRef)}</span>}
          <button className="btn-sm" onClick={load} disabled={loading}>{loading?"…":"↻ Refresh"}</button>
        </div>
      </div>

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
          {n:callListLeads.length, l:"Call targets",      s:"HOT/WARM · FX confirmed",   c:"#10B981"},
          {n:hot,                  l:"HOT leads",         s:"Score ≥ 80",                c:"#10B981"},
          {n:warm,                 l:"WARM leads",        s:"Score 60–79",               c:"#F59E0B"},
          {n:leads.length,         l:"Companies found",   s:"All events · all priority", c:"#6366F1"},
          {n:hasSite,              l:"Website verified",  s:`${Math.round(hasSite/Math.max(leads.length,1)*100)}% of pipeline`, c:"#38BDF8"},
          {n:contacted,            l:"In progress",       s:"Contacted/follow-up",       c:"#38BDF8"},
          {n:meetings,             l:"Meetings booked",   s:"CRM tracked",               c:"#10B981"},
          {n:saved,                l:"Saved",             s:"Worth revisiting",          c:"#F59E0B"},
        ].map(({n,l,s,c})=>(
          <div className="stat" key={l}>
            <div className="stat-n" style={{color:c}}>{n}</div>
            <div><span className="stat-l">{l}</span><span className="stat-s">{s}</span></div>
          </div>
        ))}
      </div>

      {/* VIEW SWITCHER */}
      <div className="view-banner">
        <div className="view-tabs">
          <button
            className={`view-tab${filters.view==="call_list"?" active-cl":""}`}
            onClick={()=>setFilters(CALL_LIST_FILTERS)}
          >
            ⚡ Daily Call List {callListLeads.length > 0 && `(${callListLeads.length})`}
          </button>
          <button
            className={`view-tab${filters.view==="research"?" active-rq":""}`}
            onClick={()=>setFilters(RESEARCH_FILTERS)}
          >
            🔍 Research Queue
          </button>
          <button
            className={`view-tab${filters.view==="all"?" active-all":""}`}
            onClick={()=>setFilters(ALL_FILTERS)}
          >
            ⊙ All Leads
          </button>
        </div>
        <span className="view-desc">{viewDesc}</span>
        <span className={viewCountCls}>{filteredLeads.length} leads</span>
      </div>

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
                    getCrmStatus={getCrmStatus}
                    onCrmSet={updateLead}
                    getLead={getLead}
                    performAction={performAction}
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
              {l:"Priority leads",   v:callListLeads.length, c:"#10B981"},
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
    </>
  );
}
