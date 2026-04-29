import { useEffect, useState, useCallback, useMemo } from "react";

async function fetchData() {
  const [evRes, ldRes] = await Promise.all([
    fetch(`${import.meta.env.BASE_URL}data/events.json?t=${Date.now()}`),
    fetch(`${import.meta.env.BASE_URL}data/leads.json?t=${Date.now()}`),
  ]);
  const evObj = evRes.ok ? await evRes.json() : {};
  const ldObj = ldRes.ok ? await ldRes.json() : {};
  return {
    events: Object.values(evObj).sort((a,b) => new Date(b.detected_at||0) - new Date(a.detected_at||0)),
    leads:  Object.values(ldObj).sort((a,b) => (b.score||0) - (a.score||0)),
  };
}

function timeAgo(iso) {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400)return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

const urgencyColor = s => s>=8?"#10B981":s>=6?"#F59E0B":s>=4?"#6366F1":"#64748B";
const priorityColor = p => p==="HOT"?"#10B981":p==="WARM"?"#F59E0B":"#6366F1";
const priorityBg    = p => p==="HOT"?"rgba(16,185,129,0.1)":p==="WARM"?"rgba(245,158,11,0.1)":"rgba(99,102,241,0.1)";

// ── STYLES ────────────────────────────────────────────────────────
const STYLES = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{
  background:#080C14;
  color:#E2E8F0;
  font-family:'Inter',sans-serif;
  font-size:14px;
  line-height:1.5;
  -webkit-font-smoothing:antialiased;
}
::-webkit-scrollbar{width:5px}
::-webkit-scrollbar-track{background:rgba(255,255,255,0.02)}
::-webkit-scrollbar-thumb{background:rgba(16,185,129,0.3);border-radius:3px}

/* ── LAYOUT ── */
.wrap{max-width:1440px;margin:0 auto;padding:0 24px}
@media(max-width:768px){.wrap{padding:0 16px}}

