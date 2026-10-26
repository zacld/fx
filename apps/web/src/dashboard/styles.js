// The dashboard's stylesheet.
// (Split out of App.jsx; no behaviour change.)
import { copy, urg } from "./format.js";

// ─── CSS ──────────────────────────────────────────────────────────
export const CSS = `
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
.view-tab.active-new{background:rgba(251,191,36,.12);color:#FBB724}
.view-tab.active-lk{background:rgba(99,102,241,.15);color:#818CF8}

/* COMPANY LOOKUP */
.lookup-wrap{max-width:1500px;margin:0 auto;padding:40px 40px 80px}
.lookup-hero{margin-bottom:32px}
.lookup-hero-title{font-size:22px;font-weight:800;color:rgba(255,255,255,.9);margin-bottom:6px}
.lookup-hero-sub{font-size:13px;color:rgba(255,255,255,.35)}
.lookup-row{display:flex;gap:10px;margin-bottom:24px}
.lookup-input{flex:1;padding:12px 16px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:10px;color:rgba(255,255,255,.85);font-size:15px;font-family:'Inter',sans-serif;outline:none;transition:all .15s}
.lookup-input:focus{border-color:rgba(99,102,241,.5);background:rgba(99,102,241,.05)}
.lookup-input::placeholder{color:rgba(255,255,255,.2)}
.lookup-btn{padding:12px 24px;background:rgba(99,102,241,.18);border:1px solid rgba(99,102,241,.4);border-radius:10px;color:#818CF8;font-size:14px;font-weight:700;cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s;white-space:nowrap}
.lookup-btn:hover{background:rgba(99,102,241,.28);border-color:rgba(99,102,241,.6)}
.lookup-btn:disabled{opacity:.4;cursor:not-allowed}
.lookup-suggestions{background:rgba(15,15,20,1);border:1px solid rgba(255,255,255,.1);border-radius:10px;overflow:hidden;margin-bottom:20px}
.lookup-sug-item{padding:12px 16px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.05);transition:background .1s;display:flex;align-items:center;gap:12px}
.lookup-sug-item:last-child{border-bottom:none}
.lookup-sug-item:hover{background:rgba(99,102,241,.08)}
.lookup-sug-name{font-size:14px;font-weight:600;color:rgba(255,255,255,.8)}
.lookup-sug-meta{font-size:11px;color:rgba(255,255,255,.3);font-family:'JetBrains Mono',monospace}
.lookup-sug-status{font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;text-transform:uppercase;letter-spacing:.05em;flex-shrink:0}
.lookup-sug-status.active{background:rgba(16,185,129,.12);color:#10B981;border:1px solid rgba(16,185,129,.2)}
.lookup-sug-status.dissolved{background:rgba(239,68,68,.1);color:#F87171;border:1px solid rgba(239,68,68,.2)}
.lookup-sug-status.other{background:rgba(255,255,255,.05);color:rgba(255,255,255,.3);border:1px solid rgba(255,255,255,.08)}
.lookup-card{background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.08);border-radius:14px;overflow:hidden}
.lookup-card-head{padding:20px 24px;border-bottom:1px solid rgba(255,255,255,.06);display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap}
.lookup-card-name{font-size:20px;font-weight:800;color:rgba(255,255,255,.9);flex:1}
.lookup-card-num{font-family:'JetBrains Mono',monospace;font-size:11px;color:rgba(255,255,255,.3);margin-top:3px}
.lookup-card-badges{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.lookup-badge{font-size:10px;font-weight:700;padding:3px 9px;border-radius:5px;text-transform:uppercase;letter-spacing:.05em}
.lookup-card-body{display:grid;grid-template-columns:1fr 1fr 1fr;gap:0;border-bottom:1px solid rgba(255,255,255,.06)}
@media(max-width:900px){.lookup-card-body{grid-template-columns:1fr 1fr}}
@media(max-width:600px){.lookup-card-body{grid-template-columns:1fr}.lookup-wrap{padding:20px 16px 60px}}
.lookup-panel{padding:20px 24px;border-right:1px solid rgba(255,255,255,.06)}
.lookup-panel:last-child{border-right:none}
.lookup-panel-title{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.25);margin-bottom:12px}
.lookup-dm{padding:10px 12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:8px;margin-bottom:8px}
.lookup-dm:last-child{margin-bottom:0}
.lookup-dm-name{font-size:14px;font-weight:700;color:rgba(255,255,255,.85)}
.lookup-dm-role{font-size:11px;color:rgba(255,255,255,.35);margin-top:2px}
.lookup-dm-fd{border-color:rgba(16,185,129,.2);background:rgba(16,185,129,.04)}
.lookup-dm-fd .lookup-dm-name{color:#10B981}
.lookup-rev-val{font-size:22px;font-weight:800;color:rgba(255,255,255,.8);margin-bottom:4px}
.lookup-rev-type{font-size:11px;color:rgba(255,255,255,.3);margin-bottom:8px}
.lookup-rev-note{font-size:11px;color:rgba(255,255,255,.25);line-height:1.5}
.lookup-fx-score{font-size:38px;font-weight:900;line-height:1;margin-bottom:4px}
.lookup-fx-label{font-size:12px;font-weight:600;margin-bottom:10px}
.lookup-fx-bar{height:4px;background:rgba(255,255,255,.07);border-radius:2px;margin-bottom:12px;overflow:hidden}
.lookup-fx-fill{height:100%;border-radius:2px;transition:width .4s}
.lookup-fx-reason{font-size:11px;color:rgba(255,255,255,.3);line-height:1.5}
.lookup-sic{font-size:10px;font-family:'JetBrains Mono',monospace;color:rgba(255,255,255,.25);margin-top:6px}
.lookup-card-foot{padding:16px 24px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.lookup-link-btn{padding:7px 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid;font-family:'Inter',sans-serif;text-decoration:none;display:inline-flex;align-items:center;gap:5px;transition:all .15s}
.lookup-empty{padding:60px 24px;text-align:center;color:rgba(255,255,255,.2);font-size:14px}
.lookup-err{padding:12px 16px;background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.2);border-radius:8px;color:#F87171;font-size:13px;margin-bottom:16px}
.lookup-loading{display:flex;align-items:center;gap:10px;color:rgba(255,255,255,.3);font-size:13px;padding:16px 0}
.unlock-bar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:12px 16px 0;padding:10px 14px;border:1px solid rgba(245,158,11,.35);background:rgba(245,158,11,.08);border-radius:10px;color:#FCD34D;font-size:13px}
.unlock-in{flex:1 1 180px;min-width:0;max-width:260px;padding:6px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:rgba(0,0,0,.3);color:#F8FAFC;font-size:13px}
.unlock-err{color:#FCA5A5}
.lookup-spin{width:16px;height:16px;border:2px solid rgba(99,102,241,.2);border-top-color:#818CF8;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
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

/* FX INTELLIGENCE CARD */
.fxi-card{border-radius:10px;padding:14px 16px;margin-bottom:12px;border:1px solid}
.fxi-card-a{background:rgba(16,185,129,.06);border-color:rgba(16,185,129,.25)}
.fxi-card-b{background:rgba(245,158,11,.05);border-color:rgba(245,158,11,.2)}
.fxi-card-c{background:rgba(99,102,241,.05);border-color:rgba(99,102,241,.18)}
.fxi-card-d{background:rgba(71,85,105,.05);border-color:rgba(71,85,105,.18)}
.fxi-header{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}
.fxi-grade{font-size:18px;font-weight:900;font-family:'JetBrains Mono',monospace;width:28px;text-align:center}
.fxi-title{font-size:11px;font-weight:700;color:rgba(255,255,255,.7);flex:1}
.fxi-currencies{display:flex;gap:4px;flex-wrap:wrap}
.fxi-cur{font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.5);font-family:'JetBrains Mono',monospace}
.fxi-row{display:flex;gap:6px;margin-bottom:6px;align-items:baseline}
.fxi-lbl{font-family:'JetBrains Mono',monospace;font-size:9px;color:rgba(255,255,255,.25);text-transform:uppercase;letter-spacing:.06em;flex-shrink:0;width:110px}
.fxi-val{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600}
.fxi-evidence{margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.05)}
.fxi-ev-item{font-size:11px;color:rgba(255,255,255,.35);margin-bottom:3px;padding-left:12px;position:relative}
.fxi-ev-item::before{content:"·";position:absolute;left:0;color:rgba(255,255,255,.2)}
.fxi-angle{margin-top:10px;padding:10px 12px;background:rgba(0,0,0,.2);border-radius:7px;font-size:12px;color:rgba(255,255,255,.55);line-height:1.6;font-style:italic;cursor:pointer}
.fxi-angle:hover{color:rgba(255,255,255,.75)}
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

/* DAILY CALL LIST SECTIONS */
.cl-section{margin-bottom:24px}
.cl-section-hdr{display:flex;align-items:center;gap:10px;padding:12px 0 10px;border-bottom:1px solid rgba(255,255,255,.06);margin-bottom:10px;cursor:pointer}
.cl-section-title{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.cl-section-count{font-family:'JetBrains Mono',monospace;font-size:11px;padding:2px 8px;border-radius:5px;font-weight:700}
.cl-section-desc{font-size:11px;color:rgba(255,255,255,.25);flex:1}
.cl-toggle{font-size:10px;color:rgba(255,255,255,.2);margin-left:auto}

/* FOLLOW-UP DUE BANNER */
.fu-banner{background:rgba(249,115,22,.05);border:1px solid rgba(249,115,22,.2);border-left:3px solid rgba(249,115,22,.5);border-radius:0 10px 10px 0;margin-bottom:20px;overflow:hidden}
.fu-banner-hdr{display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer}
.fu-banner-title{font-size:12px;font-weight:700;color:#F97316;letter-spacing:.04em}
.fu-banner-count{font-family:'JetBrains Mono',monospace;font-size:11px;padding:2px 8px;border-radius:5px;background:rgba(249,115,22,.12);border:1px solid rgba(249,115,22,.3);color:#F97316;font-weight:700}
.fu-banner-hint{font-size:11px;color:rgba(249,115,22,.5);flex:1}
.fu-banner-tog{font-size:10px;color:rgba(249,115,22,.4)}
.fu-leads{padding:0 14px 12px}
.fu-row{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:7px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.05);margin-bottom:5px;cursor:pointer;transition:all .15s}
.fu-row:hover{background:rgba(249,115,22,.05);border-color:rgba(249,115,22,.2)}
.fu-name{font-size:13px;font-weight:600;color:#F8FAFC;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fu-meta{font-family:'JetBrains Mono',monospace;font-size:10px;color:rgba(255,255,255,.3);white-space:nowrap}
.fu-overdue{color:#F87171}
.fu-channel{font-family:'JetBrains Mono',monospace;font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);color:rgba(255,255,255,.3)}

/* CRM TOUCH INFO ON CARD */
.crm-touch{font-family:'JetBrains Mono',monospace;font-size:10px;display:inline-flex;align-items:center;gap:3px}
.crm-fu-due{color:#F97316}
.crm-fu-soon{color:#F59E0B}
.crm-touched{color:#38BDF8}
`;
