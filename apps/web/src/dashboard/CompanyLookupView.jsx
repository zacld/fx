// The Lookup tab: one company from Companies House.
// (Split out of App.jsx; no behaviour change.)
import { useState, useCallback, useRef } from "react";

// ─── COMPANY LOOKUP ──────────────────────────────────────────────
export const CH_API = "https://api.company-information.service.gov.uk";
export const CH_KEY = (typeof import.meta !== "undefined" && import.meta.env?.VITE_COMPANIES_HOUSE_API_KEY) || "";

export function chAuth() {
  return "Basic " + btoa(CH_KEY + ":");
}

export async function chGet(path) {
  if (!CH_KEY) return null;
  try {
    const r = await fetch(CH_API + path, { headers: { Authorization: chAuth(), Accept: "application/json" } });
    return r.ok ? r.json() : null;
  } catch { return null; }
}

// SIC → FX likelihood (port of scoring.ts sicTier)
export const _SIC_T1 = ["4671","4672","4673","4674","4675","4676","4677","4631","4632","4633","4634","4635","4636","4637","4638","4639","4641","4642","4643","4644","4645","4646","4647","4648","4649","4610","4620","4630","4650","4660","4669","5010","5020","5110","5121","5122"];
export const _SIC_T2_PFX = ["10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32","33","46","47"];
export const _SIC_T3_PFX = ["491","492","493","494","521","522","523","524"];

export function sicFxScore(sicCodes) {
  if (!sicCodes || sicCodes.length === 0) return { score: 0, tier: 0, label: "No SIC data", color: "#475569" };
  const codes = sicCodes.map(s => String(s).replace(/\s/g,""));
  let tier = 0;
  let matchedCode = codes[0];
  for (const c of codes) {
    if (_SIC_T1.some(t => c.startsWith(t) || t.startsWith(c.slice(0,4)))) { tier = 1; matchedCode = c; break; }
    if (_SIC_T2_PFX.some(p => c.startsWith(p))) { tier = Math.max(tier, 2); matchedCode = c; }
    if (_SIC_T3_PFX.some(p => c.startsWith(p))) { tier = Math.max(tier, 3); }
  }
  const map = {
    1: { score: 78, label: "Wholesaler / Importer — strong FX likelihood", color: "#10B981" },
    2: { score: 52, label: "Manufacturer — moderate FX likelihood", color: "#F59E0B" },
    3: { score: 30, label: "Retail / Logistics — some FX exposure", color: "#818CF8" },
    0: { score: 10, label: "Low FX signal from SIC", color: "#475569" },
  };
  return { ...map[tier], tier, matchedCode };
}

export function revenueEstimate(profile) {
  const accs = profile?.accounts;
  const t = accs?.last_accounts?.type || "";
  if (t === "micro-entity" || t === "micro") return { label: "Under £632k", band: "micro", note: "Micro-entity accounts filed" };
  if (t === "total-exemption-small" || t === "small") return { label: "£632k – £10.2m", band: "small", note: "Small company accounts (full turnover not disclosed)" };
  if (t === "total-exemption-full") return { label: "£1m – £10.2m", band: "medium", note: "Total-exemption full accounts" };
  if (t === "full" || t === "group" || t === "audit-exemption-subsidiary") return { label: "Likely £10m+", band: "large", note: "Full / large company accounts filed" };
  if (t) return { label: "Filed: " + t, band: "unknown", note: "Accounts on record — type " + t };
  return { label: "Not disclosed", band: "unknown", note: "No accounts type available" };
}

export function cleanChName(raw) {
  if (!raw) return "";
  const s = raw.trim();
  if (!s.includes(",")) return s.replace(/\b\w/g, c => c.toUpperCase());
  const comma = s.indexOf(",");
  const surname = s.slice(0, comma).trim();
  const forename = s.slice(comma + 1).trim();
  return (forename + " " + surname).replace(/\b\w/g, c => c.toUpperCase()).replace(/\s+/g, " ").trim();
}

export function isFd(officer) {
  const occ = (officer.occupation || "").toLowerCase();
  const role = (officer.officer_role || "").toLowerCase();
  return occ.includes("finance") || occ.includes("chief financial") || occ.includes("cfo") ||
    occ.includes("accounts director") || occ.includes("financial director") ||
    role.includes("finance");
}