/* ── TOP BAR ── */
.topbar{
  display:flex;align-items:center;justify-content:space-between;
  padding:14px 0;
  border-bottom:1px solid rgba(255,255,255,0.05);
  position:sticky;top:0;z-index:100;
  background:rgba(8,12,20,0.92);
  backdrop-filter:blur(20px);
}
.topbar-left{display:flex;align-items:center;gap:10px}
.topbar-logo{
  display:flex;align-items:center;gap:8px;
  font-size:13px;font-weight:700;letter-spacing:0.04em;color:#F8FAFC;
}
.topbar-logo-mark{
  width:28px;height:28px;border-radius:7px;
  background:linear-gradient(135deg,#10B981,#059669);
  display:grid;place-items:center;
  font-size:13px;font-weight:800;color:#fff;
}
.topbar-divider{width:1px;height:16px;background:rgba(255,255,255,0.1)}
.topbar-subtitle{
  font-family:'JetBrains Mono',monospace;
  font-size:10px;letter-spacing:0.1em;
  color:rgba(255,255,255,0.3);text-transform:uppercase;
}
.topbar-right{display:flex;align-items:center;gap:8px}
.live-badge{
  display:flex;align-items:center;gap:5px;
  font-family:'JetBrains Mono',monospace;font-size:10px;
  color:#10B981;letter-spacing:0.08em;
}
.live-dot{
  width:6px;height:6px;border-radius:50%;background:#10B981;
  animation:livepulse 2s ease-in-out infinite;
  box-shadow:0 0 6px #10B981;
}
@keyframes livepulse{0%,100%{opacity:1}50%{opacity:0.4}}
.btn-sm{
  padding:6px 14px;border-radius:7px;font-size:12px;font-weight:600;
  cursor:pointer;transition:all 0.15s;border:none;font-family:'Inter',sans-serif;
}
.btn-primary{background:#10B981;color:#fff}
.btn-primary:hover{background:#059669;transform:translateY(-1px)}
.btn-ghost{
  background:rgba(255,255,255,0.04);
  border:1px solid rgba(255,255,255,0.1)!important;
  color:rgba(255,255,255,0.6);
}
.btn-ghost:hover{background:rgba(255,255,255,0.08);color:#fff}

/* ── HERO ── */
.hero{
  padding:52px 0 44px;
  border-bottom:1px solid rgba(255,255,255,0.05);
  position:relative;overflow:hidden;
}
.hero::before{
  content:'';position:absolute;top:-80px;right:-80px;
  width:400px;height:400px;border-radius:50%;
  background:radial-gradient(circle,rgba(16,185,129,0.08) 0%,transparent 70%);
  pointer-events:none;
}
.hero-eyebrow{
  display:inline-flex;align-items:center;gap:6px;
  font-family:'JetBrains Mono',monospace;font-size:10px;
  letter-spacing:0.14em;text-transform:uppercase;
  color:#10B981;margin-bottom:16px;
  padding:4px 10px;border-radius:20px;
  background:rgba(16,185,129,0.08);
  border:1px solid rgba(16,185,129,0.2);
}
.hero-title{
  font-size:clamp(28px,4vw,44px);font-weight:800;
  letter-spacing:-0.03em;line-height:1.1;
  color:#F8FAFC;margin-bottom:12px;
}
.hero-title span{
  background:linear-gradient(135deg,#10B981,#34D399);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;
}
.hero-sub{
  font-size:15px;line-height:1.7;
  color:rgba(255,255,255,0.45);
  max-width:560px;margin-bottom:28px;
}
.hero-ctas{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:36px}
.btn-lg{
  padding:11px 22px;border-radius:9px;font-size:14px;font-weight:600;
  cursor:pointer;transition:all 0.18s;border:none;font-family:'Inter',sans-serif;
  display:inline-flex;align-items:center;gap:7px;
}
.btn-lg.primary{
  background:linear-gradient(135deg,#10B981,#059669);
  color:#fff;box-shadow:0 4px 20px rgba(16,185,129,0.3);
}
.btn-lg.primary:hover{transform:translateY(-2px);box-shadow:0 8px 28px rgba(16,185,129,0.4)}
.btn-lg.secondary{
  background:rgba(255,255,255,0.04);
  border:1px solid rgba(255,255,255,0.1)!important;
  color:rgba(255,255,255,0.7);
}
.btn-lg.secondary:hover{background:rgba(255,255,255,0.08);color:#fff}

/* ── STAT CARDS ── */
.stats-row{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:12px;
}
@media(max-width:640px){.stats-row{grid-template-columns:repeat(2,1fr)}}
.stat-card{
  background:rgba(255,255,255,0.025);
  border:1px solid rgba(255,255,255,0.06);
  border-radius:12px;padding:16px 18px;
}
.stat-card-num{
  font-size:28px;font-weight:800;line-height:1;
  margin-bottom:4px;
}
.stat-card-label{
  font-size:11px;font-weight:500;
  color:rgba(255,255,255,0.35);letter-spacing:0.04em;text-transform:uppercase;
}
.stat-card-delta{
  font-family:'JetBrains Mono',monospace;
  font-size:10px;margin-top:6px;
  display:inline-flex;align-items:center;gap:3px;
  padding:2px 6px;border-radius:4px;
}

/* ── SECTION ── */
.section{padding:32px 0}
.section-header{
  display:flex;justify-content:space-between;align-items:center;
  margin-bottom:20px;gap:12px;flex-wrap:wrap;
}
.section-title{
  font-size:13px;font-weight:700;
  letter-spacing:0.06em;text-transform:uppercase;
  color:rgba(255,255,255,0.5);
}
.section-divider{
  height:1px;background:rgba(255,255,255,0.05);
  flex:1;min-width:20px;
}

/* ── FILTER BAR ── */
.filter-bar{
  display:flex;gap:8px;flex-wrap:wrap;
  padding:16px 20px;
  background:rgba(255,255,255,0.02);
  border:1px solid rgba(255,255,255,0.06);
  border-radius:12px;margin-bottom:20px;
  align-items:center;
}
.filter-label{
  font-size:11px;font-weight:600;
  color:rgba(255,255,255,0.3);
  letter-spacing:0.06em;text-transform:uppercase;
  margin-right:4px;white-space:nowrap;
}
.filter-btn{
  padding:5px 12px;border-radius:6px;font-size:12px;font-weight:500;
  cursor:pointer;transition:all 0.13s;
  background:rgba(255,255,255,0.04);
  border:1px solid rgba(255,255,255,0.08);
  color:rgba(255,255,255,0.45);
  font-family:'Inter',sans-serif;
}
.filter-btn:hover{background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.7)}
.filter-btn.active{
  background:rgba(16,185,129,0.12);
  border-color:rgba(16,185,129,0.35);
  color:#10B981;
}
.filter-sep{width:1px;height:18px;background:rgba(255,255,255,0.07)}
.filter-count{
  margin-left:auto;
  font-family:'JetBrains Mono',monospace;font-size:11px;
  color:rgba(255,255,255,0.25);
}

/* ── EVENT PILLS ── */
.event-pills{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:24px}
.event-pill{
  display:inline-flex;align-items:center;gap:6px;
  padding:6px 12px;border-radius:8px;
  background:rgba(255,255,255,0.03);
  border:1px solid rgba(255,255,255,0.07);
  cursor:pointer;transition:all 0.15s;font-size:12px;font-weight:500;
  color:rgba(255,255,255,0.5);
}
.event-pill:hover{background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.8)}
.event-pill.active{
  background:rgba(16,185,129,0.1);
  border-color:rgba(16,185,129,0.3);
  color:#10B981;
}
.event-pill-dot{
  width:5px;height:5px;border-radius:50%;
  background:currentColor;flex-shrink:0;
}
.event-pill-urgency{
  font-family:'JetBrains Mono',monospace;font-size:9px;
  opacity:0.6;
}

/* ── LEAD CARD ── */
.lead-grid{display:flex;flex-direction:column;gap:10px}
.lead-card{
  background:rgba(255,255,255,0.025);
  border:1px solid rgba(255,255,255,0.06);
  border-radius:14px;
  overflow:hidden;
  transition:border-color 0.2s,box-shadow 0.2s;
  position:relative;
}
.lead-card::before{
  content:'';position:absolute;left:0;top:0;bottom:0;
  width:3px;background:var(--pc);border-radius:14px 0 0 14px;
}
.lead-card:hover{
  border-color:rgba(255,255,255,0.1);
  box-shadow:0 4px 24px rgba(0,0,0,0.3);
}
.lead-card-main{
  display:grid;
  grid-template-columns:1fr auto;
  gap:16px;
  padding:18px 20px 18px 22px;
  cursor:pointer;
}
.lc-left{}
.lc-top{display:flex;align-items:flex-start;gap:10px;margin-bottom:8px;flex-wrap:wrap}
.lc-name{
  font-size:16px;font-weight:700;
  color:#F8FAFC;letter-spacing:-0.01em;
  line-height:1.3;
}
.lc-type{
  font-family:'JetBrains Mono',monospace;font-size:10px;
  color:rgba(255,255,255,0.25);margin-top:3px;letter-spacing:0.04em;
}
.lc-badges{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.badge{
  display:inline-flex;align-items:center;gap:4px;
  padding:3px 9px;border-radius:5px;
  font-size:11px;font-weight:500;letter-spacing:0.02em;
  border:1px solid transparent;
}
.badge-priority{color:var(--pc);background:var(--pb);border-color:color-mix(in srgb,var(--pc) 30%,transparent)}
.badge-type{
  color:rgba(255,255,255,0.45);
  background:rgba(255,255,255,0.05);
  border-color:rgba(255,255,255,0.08);
}
.badge-fx{
  color:#818CF8;
  background:rgba(129,140,248,0.08);
  border-color:rgba(129,140,248,0.2);
}
.lc-meta{
  display:flex;gap:16px;flex-wrap:wrap;
  font-size:12px;color:rgba(255,255,255,0.35);
  margin-bottom:10px;
}
.lc-meta-item{display:flex;align-items:center;gap:4px}
.lc-meta-icon{font-size:11px}
.lc-hook{
  font-size:12px;line-height:1.6;
  color:rgba(255,255,255,0.5);
  padding:8px 12px;
  background:rgba(16,185,129,0.04);
  border:1px solid rgba(16,185,129,0.1);
  border-radius:7px;
  margin-bottom:0;
}
.lc-hook-label{
  font-family:'JetBrains Mono',monospace;font-size:9px;
  letter-spacing:0.12em;text-transform:uppercase;
  color:#10B981;margin-bottom:3px;
}

.lc-right{
  display:flex;flex-direction:column;align-items:flex-end;
  justify-content:space-between;gap:10px;flex-shrink:0;
}
.score-ring{
  display:flex;flex-direction:column;align-items:center;gap:3px;
  min-width:52px;
}
.score-ring-num{
  font-size:26px;font-weight:800;line-height:1;
  color:var(--pc);
}
.score-ring-label{
  font-family:'JetBrains Mono',monospace;font-size:8px;
  letter-spacing:0.12em;text-transform:uppercase;
  color:var(--pc);opacity:0.7;
}
.lc-expand-hint{
  font-family:'JetBrains Mono',monospace;font-size:10px;
  color:rgba(255,255,255,0.2);
  transition:color 0.15s;
}
.lead-card:hover .lc-expand-hint{color:rgba(255,255,255,0.4)}

/* ── LEAD EXPANDED ── */
.lead-card-expanded{
  border-top:1px solid rgba(255,255,255,0.05);
  padding:18px 20px 20px 22px;
  background:rgba(0,0,0,0.15);
}
.lce-grid{
  display:grid;grid-template-columns:1fr 1fr;
  gap:16px;margin-bottom:16px;
}
@media(max-width:600px){.lce-grid{grid-template-columns:1fr}}
.lce-block{}
.lce-label{
  font-family:'JetBrains Mono',monospace;font-size:9px;
  letter-spacing:0.14em;text-transform:uppercase;
  color:rgba(255,255,255,0.2);margin-bottom:5px;
}
.lce-value{
  font-size:13px;line-height:1.6;
  color:rgba(255,255,255,0.6);
}
.lce-director{
  display:inline-flex;align-items:center;gap:8px;
  padding:7px 12px;
  background:rgba(255,255,255,0.03);
  border:1px solid rgba(255,255,255,0.07);
  border-radius:8px;
}
.lce-dir-avatar{
  width:26px;height:26px;border-radius:50%;
  background:linear-gradient(135deg,rgba(16,185,129,0.3),rgba(99,102,241,0.3));
  border:1px solid rgba(16,185,129,0.2);
  display:grid;place-items:center;
  font-size:11px;font-weight:700;color:#10B981;flex-shrink:0;
}
.lce-dir-name{font-size:13px;font-weight:600;color:#F8FAFC}
.lce-dir-role{
  font-family:'JetBrains Mono',monospace;font-size:10px;
  color:#10B981;letter-spacing:0.04em;
}
.signal-list{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.signal-tag{
  font-family:'JetBrains Mono',monospace;font-size:9px;
  padding:2px 7px;border-radius:4px;
  background:rgba(99,102,241,0.07);
  border:1px solid rgba(99,102,241,0.15);
  color:rgba(129,140,248,0.7);
  letter-spacing:0.04em;
}
.opener-box{
  background:rgba(255,255,255,0.02);
  border:1px solid rgba(255,255,255,0.06);
  border-left:3px solid #10B981;
  border-radius:0 8px 8px 0;
  padding:12px 14px;margin-bottom:16px;
}
.opener-label{
  font-family:'JetBrains Mono',monospace;font-size:9px;
  letter-spacing:0.14em;text-transform:uppercase;
  color:#10B981;margin-bottom:5px;
}
.opener-text{
  font-size:13px;line-height:1.65;
  color:rgba(255,255,255,0.55);font-style:italic;
}
.action-row{display:flex;gap:8px;flex-wrap:wrap}
.action-btn{
  flex:1;min-width:100px;
  padding:9px 14px;border-radius:8px;
  font-size:12px;font-weight:600;
  cursor:pointer;transition:all 0.15s;
  font-family:'Inter',sans-serif;
  display:inline-flex;align-items:center;justify-content:center;gap:5px;
  border:none;
}
.action-call{background:rgba(16,185,129,0.12);color:#10B981;border:1px solid rgba(16,185,129,0.25)!important}
.action-call:hover{background:rgba(16,185,129,0.2)}
.action-email{background:rgba(99,102,241,0.1);color:#818CF8;border:1px solid rgba(99,102,241,0.2)!important}
.action-email:hover{background:rgba(99,102,241,0.18)}
.action-linkedin{background:rgba(14,165,233,0.1);color:#38BDF8;border:1px solid rgba(14,165,233,0.2)!important}
.action-linkedin:hover{background:rgba(14,165,233,0.18)}
.action-ch{background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.4);border:1px solid rgba(255,255,255,0.08)!important}
.action-ch:hover{background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.6)}

/* ── EVENT DETAIL PANEL ── */
.event-panel{
  background:rgba(255,255,255,0.02);
  border:1px solid rgba(255,255,255,0.06);
  border-radius:12px;
  padding:16px 20px;
  margin-bottom:20px;
}
.ep-grid{display:grid;grid-template-columns:2fr 1fr 1fr;gap:16px;flex-wrap:wrap}
@media(max-width:640px){.ep-grid{grid-template-columns:1fr}}
.ep-block{}
.ep-label{
  font-family:'JetBrains Mono',monospace;font-size:9px;
  letter-spacing:0.14em;text-transform:uppercase;
  color:rgba(255,255,255,0.2);margin-bottom:4px;
}
.ep-value{font-size:13px;font-weight:500;color:rgba(255,255,255,0.65);line-height:1.45}
.ep-pairs{display:flex;gap:5px;flex-wrap:wrap}
.ep-pair{
  font-family:'JetBrains Mono',monospace;font-size:11px;
  padding:3px 8px;border-radius:5px;
  background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.2);
  color:#10B981;
}

/* ── INDUSTRY ROWS ── */
.ind-list{display:flex;flex-direction:column;gap:6px}
.ind-row{
  display:flex;align-items:center;gap:10px;
  padding:10px 14px;border-radius:9px;
  background:rgba(255,255,255,0.02);
  border:1px solid rgba(255,255,255,0.05);
  cursor:pointer;transition:all 0.15s;
}
.ind-row:hover{background:rgba(255,255,255,0.045);border-color:rgba(16,185,129,0.2)}
.ind-row.expanded{background:rgba(16,185,129,0.05);border-color:rgba(16,185,129,0.25)}
.ind-num{
  font-family:'JetBrains Mono',monospace;font-size:10px;
  color:rgba(255,255,255,0.15);width:18px;flex-shrink:0;
}
.ind-name{flex:1;font-size:13px;font-weight:600;color:rgba(255,255,255,0.75)}
.ind-badge{
  font-family:'JetBrains Mono',monospace;font-size:9px;
  padding:2px 7px;border-radius:4px;
  background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.2);
  color:#10B981;flex-shrink:0;
}
.ind-chevron{
  font-size:10px;color:rgba(255,255,255,0.2);
  transition:transform 0.2s,color 0.15s;flex-shrink:0;
}
.ind-row.expanded .ind-chevron{transform:rotate(180deg);color:#10B981}

.ind-detail{
  margin:0 14px 8px;
  padding:12px 14px;
  background:rgba(0,0,0,0.2);
  border:1px solid rgba(255,255,255,0.05);
  border-top:none;
  border-radius:0 0 9px 9px;
}
.ind-detail-grid{
  display:grid;grid-template-columns:1fr 1fr;gap:12px;
  margin-bottom:12px;
}
@media(max-width:480px){.ind-detail-grid{grid-template-columns:1fr}}
.idd-label{
  font-family:'JetBrains Mono',monospace;font-size:9px;
  letter-spacing:0.12em;text-transform:uppercase;
  color:rgba(255,255,255,0.2);margin-bottom:3px;
}
.idd-value{font-size:12px;line-height:1.55;color:rgba(255,255,255,0.5)}
.ind-find-btn{
  width:100%;padding:8px;border-radius:7px;
  background:rgba(16,185,129,0.08);
  border:1px solid rgba(16,185,129,0.2);
  color:#10B981;font-size:12px;font-weight:600;
  cursor:pointer;transition:all 0.15s;font-family:'Inter',sans-serif;
  display:flex;align-items:center;justify-content:center;gap:6px;
}
.ind-find-btn:hover{background:rgba(16,185,129,0.15)}

/* ── NAV TABS ── */
.nav-tabs{display:flex;gap:2px;margin-bottom:24px}
.nav-tab{
  padding:7px 16px;border-radius:8px;font-size:13px;font-weight:500;
  cursor:pointer;transition:all 0.15s;
  background:transparent;border:none;
  color:rgba(255,255,255,0.35);font-family:'Inter',sans-serif;
}
.nav-tab:hover{color:rgba(255,255,255,0.6)}
.nav-tab.active{
  background:rgba(255,255,255,0.06);
  color:#F8FAFC;
}

/* ── BREADCRUMB ── */
.breadcrumb{
  display:flex;align-items:center;gap:6px;
  font-family:'JetBrains Mono',monospace;font-size:10px;
  color:rgba(255,255,255,0.2);letter-spacing:0.06em;
  margin-bottom:20px;
}
.breadcrumb .active{color:#10B981}
.breadcrumb-sep{color:rgba(255,255,255,0.1)}
.back-link{
  display:inline-flex;align-items:center;gap:5px;
  font-size:12px;color:rgba(255,255,255,0.35);
  background:none;border:none;cursor:pointer;
  font-family:'Inter',sans-serif;padding:0;
  transition:color 0.15s;margin-bottom:16px;
}
.back-link:hover{color:#10B981}

/* ── EMPTY STATE ── */
.empty-state{
  text-align:center;padding:64px 24px;
  color:rgba(255,255,255,0.2);
}
.empty-icon{font-size:36px;margin-bottom:12px}
.empty-title{font-size:16px;font-weight:600;color:rgba(255,255,255,0.3);margin-bottom:6px}
.empty-sub{
  font-family:'JetBrains Mono',monospace;font-size:11px;
  line-height:1.7;color:rgba(255,255,255,0.15);
}
.empty-sub code{color:rgba(16,185,129,0.5)}

/* ── RESPONSIVE ── */
@media(max-width:768px){
  .hero-title{font-size:28px}
  .stats-row{grid-template-columns:repeat(2,1fr)}
  .lce-grid{grid-template-columns:1fr}
  .ep-grid{grid-template-columns:1fr}
  .topbar-subtitle{display:none}
}
@media(max-width:480px){
  .hero-ctas{flex-direction:column}
  .btn-lg{width:100%;justify-content:center}
  .stats-row{grid-template-columns:repeat(2,1fr)}
  .action-row{flex-direction:column}
  .action-btn{min-width:unset}
}
`;

// ── LEAD CARD COMPONENT ────────────────────────────────────────────
function LeadCard({ lead }) {
  const [expanded, setExpanded] = useState(false);
  const pc = priorityColor(lead.priority);
  const pb = priorityBg(lead.priority);

  const initials = (lead.director_name || "")
    .split(" ").slice(0,2).map(w => w[0]||"").join("").toUpperCase() || "?";

  const callOpener = lead.suggested_next_step || "";

  return (
    <div className="lead-card" style={{ "--pc": pc, "--pb": pb }}>
      {/* MAIN ROW */}
      <div className="lead-card-main" onClick={() => setExpanded(e => !e)}>
        <div className="lc-left">
          <div className="lc-top">
            <div>
              <div className="lc-name">{lead.company_name}</div>
              <div className="lc-type">
                {lead.company_type && `${lead.company_type.toUpperCase()} `}
                {lead.company_number && `· CH ${lead.company_number}`}
                {lead.incorporated && ` · Est. ${lead.incorporated.slice(0,4)}`}
              </div>
            </div>
          </div>

          <div className="lc-badges">
            <span className="badge badge-priority" style={{"--pc":pc,"--pb":pb}}>
              ● {lead.priority}
            </span>
            {lead.sector && <span className="badge badge-type">{lead.sector.slice(0,40)}</span>}
            {lead.fx_exposure && <span className="badge badge-fx">{lead.fx_exposure}</span>}
          </div>

          <div className="lc-meta">
            {lead.address && (
              <span className="lc-meta-item">
                <span className="lc-meta-icon">📍</span>{lead.address.split(",").slice(-2).join(",").trim()}
              </span>
            )}
            {lead.director_name && (
              <span className="lc-meta-item">
                <span className="lc-meta-icon">👤</span>
                <strong style={{color:"rgba(255,255,255,0.55)"}}>{lead.director_name}</strong>
                <span style={{color:"rgba(255,255,255,0.25)"}}>· {lead.director_role}</span>
              </span>
            )}
          </div>

          {lead.fx_reason && (
            <div className="lc-hook">
              <div className="lc-hook-label">FX angle</div>
              {lead.fx_reason.slice(0,160)}{lead.fx_reason.length > 160 ? "…" : ""}
            </div>
          )}
        </div>

        <div className="lc-right">
          <div className="score-ring">
            <div className="score-ring-num">{lead.score}</div>
            <div className="score-ring-label">Score</div>
          </div>
          <div className="lc-expand-hint">{expanded ? "▲" : "▼"}</div>
        </div>
      </div>

      {/* EXPANDED */}
      {expanded && (
        <div className="lead-card-expanded">
          <div className="lce-grid">
            {lead.director_name && (
              <div className="lce-block">
                <div className="lce-label">Decision maker</div>
                <div className="lce-director">
                  <div className="lce-dir-avatar">{initials}</div>
                  <div>
                    <div className="lce-dir-name">{lead.director_name}</div>
                    <div className="lce-dir-role">{lead.director_role}</div>
                  </div>
                </div>
              </div>
            )}

            <div className="lce-block">
              <div className="lce-label">FX exposure</div>
              <div className="lce-value">{lead.fx_payment_logic || lead.fx_reason || "—"}</div>
            </div>

            {(lead.fx_payment_signals||lead.import_export_signals||[]).length > 0 && (
              <div className="lce-block">
                <div className="lce-label">Website signals</div>
                <div className="signal-list">
                  {(lead.fx_payment_signals||lead.import_export_signals||[]).slice(0,8).map(s => (
                    <span key={s} className="signal-tag">{s}</span>
                  ))}
                </div>
              </div>
            )}

            {(lead.scoring_reasons||[]).length > 0 && (
              <div className="lce-block">
                <div className="lce-label">Scoring rationale</div>
                <div className="lce-value" style={{fontSize:11,lineHeight:1.7}}>
                  {lead.scoring_reasons.slice(0,3).map((r,i) => (
                    <div key={i}>· {r}</div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {callOpener && (
            <div className="opener-box">
              <div className="opener-label">Suggested opener</div>
              <div className="opener-text">{callOpener}</div>
            </div>
          )}

          <div className="action-row">
            <button className="action-btn action-call">📞 Call</button>
            <button className="action-btn action-email">✉ Email</button>
            <button className="action-btn action-linkedin">💼 LinkedIn</button>
            {lead.website && (
              <a href={lead.website} target="_blank" rel="noreferrer"
                className="action-btn action-ch" style={{textDecoration:"none"}}>
                🌐 Website
              </a>
            )}
            {lead.company_number && (
              <a
                href={`https://find-and-update.company-information.service.gov.uk/company/${lead.company_number}`}
                target="_blank" rel="noreferrer"
                className="action-btn action-ch" style={{textDecoration:"none"}}>
                🏛 CH
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── EVENT PILL LIST ───────────────────────────────────────────────
function EventPills({ events, selectedId, onSelect }) {
  return (
    <div className="event-pills">
      <div
        className={`event-pill${!selectedId?" active":""}`}
        onClick={() => onSelect(null)}
      >
        <span className="event-pill-dot" />
        All events
      </div>
      {events.map(ev => (
        <div
          key={ev.id}
          className={`event-pill${selectedId===ev.id?" active":""}`}
          onClick={() => onSelect(selectedId===ev.id?null:ev.id)}
        >
          <span className="event-pill-dot" style={{color: urgencyColor(ev.urgency_score)}} />
          <span style={{maxWidth:160,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
            {ev.event_type||"Event"} · {ev.headline.slice(0,40)}…
          </span>
          <span className="event-pill-urgency">{ev.urgency_score}/10</span>
        </div>
      ))}
    </div>
  );
}

// ── INDUSTRIES VIEW ───────────────────────────────────────────────
function IndustriesView({ event, leads, onSelectIndustry, onBack }) {
  const [expandedIdx, setExpandedIdx] = useState(null);
  const sectors = event.who_pays_fx || event.affected_sectors || [];
  const leadsForEvent = leads.filter(l => l.event_id === event.id);

  return (
    <>
      <button className="back-link" onClick={onBack}>← Back to dashboard</button>
      <div className="breadcrumb">
        <span>Events</span><span className="breadcrumb-sep">›</span>
        <span className="active">Affected Industries</span><span className="breadcrumb-sep">›</span>
        <span>Companies</span>
      </div>

      <div className="event-panel">
        <div className="ep-grid">
          <div className="ep-block">
            <div className="ep-label">Trigger event</div>
            <div className="ep-value" style={{fontSize:14,fontWeight:600,color:"#F8FAFC"}}>{event.headline}</div>
          </div>
          <div className="ep-block">
            <div className="ep-label">Urgency</div>
            <div className="ep-value" style={{color:urgencyColor(event.urgency_score),fontWeight:700,fontSize:18}}>
              {event.urgency_score}<span style={{fontSize:12,opacity:0.5}}>/10</span>
            </div>
          </div>
          <div className="ep-block">
            <div className="ep-label">FX pairs</div>
            <div className="ep-pairs">
              {(event.currency_pairs||[]).map(p => <span key={p} className="ep-pair">{p}</span>)}
            </div>
          </div>
        </div>
        {event.fx_payment_logic && (
          <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid rgba(255,255,255,0.05)"}}>
            <div className="ep-label">Why these businesses pay FX</div>
            <div className="ep-value" style={{fontStyle:"italic",color:"rgba(255,255,255,0.4)"}}>
              {event.fx_payment_logic}
            </div>
          </div>
        )}
      </div>

      <div className="section-header">
        <div className="section-title">{sectors.length} industries affected</div>
        <div className="section-divider" />
        <div style={{fontSize:11,color:"rgba(255,255,255,0.25)",fontFamily:"'JetBrains Mono',monospace"}}>
          Expand for detail · click Find to see companies
        </div>
      </div>

      <div className="ind-list">
        {sectors.map((sector, i) => {
          const sectorLeads = leadsForEvent.filter(l =>
            (l.sector||"").toLowerCase().includes(sector.toLowerCase().slice(0,12))||
            sector.toLowerCase().includes((l.sector||"").toLowerCase().slice(0,12))
          );
          const isOpen = expandedIdx === i;
          return (
            <div key={sector}>
              <div
                className={`ind-row${isOpen?" expanded":""}`}
                onClick={() => setExpandedIdx(isOpen ? null : i)}
              >
                <span className="ind-num">{String(i+1).padStart(2,"0")}</span>
                <span className="ind-name">{sector}</span>
                {sectorLeads.length > 0 && (
                  <span className="ind-badge">{sectorLeads.length} found</span>
                )}
                <span className="ind-chevron">▼</span>
              </div>
              {isOpen && (
                <div className="ind-detail">
                  <div className="ind-detail-grid">
                    {event.fx_payment_logic && (
                      <div>
                        <div className="idd-label">Why they pay FX</div>
                        <div className="idd-value">{event.fx_payment_logic}</div>
                      </div>
                    )}
                    <div>
                      <div className="idd-label">Currency pairs</div>
                      <div className="ep-pairs" style={{marginTop:4}}>
                        {(event.currency_pairs||[]).map(p => <span key={p} className="ep-pair">{p}</span>)}
                      </div>
                    </div>
                    {event.summary && (
                      <div style={{gridColumn:"1/-1"}}>
                        <div className="idd-label">Event context</div>
                        <div className="idd-value">{event.summary}</div>
                      </div>
                    )}
                    {event.sales_angle && (
                      <div style={{gridColumn:"1/-1"}}>
                        <div className="idd-label">Sales angle</div>
                        <div className="idd-value" style={{fontStyle:"italic",color:"rgba(255,255,255,0.4)"}}>
                          "{event.sales_angle}"
                        </div>
                      </div>
                    )}
                  </div>
                  <button className="ind-find-btn" onClick={() => onSelectIndustry(sector)}>
                    Find companies in this sector →
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ── COMPANIES VIEW ────────────────────────────────────────────────
function CompaniesView({ event, industry, leads, onBack }) {
  const companies = leads.filter(l => l.event_id === event.id);
  return (
    <>
      <button className="back-link" onClick={onBack}>← Back to industries</button>
      <div className="breadcrumb">
        <span>Events</span><span className="breadcrumb-sep">›</span>
        <span>Industries</span><span className="breadcrumb-sep">›</span>
        <span className="active">{industry.slice(0,50)}</span>
      </div>

      <div className="event-panel" style={{marginBottom:20}}>
        <div className="ep-grid">
          <div className="ep-block">
            <div className="ep-label">Trigger event</div>
            <div className="ep-value" style={{fontSize:13}}>{event.headline}</div>
          </div>
          <div className="ep-block">
            <div className="ep-label">Industry</div>
            <div className="ep-value" style={{fontWeight:600,color:"#F8FAFC"}}>{industry.slice(0,50)}</div>
          </div>
          <div className="ep-block">
            <div className="ep-label">FX exposure</div>
            <div className="ep-pairs">
              {(event.currency_pairs||[]).map(p => <span key={p} className="ep-pair">{p}</span>)}
            </div>
          </div>
        </div>
      </div>

      <div className="section-header">
        <div className="section-title">{companies.length} companies</div>
        <div className="section-divider" />
        <div style={{fontSize:11,color:"rgba(255,255,255,0.25)",fontFamily:"'JetBrains Mono',monospace"}}>
          Sorted by FX relevance score
        </div>
      </div>

      {companies.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🏢</div>
          <div className="empty-title">No companies found yet</div>
          <div className="empty-sub">
            Run <code>python3 scripts/discover.py</code><br/>
            to search Companies House and find businesses in this sector
          </div>
        </div>
      ) : (
        <div className="lead-grid">
          {companies.map(lead => <LeadCard key={lead.id} lead={lead} />)}
        </div>
      )}
    </>
  );
}

// ── MAIN DASHBOARD VIEW ────────────────────────────────────────────
function DashboardView({ events, leads, onSelectEvent }) {
  const [priorityFilter, setPriorityFilter] = useState("ALL");
  const [selectedEventId, setSelectedEventId] = useState(null);

  const filtered = useMemo(() => {
    let base = selectedEventId ? leads.filter(l => l.event_id === selectedEventId) : leads;
    if (priorityFilter !== "ALL") base = base.filter(l => l.priority === priorityFilter);
    return base;
  }, [leads, selectedEventId, priorityFilter]);

  const hot  = leads.filter(l => l.priority==="HOT").length;
  const warm = leads.filter(l => l.priority==="WARM").length;

  return (
    <>
      {/* STATS */}
      <div className="stats-row" style={{marginBottom:28}}>
        {[
          {num:events.length, label:"Events detected",  color:"#10B981", delta:"Today"},
          {num:hot,           label:"Hot leads",         color:"#10B981", delta:"Score 80+"},
          {num:warm,          label:"Warm leads",        color:"#F59E0B", delta:"Score 60+"},
          {num:leads.length,  label:"Total companies",   color:"#6366F1", delta:"All events"},
        ].map(({num,label,color,delta}) => (
          <div className="stat-card" key={label}>
            <div className="stat-card-num" style={{color}}>{num}</div>
            <div className="stat-card-label">{label}</div>
            <div className="stat-card-delta" style={{background:`${color}15`,color}}>
              {delta}
            </div>
          </div>
        ))}
      </div>

      {/* EVENT FILTER PILLS */}
      {events.length > 0 && (
        <>
          <div className="section-header" style={{marginBottom:10}}>
            <div className="section-title">Filter by event</div>
            <div className="section-divider" />
          </div>
          <EventPills
            events={events}
            selectedId={selectedEventId}
            onSelect={setSelectedEventId}
          />
        </>
      )}

      {/* PRIORITY FILTER + LEADS */}
      <div className="section-header" style={{marginBottom:12}}>
        <div className="section-title">Lead cards</div>
        <div className="section-divider" />
      </div>

      <div className="filter-bar">
        <span className="filter-label">Priority</span>
        {["ALL","HOT","WARM","QUEUE"].map(f => (
          <button
            key={f}
            className={`filter-btn${priorityFilter===f?" active":""}`}
            onClick={() => setPriorityFilter(f)}
          >
            {f}
          </button>
        ))}
        <span className="filter-sep" />
        {events.length > 0 && (
          <>
            <span className="filter-label" style={{marginLeft:8}}>Drill into event</span>
            {events.slice(0,3).map(ev => (
              <button
                key={ev.id}
                className="filter-btn"
                onClick={() => onSelectEvent(ev)}
                style={{maxWidth:180,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}
              >
                {ev.event_type} ↗
              </button>
            ))}
          </>
        )}
        <span className="filter-count">{filtered.length} leads</span>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📡</div>
          <div className="empty-title">No leads yet</div>
          <div className="empty-sub">
            Run <code>python3 scripts/ingest.py</code> then <code>python3 scripts/discover.py</code><br/>
            to populate the dashboard with real market-driven leads
          </div>
        </div>
      ) : (
        <div className="lead-grid">
          {filtered.map(lead => <LeadCard key={lead.id} lead={lead} />)}
        </div>
      )}
    </>
  );
}

// ── ROOT APP ──────────────────────────────────────────────────────
export default function App() {
  const [events, setEvents]  = useState([]);
  const [leads,  setLeads]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [view, setView]      = useState("dashboard");
  const [selEvent, setSelEvent]    = useState(null);
  const [selIndustry, setSelIndustry] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetchData();
      setEvents(d.events); setLeads(d.leads);
      setLastRefresh(new Date());
    } catch(e) { console.error(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const hot  = leads.filter(l => l.priority==="HOT").length;
  const warm = leads.filter(l => l.priority==="WARM").length;

  return (
    <>
      <style>{STYLES}</style>

      {/* TOP BAR */}
      <div className="topbar">
        <div className="wrap" style={{display:"flex",alignItems:"center",justifyContent:"space-between",width:"100%"}}>
          <div className="topbar-left">
            <div className="topbar-logo">
              <div className="topbar-logo-mark">FX</div>
              Universal Partners
            </div>
            <div className="topbar-divider" />
            <div className="topbar-subtitle">FX Discovery Engine</div>
          </div>
          <div className="topbar-right">
            <div className="live-badge">
              <div className="live-dot" />
              LIVE
            </div>
            {lastRefresh && (
              <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"rgba(255,255,255,0.2)"}}>
                {timeAgo(lastRefresh)}
              </span>
            )}
            <button className="btn-sm btn-ghost" onClick={loadData} disabled={loading}>
              {loading?"…":"↻ Refresh"}
            </button>
          </div>
        </div>
      </div>

      {/* HERO */}
      {view === "dashboard" && (
        <div className="hero">
          <div className="wrap">
            <div className="hero-eyebrow">
              <span>●</span> Event-driven FX sales intelligence
            </div>
            <h1 className="hero-title">
              Find UK businesses with<br/>
              <span>real FX exposure</span>
            </h1>
            <p className="hero-sub">
              Any world event — tariffs, rate decisions, currency moves, geopolitical shocks — 
              mapped to the specific UK companies writing cheques in foreign currency. 
              Every lead comes with a reason to call.
            </p>
            <div className="hero-ctas">
              <button
                className="btn-lg primary"
                onClick={() => { /* trigger discovery */ }}
              >
                ⚡ Run Discovery
              </button>
              <button
                className="btn-lg secondary"
                onClick={() => document.querySelector('.lead-grid')?.scrollIntoView({behavior:'smooth'})}
              >
                View {hot + warm} Priority Leads →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MAIN CONTENT */}
      <div className="wrap" style={{paddingTop:32,paddingBottom:80}}>

        {view === "dashboard" && (
          <DashboardView
            events={events}
            leads={leads}
            onSelectEvent={ev => { setSelEvent(ev); setView("industries"); }}
          />
        )}

        {view === "industries" && selEvent && (
          <IndustriesView
            event={selEvent}
            leads={leads}
            onSelectIndustry={ind => { setSelIndustry(ind); setView("companies"); }}
            onBack={() => { setView("dashboard"); setSelEvent(null); }}
          />
        )}

        {view === "companies" && selEvent && selIndustry && (
          <CompaniesView
            event={selEvent}
            industry={selIndustry}
            leads={leads}
            onBack={() => setView("industries")}
          />
        )}
      </div>
    </>
  );
}
