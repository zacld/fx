// The filter bar above the lead lists.
// (Split out of App.jsx; no behaviour change.)
import { useMemo } from "react";
import { CRM_COLORS, CRM_LABELS, CRM_STATUSES } from "./crm.js";
import { BLANK_FILTERS } from "./filters.js";
import { gradeBg, gradeColor, gradeTip } from "./format.js";

// ─── FILTER BAR ──────────────────────────────────────────────────
export function FilterBar({ filters, setFilters, leads, events, filteredCount, crmState }) {
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
    filters.hasWebsite||filters.hasDirector||filters.minScore>0||filters.minRevenue>0||
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

      <div className="fb-group">
        <span className="fb-label">Revenue</span>
        <select
          className="fb-select"
          value={filters.minRevenue}
          onChange={e=>set("minRevenue",Number(e.target.value))}
          title="Confirmed turnover from CH iXBRL accounts only — unknown companies move to Unverified section"
          style={filters.minRevenue>0?{borderColor:"rgba(16,185,129,.35)",color:"#10B981"}:{}}
        >
          <option value={0}>Any</option>
          <option value={1000000}>£1m+</option>
          <option value={2000000}>£2m+</option>
          <option value={5000000}>£5m+</option>
          <option value={10000000}>£10m+</option>
          <option value={25000000}>£25m+</option>
        </select>
      </div>

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