export function CompanyLookupView() {
  const [query, setQuery]       = useState("");
  const [suggestions, setSugg]  = useState([]);
  const [selected, setSelected] = useState(null);
  const [profile, setProfile]   = useState(null);
  const [officers, setOfficers] = useState([]);
  const [loading, setLoading]   = useState(false);
  const [cardLoad, setCardLoad] = useState(false);
  const [error, setError]       = useState("");
  const inputRef = useRef(null);

  const noKey = !CH_KEY;

  const search = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setLoading(true); setError(""); setSugg([]); setSelected(null); setProfile(null); setOfficers([]);
    const data = await chGet(`/search/companies?q=${encodeURIComponent(q)}&items_per_page=8`);
    if (!data) { setError(noKey ? "Add VITE_COMPANIES_HOUSE_API_KEY to your .env file and rebuild." : "Companies House API error — check your API key."); }
    else setSugg(data.items || []);
    setLoading(false);
  }, [query, noKey]);

  const pick = useCallback(async (item) => {
    setSelected(item); setSugg([]); setCardLoad(true); setProfile(null); setOfficers([]);
    const [p, o] = await Promise.all([
      chGet(`/company/${item.company_number}`),
      chGet(`/company/${item.company_number}/officers?items_per_page=50`),
    ]);
    setProfile(p);
    setOfficers(o?.items || []);
    setCardLoad(false);
  }, []);

  const reset = () => { setSugg([]); setSelected(null); setProfile(null); setOfficers([]); setError(""); setQuery(""); inputRef.current?.focus(); };

  // Build decision-maker list: active officers, FDs first then MD/CEO, then all directors
  const activeOfficers = officers.filter(o => !o.resigned_on);
  const fds  = activeOfficers.filter(isFd);
  const dirs = activeOfficers.filter(o => !isFd(o) && (o.officer_role||"").toLowerCase().includes("director"));
  const dms  = [...fds, ...dirs].slice(0, 8);

  const sicCodes = profile?.sic_codes || [];
  const fxInfo   = sicFxScore(sicCodes);
  const revInfo  = revenueEstimate(profile);
  const website  = profile?.links?.self ? null : null; // CH profile doesn't expose website; we'll link to CH page

  const statusCls = s => s === "active" ? "active" : s === "dissolved" ? "dissolved" : "other";
  const statusLabel = s => s ? s.replace(/-/g," ").replace(/\b\w/g, c=>c.toUpperCase()) : "Unknown";

  return (
    <div className="lookup-wrap">
      <div className="lookup-hero">
        <div className="lookup-hero-title">Company Intelligence Lookup</div>
        <div className="lookup-hero-sub">Finance director names · Revenue estimate · FX likelihood · From Companies House</div>
      </div>

      {noKey && (
        <div className="lookup-err">
          No API key found. Add <code>VITE_COMPANIES_HOUSE_API_KEY=your_key</code> to <code>apps/web/.env</code> (or root <code>.env</code>) and run <code>npm run build</code>.
        </div>
      )}

      <div className="lookup-row">
        <input
          ref={inputRef}
          className="lookup-input"
          placeholder="Type a company name, e.g. Alpine Machinery Supplies..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === "Enter" && search()}
          disabled={noKey}
        />
        <button className="lookup-btn" onClick={search} disabled={noKey || loading || !query.trim()}>
          {loading ? "Searching…" : "Look up →"}
        </button>
        {selected && (
          <button className="lookup-btn" onClick={reset} style={{background:"rgba(255,255,255,.04)",borderColor:"rgba(255,255,255,.1)",color:"rgba(255,255,255,.4)"}}>
            ← New search
          </button>
        )}
      </div>

      {error && <div className="lookup-err">{error}</div>}

      {loading && (
        <div className="lookup-loading">
          <div className="lookup-spin"/>
          Searching Companies House…
        </div>
      )}

      {suggestions.length > 0 && !selected && (
        <div className="lookup-suggestions">
          {suggestions.map(s => (
            <div className="lookup-sug-item" key={s.company_number} onClick={() => pick(s)}>
              <div style={{flex:1}}>
                <div className="lookup-sug-name">{s.title}</div>
                <div className="lookup-sug-meta">{s.company_number} · {(s.description_identifier||[s.company_type]).join(" · ")}</div>
              </div>
              <span className={`lookup-sug-status ${statusCls(s.company_status)}`}>{statusLabel(s.company_status)}</span>
            </div>
          ))}
        </div>
      )}

      {cardLoad && (
        <div className="lookup-loading">
          <div className="lookup-spin"/>
          Loading company profile and officers…
        </div>
      )}

      {profile && !cardLoad && (
        <div className="lookup-card">
          {/* Header */}
          <div className="lookup-card-head">
            <div style={{flex:1}}>
              <div className="lookup-card-name">{profile.company_name || selected?.title}</div>
              <div className="lookup-card-num">Companies House #{selected?.company_number} · Incorporated {profile.date_of_creation || "—"}</div>
              <div className="lookup-card-badges">
                <span className="lookup-badge" style={{background:`rgba(16,185,129,.1)`,color:"#10B981",border:"1px solid rgba(16,185,129,.2)"}}>
                  {statusLabel(profile.company_status)}
                </span>
                {(profile.sic_codes||[]).slice(0,3).map(c => (
                  <span key={c} className="lookup-badge" style={{background:"rgba(255,255,255,.04)",color:"rgba(255,255,255,.4)",border:"1px solid rgba(255,255,255,.08)"}}>{c}</span>
                ))}
              </div>
            </div>
            <div style={{textAlign:"right",flexShrink:0}}>
              <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"rgba(255,255,255,.2)"}}>
                {profile.registered_office_address ? [
                  profile.registered_office_address.locality,
                  profile.registered_office_address.region,
                  profile.registered_office_address.postal_code,
                ].filter(Boolean).join(", ") : ""}
              </div>
            </div>
          </div>

          {/* Three panels */}
          <div className="lookup-card-body">
            {/* FDs / Directors */}
            <div className="lookup-panel">
              <div className="lookup-panel-title">Finance Director & Officers</div>
              {dms.length === 0 ? (
                <div style={{color:"rgba(255,255,255,.2)",fontSize:12}}>No active directors found</div>
              ) : dms.map((o, i) => {
                const fd = isFd(o);
                return (
                  <div key={i} className={`lookup-dm${fd?" lookup-dm-fd":""}`}>
                    <div className="lookup-dm-name">
                      {fd && <span style={{fontSize:10,fontWeight:700,marginRight:6,color:"#10B981"}}>FD</span>}
                      {cleanChName(o.name)}
                    </div>
                    <div className="lookup-dm-role">{o.officer_role?.replace(/-/g," ")} {o.occupation ? `· ${o.occupation}` : ""}</div>
                  </div>
                );
              })}
            </div>

            {/* Revenue estimate */}
            <div className="lookup-panel">
              <div className="lookup-panel-title">Estimated Revenue</div>
              <div className="lookup-rev-val" style={{
                color: revInfo.band==="large"?"#10B981":revInfo.band==="medium"?"#F59E0B":revInfo.band==="small"?"#818CF8":"rgba(255,255,255,.5)"
              }}>{revInfo.label}</div>
              <div className="lookup-rev-type">{revInfo.note}</div>
              <div className="lookup-rev-note">
                {profile.accounts?.last_accounts?.period_end_on && (
                  <>Year end: {profile.accounts.last_accounts.period_end_on}<br/></>
                )}
                {profile.accounts?.overdue && <span style={{color:"#F87171"}}>⚠ Accounts overdue</span>}
                {revInfo.band === "large" && "Large company — strong candidate for FX flows."}
                {revInfo.band === "medium" && "Mid-size — worth a call if SIC matches."}
                {revInfo.band === "small" && "Small company — check FX signals on website."}
                {revInfo.band === "micro" && "Micro-entity — likely too small for FX sales."}
              </div>
            </div>

            {/* FX Likelihood */}
            <div className="lookup-panel">
              <div className="lookup-panel-title">FX Likelihood</div>
              <div className="lookup-fx-score" style={{color:fxInfo.color}}>{fxInfo.score}</div>
              <div className="lookup-fx-label" style={{color:fxInfo.color}}>{fxInfo.score>=70?"Strong FX evidence":fxInfo.score>=45?"Moderate FX evidence":fxInfo.score>=25?"Some FX exposure":"Weak signal"}</div>
              <div className="lookup-fx-bar">
                <div className="lookup-fx-fill" style={{width:fxInfo.score+"%",background:fxInfo.color}}/>
              </div>
              <div className="lookup-fx-reason">{fxInfo.label}</div>
              {sicCodes.length > 0 && (
                <div className="lookup-sic">SIC: {sicCodes.join(", ")}</div>
              )}
            </div>
          </div>

          {/* Footer actions */}
          <div className="lookup-card-foot">
            <a
              className="lookup-link-btn"
              href={`https://find-and-update.company-information.service.gov.uk/company/${selected?.company_number}`}
              target="_blank" rel="noreferrer"
              style={{background:"rgba(99,102,241,.1)",borderColor:"rgba(99,102,241,.3)",color:"#818CF8"}}
            >
              Companies House →
            </a>
            <a
              className="lookup-link-btn"
              href={`https://www.google.com/search?q=${encodeURIComponent((profile.company_name||"")+" phone number")}`}
              target="_blank" rel="noreferrer"
              style={{background:"rgba(245,158,11,.08)",borderColor:"rgba(245,158,11,.25)",color:"#F59E0B"}}
            >
              Find phone →
            </a>
            <a
              className="lookup-link-btn"
              href={`https://www.google.com/search?q=${encodeURIComponent((profile.company_name||"")+" site:linkedin.com")}`}
              target="_blank" rel="noreferrer"
              style={{background:"rgba(56,189,248,.07)",borderColor:"rgba(56,189,248,.2)",color:"#38BDF8"}}
            >
              LinkedIn →
            </a>
            <a
              className="lookup-link-btn"
              href={`https://www.google.com/search?q=${encodeURIComponent(profile.company_name||"")}`}
              target="_blank" rel="noreferrer"
              style={{background:"rgba(255,255,255,.04)",borderColor:"rgba(255,255,255,.1)",color:"rgba(255,255,255,.4)"}}
            >
              Google →
            </a>
          </div>
        </div>
      )}

      {!loading && !cardLoad && !selected && !error && suggestions.length === 0 && (
        <div className="lookup-empty">
          Enter a company name above and press Enter or click Look up
        </div>
      )}
    </div>
  );
}
