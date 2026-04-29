import { useEffect, useState, useCallback } from "react";

async function fetchData() {
  const [evRes, ldRes] = await Promise.all([
    fetch(`${import.meta.env.BASE_URL}data/events.json?t=${Date.now()}`),
    fetch(`${import.meta.env.BASE_URL}data/leads.json?t=${Date.now()}`),
  ]);
  const evObj = evRes.ok ? await evRes.json() : {};
  const ldObj = ldRes.ok ? await ldRes.json() : {};
  const events = Object.values(evObj).sort(
    (a, b) => new Date(b.detected_at || 0) - new Date(a.detected_at || 0)
  );
  const leads = Object.values(ldObj).sort((a, b) => (b.score || 0) - (a.score || 0));
  return { events, leads };
}

function timeAgo(iso) {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function urgencyColor(score) {
  if (score >= 8) return "#FF3B3B";
  if (score >= 6) return "#FF8C00";
  if (score >= 4) return "#F5C842";
  return "#4ECDC4";
}

function priorityColor(p) {
  if (p === "HOT") return "#FF3B3B";
  if (p === "WARM") return "#FF8C00";
  return "#4ECDC4";
}

const STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Mono:wght@400;500&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: #0A0A0A;
    color: #E8E8E0;
    font-family: 'Syne', sans-serif;
    min-height: 100vh;
  }

  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

  .app {
    max-width: 1400px;
    margin: 0 auto;
    padding: 0 32px 80px;
  }

  /* HEADER */
  .header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    padding: 48px 0 40px;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    margin-bottom: 48px;
  }
  .header-left {}
  .logo-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }
  .logo-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #4ECDC4;
    box-shadow: 0 0 12px #4ECDC4;
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.6; transform: scale(0.85); }
  }
  .logo-label {
    font-family: 'DM Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.14em;
    color: #4ECDC4;
    text-transform: uppercase;
  }
  .header-title {
    font-size: clamp(28px, 4vw, 48px);
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1.05;
    color: #F0F0E8;
  }
  .header-sub {
    margin-top: 8px;
    font-family: 'DM Mono', monospace;
    font-size: 12px;
    color: rgba(255,255,255,0.3);
    letter-spacing: 0.04em;
  }
  .header-right {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .stat-pill {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    padding: 12px 20px;
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 12px;
    background: rgba(255,255,255,0.02);
    min-width: 72px;
  }
  .stat-num {
    font-size: 24px;
    font-weight: 800;
    line-height: 1;
  }
  .stat-label {
    font-family: 'DM Mono', monospace;
    font-size: 9px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.3);
  }
  .refresh-btn {
    padding: 10px 18px;
    background: rgba(78,205,196,0.1);
    border: 1px solid rgba(78,205,196,0.3);
    border-radius: 10px;
    color: #4ECDC4;
    font-family: 'Syne', sans-serif;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    letter-spacing: 0.02em;
    transition: all 0.15s;
  }
  .refresh-btn:hover { background: rgba(78,205,196,0.18); }

  /* VIEW STATES */
  .view-label {
    font-family: 'DM Mono', monospace;
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.25);
    margin-bottom: 20px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .view-label .breadcrumb-sep { color: rgba(255,255,255,0.12); }
  .view-label .active { color: #4ECDC4; }
  .back-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: 'DM Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.08em;
    color: rgba(255,255,255,0.35);
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
    margin-bottom: 24px;
    transition: color 0.15s;
  }
  .back-btn:hover { color: #4ECDC4; }

  /* EVENT GRID */
  .event-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
    gap: 16px;
  }

  .event-card {
    position: relative;
    background: rgba(255,255,255,0.025);
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 20px;
    padding: 24px;
    cursor: pointer;
    transition: all 0.2s;
    overflow: hidden;
  }
  .event-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: var(--accent);
    opacity: 0.7;
  }
  .event-card:hover {
    background: rgba(255,255,255,0.04);
    border-color: rgba(255,255,255,0.12);
    transform: translateY(-2px);
  }
  .event-card-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 14px;
    gap: 12px;
  }
  .event-type-badge {
    font-family: 'DM Mono', monospace;
    font-size: 10px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding: 4px 10px;
    border-radius: 6px;
    background: rgba(255,255,255,0.06);
    color: var(--accent);
    border: 1px solid rgba(255,255,255,0.08);
    white-space: nowrap;
  }
  .urgency-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .urgency-score {
    font-family: 'DM Mono', monospace;
    font-size: 12px;
    font-weight: 500;
    color: var(--accent);
  }
  .urgency-bar-track {
    width: 48px;
    height: 3px;
    background: rgba(255,255,255,0.08);
    border-radius: 2px;
    overflow: hidden;
  }
  .urgency-bar-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
  }
  .event-headline {
    font-size: 16px;
    font-weight: 700;
    line-height: 1.4;
    color: #F0F0E8;
    margin-bottom: 10px;
    letter-spacing: -0.01em;
  }
  .event-summary {
    font-size: 13px;
    line-height: 1.65;
    color: rgba(255,255,255,0.45);
    margin-bottom: 16px;
  }
  .fx-logic-box {
    background: rgba(78,205,196,0.04);
    border: 1px solid rgba(78,205,196,0.12);
    border-left: 3px solid rgba(78,205,196,0.5);
    border-radius: 8px;
    padding: 10px 14px;
    margin-bottom: 16px;
  }
  .fx-logic-label {
    font-family: 'DM Mono', monospace;
    font-size: 9px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #4ECDC4;
    margin-bottom: 4px;
  }
  .fx-logic-text {
    font-size: 12px;
    line-height: 1.55;
    color: rgba(255,255,255,0.6);
  }
  .sector-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 20px;
  }
  .sector-chip {
    font-family: 'DM Mono', monospace;
    font-size: 10px;
    padding: 4px 10px;
    border-radius: 6px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    color: rgba(255,255,255,0.45);
    letter-spacing: 0.04em;
  }
  .event-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .event-meta {
    font-family: 'DM Mono', monospace;
    font-size: 10px;
    color: rgba(255,255,255,0.2);
    letter-spacing: 0.06em;
  }
  .find-companies-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: 'Syne', sans-serif;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 8px 16px;
    background: var(--accent-subtle);
    border: 1px solid var(--accent-border);
    border-radius: 8px;
    color: var(--accent);
    cursor: pointer;
    transition: all 0.15s;
  }
  .find-companies-btn:hover {
    background: var(--accent-hover);
  }
  .find-companies-btn .arrow {
    transition: transform 0.15s;
    font-size: 14px;
  }
  .find-companies-btn:hover .arrow { transform: translateX(3px); }

  /* INDUSTRY VIEW */
  .industry-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
  }
  .industry-card {
    background: rgba(255,255,255,0.025);
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 16px;
    padding: 20px 22px;
    cursor: pointer;
    transition: all 0.18s;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
  }
  .industry-card:hover {
    background: rgba(255,255,255,0.05);
    border-color: rgba(78,205,196,0.3);
    transform: translateX(4px);
  }
  .industry-card-left {}
  .industry-name {
    font-size: 14px;
    font-weight: 700;
    color: #F0F0E8;
    margin-bottom: 4px;
    line-height: 1.3;
  }
  .industry-meta {
    font-family: 'DM Mono', monospace;
    font-size: 10px;
    color: rgba(255,255,255,0.25);
    letter-spacing: 0.06em;
  }
  .industry-arrow {
    color: #4ECDC4;
    font-size: 18px;
    opacity: 0.5;
    transition: all 0.15s;
    flex-shrink: 0;
  }
  .industry-card:hover .industry-arrow { opacity: 1; transform: translateX(2px); }

  /* EVENT CONTEXT BANNER */
  .event-context {
    background: rgba(255,255,255,0.02);
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 16px;
    padding: 20px 24px;
    margin-bottom: 32px;
    display: flex;
    gap: 24px;
    flex-wrap: wrap;
  }
  .context-block {}
  .context-label {
    font-family: 'DM Mono', monospace;
    font-size: 9px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.2);
    margin-bottom: 5px;
  }
  .context-value {
    font-size: 13px;
    font-weight: 600;
    color: rgba(255,255,255,0.7);
    line-height: 1.4;
    max-width: 320px;
  }
  .context-pairs {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .pair-tag {
    font-family: 'DM Mono', monospace;
    font-size: 11px;
    padding: 3px 9px;
    border-radius: 5px;
    background: rgba(78,205,196,0.08);
    border: 1px solid rgba(78,205,196,0.2);
    color: #4ECDC4;
  }

  /* COMPANY CARDS */
  .company-grid {
    display: grid;
    gap: 12px;
  }
  .company-card {
    background: rgba(255,255,255,0.025);
    border: 1px solid rgba(255,255,255,0.06);
    border-left: 3px solid var(--priority-color);
    border-radius: 16px;
    padding: 22px 24px;
    transition: all 0.18s;
  }
  .company-card:hover {
    background: rgba(255,255,255,0.04);
    border-color: rgba(255,255,255,0.1);
    border-left-color: var(--priority-color);
  }
  .company-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 14px;
  }
  .company-name {
    font-size: 17px;
    font-weight: 800;
    color: #F0F0E8;
    letter-spacing: -0.02em;
  }
  .company-type {
    font-family: 'DM Mono', monospace;
    font-size: 10px;
    color: rgba(255,255,255,0.25);
    margin-top: 3px;
    letter-spacing: 0.06em;
  }
  .score-badge {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
  }
  .score-num {
    font-size: 22px;
    font-weight: 800;
    line-height: 1;
    color: var(--priority-color);
  }
  .score-label {
    font-family: 'DM Mono', monospace;
    font-size: 8px;
    letter-spacing: 0.12em;
    color: var(--priority-color);
    opacity: 0.7;
    text-transform: uppercase;
  }
  .company-meta-row {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    margin-bottom: 14px;
  }
  .company-meta-item {
    display: flex;
    align-items: center;
    gap: 5px;
    font-family: 'DM Mono', monospace;
    font-size: 11px;
    color: rgba(255,255,255,0.35);
  }
  .company-meta-item .icon { font-size: 12px; }
  .director-row {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 7px 12px;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 8px;
    margin-bottom: 14px;
  }
  .director-icon {
    width: 22px; height: 22px;
    border-radius: 50%;
    background: rgba(78,205,196,0.12);
    border: 1px solid rgba(78,205,196,0.2);
    display: grid;
    place-items: center;
    font-size: 10px;
  }
  .director-name {
    font-size: 13px;
    font-weight: 700;
    color: rgba(255,255,255,0.8);
  }
  .director-role {
    font-family: 'DM Mono', monospace;
    font-size: 10px;
    color: #4ECDC4;
    letter-spacing: 0.04em;
  }
  .fx-reason-box {
    background: rgba(78,205,196,0.03);
    border: 1px solid rgba(78,205,196,0.1);
    border-radius: 10px;
    padding: 12px 14px;
    margin-bottom: 14px;
  }
  .fx-reason-label {
    font-family: 'DM Mono', monospace;
    font-size: 9px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #4ECDC4;
    margin-bottom: 5px;
  }
  .fx-reason-text {
    font-size: 12px;
    line-height: 1.6;
    color: rgba(255,255,255,0.55);
  }
  .signal-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-bottom: 14px;
  }
  .signal-chip {
    font-family: 'DM Mono', monospace;
    font-size: 9px;
    letter-spacing: 0.06em;
    padding: 3px 8px;
    border-radius: 5px;
    background: rgba(78,205,196,0.05);
    border: 1px solid rgba(78,205,196,0.15);
    color: rgba(78,205,196,0.7);
  }
  .next-step-box {
    background: rgba(255,255,255,0.02);
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 10px;
    padding: 10px 14px;
  }
  .next-step-label {
    font-family: 'DM Mono', monospace;
    font-size: 9px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.2);
    margin-bottom: 4px;
  }
  .next-step-text {
    font-size: 12px;
    line-height: 1.55;
    color: rgba(255,255,255,0.5);
  }
  .company-links {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }
  .company-link {
    font-family: 'DM Mono', monospace;
    font-size: 10px;
    letter-spacing: 0.06em;
    padding: 5px 12px;
    border-radius: 6px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    color: rgba(255,255,255,0.35);
    text-decoration: none;
    transition: all 0.15s;
  }
  .company-link:hover {
    color: #4ECDC4;
    border-color: rgba(78,205,196,0.3);
    background: rgba(78,205,196,0.05);
  }

  /* EMPTY STATE */
  .empty {
    text-align: center;
    padding: 80px 32px;
    color: rgba(255,255,255,0.2);
  }
  .empty-icon { font-size: 40px; margin-bottom: 16px; }
  .empty h3 { font-size: 18px; font-weight: 700; margin-bottom: 8px; color: rgba(255,255,255,0.35); }
  .empty p { font-family: 'DM Mono', monospace; font-size: 12px; line-height: 1.7; }
  .empty code { color: rgba(78,205,196,0.6); }
