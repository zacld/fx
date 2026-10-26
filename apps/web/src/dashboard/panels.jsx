// Lead card panels: message ingredients, call intelligence, decision makers, call opener.
// (Split out of App.jsx; no behaviour change.)
import { useState, useMemo } from "react";
import { isPlausibleFirstNameClient } from "./filters.js";
import { copy, crBg, crColor, fxLikColor, fxLikLabel, gradeBg, gradeColor, gradeTip, tierColor, today } from "./format.js";
import { CopyBtn } from "./parts.jsx";

// ─── MESSAGE AMMO PANEL ──────────────────────────────────────────
export function MessageAmmoPanel({ ingredients, outreach }) {
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
export function CallIntelligencePanel({ lead }) {
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
export function EmailPatterns({ emails }) {
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
export function DMEmailCopy({ email }) {
  const [c, setC] = useState(false);
  return (
    <button className={`dm-copy-btn${c?" copied":""}`} onClick={()=>{copy(email);setC(true);setTimeout(()=>setC(false),2000);}}>
      {c?"✓":"Copy"}
    </button>
  );
}

export function DMCard({ dm, co }) {
  const initials    = [dm.first_name, dm.last_name].filter(Boolean).map(w=>(w||"")[0]||"").join("").toUpperCase() || "?";
  const verifiedEmail = dm.email_verified && dm.email ? dm.email : null;
  const guessedTop  = !verifiedEmail && dm.email_guesses?.length ? dm.email_guesses[0]?.email : null;
  const bestEmail   = verifiedEmail || (dm.email_candidate || null) || guessedTop;
  const liUrl       = dm.linkedin_search || (dm.name ? `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(dm.name + " " + (co||"").split(" ").slice(0,3).join(" "))}` : null);
  const since       = dm.appointed_on ? dm.appointed_on.slice(0,7) : null;
  const tier        = dm.tier || 3;
  const tc          = tierColor(tier);
  const tlabel      = dm.tier_label || (tier===1?"Primary":tier===2?"Secondary":"Fallback");
  // Email confidence: use the pipeline-computed field when available, otherwise infer
  const emailConf   = dm.email_confidence || (verifiedEmail ? "verified" : "guessed");
  // DM validity: use pipeline field if present; compute client-side if pipeline hasn't run enrich-decision-makers yet
  const isCh        = dm.source === "companies_house" || dm.source === "ch+website";
  const dmValid     = dm.dm_valid !== undefined
    ? dm.dm_valid                                              // pipeline-computed
    : isCh || isPlausibleFirstNameClient(dm.first_name || ""); // client-side fallback
  const dmConf      = dm.dm_confidence || (isCh ? "high" : (dmValid ? "medium" : "low"));
  return (
    <div className={`dm-card tier-${tier}`} style={{opacity: dmValid ? 1 : 0.5}}>
      <div className="dm-av" style={{borderColor:`${tc}40`,color:tc}}>{initials}</div>
      <div className="dm-info">
        <div className="dm-nm">
          {dm.name || [dm.first_name, dm.last_name].filter(Boolean).join(" ")}
          <span className="dm-tier-badge" style={{color:tc,background:`${tc}18`,border:`1px solid ${tc}35`}}>{tlabel}</span>
          {!dmValid && <span style={{fontSize:9,padding:"1px 5px",borderRadius:3,background:"rgba(248,113,113,.1)",border:"1px solid rgba(248,113,113,.25)",color:"#F87171",fontFamily:"'JetBrains Mono',monospace"}}>unverified name</span>}
          {dmConf === "high" && <span style={{fontSize:9,padding:"1px 5px",borderRadius:3,background:"rgba(16,185,129,.07)",border:"1px solid rgba(16,185,129,.2)",color:"#10B981",fontFamily:"'JetBrains Mono',monospace"}}>CH</span>}
        </div>
        <div className="dm-rl" style={{color:tc}}>{dm.role || "Director"}</div>
        {since && <div className="dm-appointed">Appointed {since}</div>}
        {bestEmail && (
          <div className="dm-email">
            {emailConf === "verified"
              ? <><span style={{color:"#10B981"}}>✓</span><span style={{wordBreak:"break-all"}}>{bestEmail}</span><span className="dm-verified">smtp verified</span></>
              : emailConf === "pattern_based"
              ? <><span style={{color:"#818CF8"}}>~</span><span style={{wordBreak:"break-all"}}>{bestEmail}</span><span className="dm-guessed" style={{background:"rgba(99,102,241,.08)",borderColor:"rgba(99,102,241,.2)",color:"#818CF8"}}>pattern</span></>
              : <><span style={{color:"#F59E0B"}}>?</span><span style={{wordBreak:"break-all"}}>{bestEmail}</span><span className="dm-guessed">guessed</span></>
            }
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

export function GradeBadge({ grade }) {
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

export function ReadinessBadge({ lead }) {
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

export function ConfidenceBar({ value }) {
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

export function DecisionMakers({ lead }) {
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
export function generateOpener(lead, ev) {
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

export function CallOpenerPanel({ lead, event }) {
  const [tab, setTab]     = useState("call");
  const [copied, setCopied] = useState(false);

  // Prefer pre-generated drafts from generate-drafts stage (rule-based, clean tone)
  const hasPreGenerated = !!(lead.call_opener || lead.email_draft || lead.linkedin_note);

  const opener = useMemo(() => {
    if (hasPreGenerated) return null;
    return generateOpener(lead, event);
  }, [lead, event, hasPreGenerated]);

  // Parse email_draft: "Subject: X\n\nbody..."
  const emailSubject = useMemo(() => {
    if (lead.email_draft) {
      const m = lead.email_draft.match(/^Subject:\s*(.+?)(?:\n|$)/);
      return m ? m[1] : "";
    }
    return opener?.subject || "";
  }, [lead.email_draft, opener]);

  const emailBody = useMemo(() => {
    if (lead.email_draft) return lead.email_draft.replace(/^Subject:.+\n\n?/, "");
    return opener?.emailBody || "";
  }, [lead.email_draft, opener]);

  const callText     = lead.call_opener   || opener?.call      || "";
  const linkedinText = lead.linkedin_note || opener?.linkedin  || "";

  function doCopy(text) { copy(text); setCopied(true); setTimeout(()=>setCopied(false), 2000); }

  const content = tab === "call"
    ? callText
    : tab === "linkedin"
    ? linkedinText
    : emailBody;

  const charCount = tab === "linkedin" ? linkedinText.length : null;

  // Don't show if there's no meaningful content to display
  const hasContext = hasPreGenerated
    || (lead.fx_evidence_snippets||[]).length > 0
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
        {tab === "email" && emailSubject && (
          <div className="opener-label">Subject: {emailSubject}</div>
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
          onClick={()=>doCopy(tab==="email" ? (emailSubject ? `Subject: ${emailSubject}\n\n${emailBody}` : emailBody) : content)}
        >
          {copied ? "✓ Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
