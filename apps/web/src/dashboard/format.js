// Small display helpers: colours for priority, grade, readiness and FX evidence; dates.
// (Split out of App.jsx; no behaviour change.)
export const ago = iso => {
  if (!iso) return "";
  const s = Math.floor((Date.now()-new Date(iso))/1000);
  if (s<60) return`${s}s ago`; if (s<3600) return`${Math.floor(s/60)}m ago`;
  if (s<86400) return`${Math.floor(s/3600)}h ago`; return`${Math.floor(s/86400)}d ago`;
};

export const urg  = s => s>=8?"#10B981":s>=6?"#F59E0B":s>=4?"#6366F1":"#475569";
export const pri  = p => p==="HOT"?"#10B981":p==="WARM"?"#F59E0B":"#6366F1";
export const expClass = l => l==="Very High"?"exp-vh":l==="High"?"exp-h":l==="Medium"?"exp-m":"exp-l";
export const expLabel = l => l==="Very High"?"● Very High":l==="High"?"● High":l==="Medium"?"○ Medium":"○ Low";
// Route grade helpers
export const GRADE_COLOR = {A:"#10B981",B:"#34D399",C:"#F59E0B",D:"#94A3B8",E:"#64748B",F:"#475569"};
export const GRADE_BG    = {A:"rgba(16,185,129,.12)",B:"rgba(52,211,153,.08)",C:"rgba(245,158,11,.1)",D:"rgba(148,163,184,.07)",E:"rgba(100,116,139,.06)",F:"rgba(71,85,105,.06)"};
export const GRADE_TIP   = {A:"Named FD/CFO/MD + verified contact",B:"Named FD/CFO/MD + guessed email/contact page",C:"Named director + phone or email",D:"Company phone/email, no named person",E:"Website only",F:"No contact route found"};
export const gradeColor  = g => GRADE_COLOR[g] || "#475569";
export const gradeBg     = g => GRADE_BG[g]    || "rgba(71,85,105,.06)";
// Call readiness helpers
export const CR_COLOR = {READY:"#10B981",REVIEW:"#F59E0B",HOLD:"#64748B"};
export const CR_BG    = {READY:"rgba(16,185,129,.12)",REVIEW:"rgba(245,158,11,.1)",HOLD:"rgba(100,116,139,.07)"};
export const CR_ORDER = {READY:0,REVIEW:1,HOLD:2,undefined:3};
export const crColor  = r => CR_COLOR[r] || "#64748B";
export const crBg     = r => CR_BG[r]    || "rgba(100,116,139,.07)";
export const gradeTip    = g => GRADE_TIP[g]   || "";
export const TIER_COLOR  = {1:"#10B981",2:"#F59E0B",3:"#64748B"};
export const tierColor   = t => TIER_COLOR[t]  || "#64748B";
// FX likelihood score helpers
export const fxLikColor  = s => s>=70?"#10B981":s>=45?"#F59E0B":s>=25?"#818CF8":"#475569";
export const fxLikLabel  = s => s>=70?"Strong FX evidence":s>=45?"Moderate FX evidence":s>=25?"Some FX evidence":"Weak evidence";
export const today    = new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"});
export const dateShort= new Date().toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"});

export function copy(text) { navigator.clipboard.writeText(text).catch(()=>{}); }