`;

// VIEW: events list
function EventsView({ events, leads, onSelectEvent }) {
  const hotCount = leads.filter(l => l.priority === "HOT").length;
  const warmCount = leads.filter(l => l.priority === "WARM").length;

  return (
    <>
      <div className="view-label">
        <span className="active">Market Events</span>
        <span className="breadcrumb-sep">→ click an event to see affected industries →</span>
        <span>Companies</span>
      </div>

      {events.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">📡</div>
          <h3>No events yet</h3>
          <p>Run <code>python3 scripts/ingest.py</code> to pull live market events</p>
        </div>
      ) : (
        <div className="event-grid">
          {events.map(event => {
            const eventLeads = leads.filter(l => l.event_id === event.id);
            const accent = urgencyColor(event.urgency_score || 0);
            return (
              <div
                key={event.id}
                className="event-card"
                style={{ "--accent": accent, "--accent-subtle": `${accent}15`, "--accent-border": `${accent}40`, "--accent-hover": `${accent}25` }}
              >
                <div className="event-card-top">
                  <div className="event-type-badge">{event.event_type || "Event"}</div>
                  <div className="urgency-row">
                    <span className="urgency-score">{event.urgency_score}/10</span>
                    <div className="urgency-bar-track">
                      <div className="urgency-bar-fill" style={{ width: `${(event.urgency_score || 0) * 10}%` }} />
                    </div>
                  </div>
                </div>

                <h3 className="event-headline">{event.headline}</h3>
                <p className="event-summary">{event.summary}</p>

                {event.fx_payment_logic && (
                  <div className="fx-logic-box">
                    <div className="fx-logic-label">Why businesses pay FX</div>
                    <div className="fx-logic-text">{event.fx_payment_logic}</div>
                  </div>
                )}

                <div className="sector-chips">
                  {(event.who_pays_fx || event.affected_sectors || []).slice(0, 4).map(s => (
                    <span key={s} className="sector-chip">{s}</span>
                  ))}
                </div>

                <div className="event-footer">
                  <span className="event-meta">
                    {timeAgo(event.detected_at)} · {(event.currency_pairs || []).join(" · ")}
                    {eventLeads.length > 0 && ` · ${eventLeads.length} leads`}
                  </span>
                  <button
                    className="find-companies-btn"
                    onClick={() => onSelectEvent(event)}
                  >
                    See affected industries
                    <span className="arrow">→</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// VIEW: industries for a selected event
function IndustriesView({ event, leads, onSelectIndustry, onBack }) {
  const sectors = event.who_pays_fx || event.affected_sectors || [];
  const accent = urgencyColor(event.urgency_score || 0);

  // Count leads per sector
  const leadsForEvent = leads.filter(l => l.event_id === event.id);

  return (
    <>
      <button className="back-btn" onClick={onBack}>← Back to events</button>

      <div className="view-label">
        <span>Market Events</span>
        <span className="breadcrumb-sep">→</span>
        <span className="active">Affected Industries</span>
        <span className="breadcrumb-sep">→</span>
        <span>Companies</span>
      </div>

      {/* Event context banner */}
      <div className="event-context">
        <div className="context-block" style={{ flex: 2, minWidth: 220 }}>
          <div className="context-label">Event</div>
          <div className="context-value">{event.headline}</div>
        </div>
        <div className="context-block">
          <div className="context-label">Urgency</div>
          <div className="context-value" style={{ color: accent }}>{event.urgency_score}/10</div>
        </div>
        <div className="context-block">
          <div className="context-label">Currency pairs</div>
          <div className="context-pairs">
            {(event.currency_pairs || []).map(p => <span key={p} className="pair-tag">{p}</span>)}
          </div>
        </div>
        {event.fx_payment_logic && (
          <div className="context-block" style={{ flex: 3, minWidth: 240 }}>
            <div className="context-label">Why these businesses pay FX</div>
            <div className="context-value" style={{ fontSize: 12, color: "rgba(255,255,255,0.5)" }}>
              {event.fx_payment_logic}
            </div>
          </div>
        )}
      </div>

      <div className="view-label" style={{ marginBottom: 16 }}>
        Select an industry to find companies
      </div>

      {sectors.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">🏭</div>
          <h3>No sectors identified</h3>
          <p>Run the discovery pipeline to generate sector data</p>
        </div>
      ) : (
        <div className="industry-grid">
          {sectors.map((sector, i) => {
            const sectorLeads = leadsForEvent.filter(l =>
              (l.sector || "").toLowerCase().includes(sector.toLowerCase().slice(0, 12)) ||
              sector.toLowerCase().includes((l.sector || "").toLowerCase().slice(0, 12))
            );
            return (
              <div
                key={sector}
                className="industry-card"
                onClick={() => onSelectIndustry(sector)}
                style={{ animationDelay: `${i * 40}ms` }}
              >
                <div className="industry-card-left">
                  <div className="industry-name">{sector}</div>
                  <div className="industry-meta">
                    {sectorLeads.length > 0
                      ? `${sectorLeads.length} companies found`
                      : "Click to find companies"}
                  </div>
                </div>
                <div className="industry-arrow">→</div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// VIEW: companies for event + industry
function CompaniesView({ event, industry, leads, onBack }) {
  const eventLeads = leads.filter(l => l.event_id === event.id);

  // Show all leads for this event if industry match is loose
  const companies = eventLeads.length > 0 ? eventLeads : leads.filter(l =>
    (l.sector || "").toLowerCase().includes(industry.toLowerCase().slice(0, 10))
  );

  return (
    <>
      <button className="back-btn" onClick={onBack}>← Back to industries</button>

      <div className="view-label">
        <span>Market Events</span>
        <span className="breadcrumb-sep">→</span>
        <span>Affected Industries</span>
        <span className="breadcrumb-sep">→</span>
        <span className="active">{industry}</span>
      </div>

      {/* Mini event context */}
      <div className="event-context" style={{ marginBottom: 24 }}>
        <div className="context-block" style={{ flex: 1 }}>
          <div className="context-label">Trigger event</div>
          <div className="context-value" style={{ fontSize: 12 }}>{event.headline}</div>
        </div>
        <div className="context-block">
          <div className="context-label">Industry</div>
          <div className="context-value" style={{ fontSize: 13 }}>{industry}</div>
        </div>
        <div className="context-block">
          <div className="context-label">FX exposure</div>
          <div className="context-pairs">
            {(event.currency_pairs || []).map(p => <span key={p} className="pair-tag">{p}</span>)}
          </div>
        </div>
      </div>

      {companies.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">🏢</div>
          <h3>No companies found yet</h3>
          <p>
            Run <code>python3 scripts/discover.py</code> to search Companies House<br />
            and find businesses in this sector with FX exposure
          </p>
        </div>
      ) : (
        <div className="company-grid">
          {companies.map(lead => {
            const pc = priorityColor(lead.priority);
            return (
              <div
                key={lead.id}
                className="company-card"
                style={{ "--priority-color": pc }}
              >
                <div className="company-top">
                  <div>
                    <div className="company-name">{lead.company_name}</div>
                    <div className="company-type">
                      {lead.company_type && `${lead.company_type.toUpperCase()} · `}
                      {lead.company_number && `CH ${lead.company_number}`}
                      {lead.incorporated && ` · Est. ${lead.incorporated.slice(0, 4)}`}
                    </div>
                  </div>
                  <div className="score-badge">
                    <div className="score-num">{lead.score}</div>
                    <div className="score-label">{lead.priority}</div>
                  </div>
                </div>

                <div className="company-meta-row">
                  {lead.address && (
                    <div className="company-meta-item">
                      <span className="icon">📍</span>
                      <span>{lead.address}</span>
                    </div>
                  )}
                  {lead.company_status && (
                    <div className="company-meta-item">
                      <span className="icon">●</span>
                      <span style={{ color: lead.company_status === "active" ? "#4ECDC4" : "#FF8C00" }}>
                        {lead.company_status}
                      </span>
                    </div>
                  )}
                </div>

                {lead.director_name && (
                  <div className="director-row">
                    <div className="director-icon">👤</div>
                    <div>
                      <div className="director-name">{lead.director_name}</div>
                    </div>
                    <div className="director-role">{lead.director_role}</div>
                  </div>
                )}

                {lead.fx_reason && (
                  <div className="fx-reason-box">
                    <div className="fx-reason-label">Why they need FX</div>
                    <div className="fx-reason-text">{lead.fx_reason}</div>
                  </div>
                )}

                {(lead.fx_payment_signals || lead.import_export_signals || []).length > 0 && (
                  <div className="signal-chips">
                    {(lead.fx_payment_signals || lead.import_export_signals || []).slice(0, 8).map(s => (
                      <span key={s} className="signal-chip">{s}</span>
                    ))}
                  </div>
                )}

                {lead.suggested_next_step && (
                  <div className="next-step-box">
                    <div className="next-step-label">Next step</div>
                    <div className="next-step-text">{lead.suggested_next_step}</div>
                  </div>
                )}

                <div className="company-links">
                  {lead.website && (
                    <a href={lead.website} target="_blank" rel="noreferrer" className="company-link">
                      🌐 Website
                    </a>
                  )}
                  {lead.company_number && (
                    <a
                      href={`https://find-and-update.company-information.service.gov.uk/company/${lead.company_number}`}
                      target="_blank"
                      rel="noreferrer"
                      className="company-link"
                    >
                      🏛 Companies House
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ── MAIN APP ──────────────────────────────────────────────────────

export default function App() {
  const [events, setEvents] = useState([]);
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);

  // Navigation state
  const [view, setView] = useState("events"); // events | industries | companies
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [selectedIndustry, setSelectedIndustry] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const { events, leads } = await fetchData();
      setEvents(events);
      setLeads(leads);
      setLastRefresh(new Date());
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const hotCount = leads.filter(l => l.priority === "HOT").length;
  const warmCount = leads.filter(l => l.priority === "WARM").length;

  return (
    <>
      <style>{STYLES}</style>
      <div className="app">

        {/* HEADER */}
        <header className="header">
          <div className="header-left">
            <div className="logo-row">
              <div className="logo-dot" />
              <span className="logo-label">FX Discovery Engine · Universal Partners</span>
            </div>
            <h1 className="header-title">
              {view === "events" && "Today's opportunity radar"}
              {view === "industries" && selectedEvent?.event_type}
              {view === "companies" && selectedIndustry}
            </h1>
            <p className="header-sub">
              Market events → affected industries → exposed companies
              {lastRefresh && ` · ${timeAgo(lastRefresh)}`}
            </p>
          </div>
          <div className="header-right">
            <div className="stat-pill">
              <span className="stat-num" style={{ color: "#4ECDC4" }}>{events.length}</span>
              <span className="stat-label">Events</span>
            </div>
            <div className="stat-pill">
              <span className="stat-num" style={{ color: "#FF3B3B" }}>{hotCount}</span>
              <span className="stat-label">Hot</span>
            </div>
            <div className="stat-pill">
              <span className="stat-num" style={{ color: "#FF8C00" }}>{warmCount}</span>
              <span className="stat-label">Warm</span>
            </div>
            <button className="refresh-btn" onClick={loadData} disabled={loading}>
              {loading ? "..." : "↻ Refresh"}
            </button>
          </div>
        </header>

        {/* VIEWS */}
        {view === "events" && (
          <EventsView
            events={events}
            leads={leads}
            onSelectEvent={ev => { setSelectedEvent(ev); setView("industries"); }}
          />
        )}

        {view === "industries" && selectedEvent && (
          <IndustriesView
            event={selectedEvent}
            leads={leads}
            onSelectIndustry={ind => { setSelectedIndustry(ind); setView("companies"); }}
            onBack={() => { setView("events"); setSelectedEvent(null); }}
          />
        )}

        {view === "companies" && selectedEvent && selectedIndustry && (
          <CompaniesView
            event={selectedEvent}
            industry={selectedIndustry}
            leads={leads}
            onBack={() => setView("industries")}
          />
        )}

      </div>
    </>
  );
}
