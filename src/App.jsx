import { useEffect, useMemo, useState, useCallback } from "react";

// ── DATA LOADING ─────────────────────────────────────────────────
// Reads from /data/events.json and /data/leads.json
// These files live in /public/data/ so Vite serves them statically
// GitHub Actions commits updated files after each run

async function fetchData() {
  const [evRes, ldRes] = await Promise.all([
    fetch(`${import.meta.env.BASE_URL}data/events.json?t=${Date.now()}`),
    fetch(`${import.meta.env.BASE_URL}data/leads.json?t=${Date.now()}`),
  ]);

  const evObj = evRes.ok ? await evRes.json() : {};
  const ldObj = ldRes.ok ? await ldRes.json() : {};

  const events = Object.values(evObj)
    .sort((a, b) => new Date(b.detected_at || b.created_at || 0) - new Date(a.detected_at || a.created_at || 0));

  const leads = Object.values(ldObj)
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  return { events, leads };
}

// ── UTILS ────────────────────────────────────────────────────────

function timeAgo(iso) {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function urgencyColor(score) {
  if (score >= 8) return "#ff4444";
  if (score >= 6) return "#ff8c00";
  if (score >= 4) return "#ffd700";
  return "#75e0cf";
}

function priorityColor(p) {
  if (p === "HOT")  return "#ff4444";
  if (p === "WARM") return "#ff8c00";
  return "#75e0cf";
}

function urgencyLabel(score) {
  if (score >= 8) return "CRITICAL";
  if (score >= 6) return "HIGH";
  if (score >= 4) return "MODERATE";
  return "LOW";
}

// ── COMPONENTS ───────────────────────────────────────────────────

function Chip({ children, color }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: "3px 10px", borderRadius: 999,
      fontSize: 11, fontWeight: 600, letterSpacing: "0.03em",
      border: `1px solid ${color ? color + "55" : "rgba(117,224,207,0.3)"}`,
      background: color ? color + "18" : "rgba(117,224,207,0.07)",
      color: color || "#c6fff6",
      whiteSpace: "nowrap",
    }}>
      {children}
    </span>
  );
}

function ScoreBadge({ score, priority }) {
  const color = priorityColor(priority);
  return (
    <div style={{
      width: 54, height: 54, borderRadius: 14, flexShrink: 0,
      display: "grid", placeItems: "center",
      border: `1.5px solid ${color}`,
      background: color + "18",
    }}>
      <span style={{ fontSize: 17, fontWeight: 800, color, lineHeight: 1 }}>{score}</span>
    </div>
  );
}

function UrgencyBar({ score }) {
  const color = urgencyColor(score);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
      <div style={{ flex: 1, height: 3, background: "rgba(255,255,255,0.08)", borderRadius: 2 }}>
        <div style={{ width: `${(score || 0) * 10}%`, height: "100%", background: color, borderRadius: 2 }} />
      </div>
      <span style={{ fontSize: 11, fontWeight: 700, color, minWidth: 64 }}>
        {urgencyLabel(score || 0)}
      </span>
    </div>
  );
}

function Panel({ children, style = {} }) {
  return (
    <div style={{
      background: "rgba(255,255,255,0.04)",
      border: "1px solid rgba(117,224,207,0.12)",
      borderRadius: 20, padding: "20px 22px",
      ...style,
    }}>
      {children}
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <p style={{
      fontSize: 11, fontWeight: 700, letterSpacing: "0.1em",
      textTransform: "uppercase", color: "#75e0cf", margin: "0 0 14px",
    }}>
      {children}
    </p>
  );
}

function Divider() {
  return <div style={{ height: 1, background: "rgba(117,224,207,0.08)", margin: "14px 0" }} />;
}

// ── EVENT CARD ───────────────────────────────────────────────────

function EventCard({ event, selected, onSelect }) {
  return (
    <button
      onClick={() => onSelect(selected ? null : event.id)}
      style={{
        all: "unset", cursor: "pointer", display: "block", width: "100%",
        background: selected ? "rgba(117,224,207,0.07)" : "transparent",
        border: `1px solid ${selected ? "rgba(117,224,207,0.4)" : "rgba(117,224,207,0.1)"}`,
        borderRadius: 14, padding: "14px 16px", marginBottom: 10,
        textAlign: "left", transition: "all 0.15s", boxSizing: "border-box",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          <Chip color={urgencyColor(event.urgency_score)}>{event.event_type || "Event"}</Chip>
          {(event.currency_pairs || []).slice(0, 2).map(p => <Chip key={p}>{p}</Chip>)}
        </div>
        <span style={{ fontSize: 11, color: "#5a8a82", whiteSpace: "nowrap" }}>
          {timeAgo(event.detected_at || event.created_at)}
        </span>
      </div>

      <p style={{ margin: "0 0 6px", fontSize: 13, fontWeight: 600, color: "#e8f4f2", lineHeight: 1.4 }}>
        {event.headline}
      </p>

      <UrgencyBar score={event.urgency_score || 0} />

      {event.sales_angle && (
        <p style={{ margin: "8px 0 0", fontSize: 12, color: "#abc2bd", lineHeight: 1.5, fontStyle: "italic" }}>
          {event.sales_angle}
        </p>
      )}

      {(event.affected_sectors || []).length > 0 && (
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 10 }}>
          {event.affected_sectors.slice(0, 4).map(s => <Chip key={s}>{s}</Chip>)}
          {event.affected_sectors.length > 4 && (
            <Chip>+{event.affected_sectors.length - 4}</Chip>
          )}
        </div>
      )}
    </button>
  );
}

// ── LEAD CARD ────────────────────────────────────────────────────

function LeadCard({ lead }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{
      background: "rgba(255,255,255,0.035)",
      border: `1px solid rgba(117,224,207,0.1)`,
      borderLeft: `3px solid ${priorityColor(lead.priority)}`,
      borderRadius: 16, padding: "18px 20px", marginBottom: 14,
    }}>
      {/* TOP */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 12 }}>
        <ScoreBadge score={lead.score} priority={lead.priority} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
            <h3 style={{ margin: "0 0 5px", fontSize: 16, fontWeight: 700, color: "#e8f4f2" }}>
              {lead.company_name}
            </h3>
            <Chip color={priorityColor(lead.priority)}>{lead.priority}</Chip>
          </div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {lead.sector       && <Chip>{lead.sector}</Chip>}
            {lead.fx_exposure  && <Chip>{lead.fx_exposure}</Chip>}
            {lead.company_type && <Chip>{lead.company_type}</Chip>}
          </div>
        </div>
      </div>

      {/* META */}
      <div style={{ display: "flex", gap: 16, marginBottom: 12, flexWrap: "wrap" }}>
        {lead.address && (
          <span style={{ fontSize: 12, color: "#5a8a82" }}>📍 {lead.address}</span>
        )}
        {lead.website && (
          <a href={lead.website} target="_blank" rel="noreferrer"
            style={{ fontSize: 12, color: "#75e0cf", textDecoration: "none" }}>
            🌐 Website ↗
          </a>
        )}
        {lead.incorporated && (
          <span style={{ fontSize: 12, color: "#5a8a82" }}>
            Est. {lead.incorporated?.slice(0, 4)}
          </span>
        )}
      </div>

      {/* DIRECTOR */}
      {lead.director_name && (
        <div style={{
          background: "rgba(117,224,207,0.05)",
          border: "1px solid rgba(117,224,207,0.12)",
          borderRadius: 10, padding: "8px 12px", marginBottom: 12,
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <span style={{ fontSize: 16 }}>👤</span>
          <div>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#e8f4f2" }}>
              {lead.director_name}
            </span>
            <span style={{ fontSize: 12, color: "#75e0cf", marginLeft: 6 }}>
              {lead.director_role}
            </span>
          </div>
        </div>
      )}

      <Divider />

      {/* TRIGGER + FX */}
      <div style={{ marginBottom: 10 }}>
        <p style={{ margin: "0 0 3px", fontSize: 11, fontWeight: 700, color: "#5a8a82", letterSpacing: "0.06em" }}>TRIGGER</p>
        <p style={{ margin: 0, fontSize: 13, color: "#abc2bd", lineHeight: 1.5 }}>{lead.trigger_headline}</p>
      </div>
      <div style={{ marginBottom: 10 }}>
        <p style={{ margin: "0 0 3px", fontSize: 11, fontWeight: 700, color: "#5a8a82", letterSpacing: "0.06em" }}>FX REASON</p>
        <p style={{ margin: 0, fontSize: 13, color: "#e8f4f2", lineHeight: 1.5 }}>{lead.fx_reason}</p>
      </div>

      {/* SIGNALS */}
      {(lead.import_export_signals || []).length > 0 && (
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 12 }}>
          {lead.import_export_signals.slice(0, 8).map(s => <Chip key={s}>{s}</Chip>)}
        </div>
      )}

      {/* NEXT STEP */}
      <div style={{
        background: "rgba(117,224,207,0.05)",
        border: "1px solid rgba(117,224,207,0.15)",
        borderRadius: 10, padding: "10px 14px", marginBottom: 10,
      }}>
        <p style={{ margin: "0 0 2px", fontSize: 11, fontWeight: 700, color: "#75e0cf", letterSpacing: "0.06em" }}>
          NEXT STEP
        </p>
        <p style={{ margin: 0, fontSize: 13, color: "#e8f4f2" }}>{lead.suggested_next_step}</p>
      </div>

      {/* EXPAND */}
      <button
        onClick={() => setExpanded(e => !e)}
        style={{ all: "unset", cursor: "pointer", fontSize: 12, color: "#5a8a82" }}
      >
        {expanded ? "▲ Less" : "▼ More detail"}
      </button>

      {expanded && (
        <div style={{ marginTop: 12 }}>
          <Divider />
          {lead.company_number && (
            <p style={{ margin: "0 0 4px", fontSize: 12, color: "#5a8a82" }}>
              Companies House: <span style={{ color: "#abc2bd" }}>{lead.company_number}</span>
              {" "}<span style={{ color: lead.company_status === "active" ? "#00e676" : "#ff8c00" }}>
                ({lead.company_status})
              </span>
            </p>
          )}
          {(lead.sic_codes || []).length > 0 && (
            <p style={{ margin: "0 0 4px", fontSize: 12, color: "#5a8a82" }}>
              SIC: <span style={{ color: "#abc2bd" }}>{lead.sic_codes.join(", ")}</span>
            </p>
          )}
          {(lead.scoring_reasons || []).length > 0 && (
            <div style={{ marginTop: 8 }}>
              <p style={{ margin: "0 0 4px", fontSize: 11, fontWeight: 700, color: "#5a8a82" }}>SCORING</p>
              {lead.scoring_reasons.map((r, i) => (
                <p key={i} style={{ margin: "0 0 2px", fontSize: 12, color: "#5a8a82" }}>· {r}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── EMPTY STATE ──────────────────────────────────────────────────

function EmptyState() {
  return (
    <Panel style={{ textAlign: "center", padding: "48px 32px" }}>
      <p style={{ fontSize: 32, marginBottom: 12 }}>📡</p>
      <h3 style={{ margin: "0 0 8px", color: "#e8f4f2" }}>No leads yet</h3>
      <p style={{ color: "#5a8a82", fontSize: 14, lineHeight: 1.6, margin: 0 }}>
        Run the discovery pipeline to generate leads:
      </p>
      <div style={{
        background: "rgba(0,0,0,0.3)", border: "1px solid rgba(117,224,207,0.15)",
        borderRadius: 10, padding: "12px 16px", marginTop: 16, textAlign: "left",
      }}>
        <code style={{ fontSize: 13, color: "#75e0cf", display: "block", marginBottom: 4 }}>
          python scripts/ingest.py
        </code>
        <code style={{ fontSize: 13, color: "#75e0cf" }}>
          python scripts/discover.py
        </code>
      </div>
    </Panel>
  );
}

// ── MAIN APP ─────────────────────────────────────────────────────

export default function App() {
  const [events,          setEvents]          = useState([]);
  const [leads,           setLeads]           = useState([]);
  const [selectedEventId, setSelectedEventId] = useState(null);
  const [priorityFilter,  setPriorityFilter]  = useState("ALL");
  const [loading,         setLoading]         = useState(true);
  const [error,           setError]           = useState(null);
  const [lastRefresh,     setLastRefresh]      = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { events, leads } = await fetchData();
      setEvents(events);
      setLeads(leads);
      setLastRefresh(new Date());
    } catch (err) {
      setError("Could not load data. Run ingest.py and discover.py first.");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const filteredLeads = useMemo(() => {
    let base = selectedEventId
      ? leads.filter(l => l.event_id === selectedEventId)
      : leads;
    if (priorityFilter !== "ALL") base = base.filter(l => l.priority === priorityFilter);
    return base;
  }, [leads, selectedEventId, priorityFilter]);

  const hotCount  = leads.filter(l => l.priority === "HOT").length;
  const warmCount = leads.filter(l => l.priority === "WARM").length;
  const topEvent  = events[0];

  return (
    <div style={{
      minHeight: "100vh",
      background: "#060f0e",
      color: "#e8f4f2",
      fontFamily: "'DM Sans', 'Outfit', system-ui, sans-serif",
      padding: "28px 32px",
    }}>

      {/* HEADER */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 28 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <div style={{
              width: 8, height: 8, borderRadius: "50%",
              background: loading ? "#ffd700" : "#00e676",
              boxShadow: `0 0 8px ${loading ? "#ffd700" : "#00e676"}`,
            }} />
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", color: "#75e0cf", textTransform: "uppercase" }}>
              FX Discovery Engine v1
            </span>
          </div>
          <h1 style={{ margin: "0 0 4px", fontSize: 34, fontWeight: 800, letterSpacing: "-0.02em" }}>
            Today's opportunity radar
          </h1>
          <p style={{ margin: 0, fontSize: 14, color: "#5a8a82" }}>
            Market events → affected sectors → exposed companies
            {lastRefresh && ` · Updated ${timeAgo(lastRefresh)}`}
          </p>
        </div>

        <button onClick={loadData} disabled={loading} style={{
          background: "rgba(117,224,207,0.07)",
          border: "1px solid rgba(117,224,207,0.25)",
          borderRadius: 12, padding: "10px 20px",
          color: "#75e0cf", fontSize: 13, fontWeight: 600,
          cursor: loading ? "wait" : "pointer",
          opacity: loading ? 0.6 : 1,
        }}>
          {loading ? "Loading..." : "↻ Refresh"}
        </button>
      </div>

      {error && (
        <div style={{
          background: "rgba(255,68,68,0.08)", border: "1px solid rgba(255,68,68,0.3)",
          borderRadius: 12, padding: "12px 18px", marginBottom: 20, color: "#ff8888", fontSize: 14,
        }}>
          {error}
        </div>
      )}

      {/* STATS */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 24 }}>
        {[
          { label: "Events",     value: events.length, color: "#75e0cf" },
          { label: "Hot leads",  value: hotCount,      color: "#ff4444" },
          { label: "Warm leads", value: warmCount,     color: "#ff8c00" },
          { label: "Total leads",value: leads.length,  color: "#ffd700" },
        ].map(({ label, value, color }) => (
          <Panel key={label}>
            <p style={{ margin: "0 0 4px", fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#5a8a82" }}>
              {label}
            </p>
            <p style={{ margin: 0, fontSize: 34, fontWeight: 800, color }}>{value}</p>
          </Panel>
        ))}
      </div>

      {/* MORNING BRIEFING */}
      {topEvent && (
        <Panel style={{ marginBottom: 24 }}>
          <SectionLabel>Morning briefing — top event</SectionLabel>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 24, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 260 }}>
              <h2 style={{ margin: "0 0 8px", fontSize: 19, fontWeight: 700 }}>{topEvent.headline}</h2>
              <p style={{ margin: "0 0 10px", fontSize: 14, color: "#abc2bd", lineHeight: 1.6 }}>{topEvent.summary}</p>
              {topEvent.sales_angle && (
                <p style={{ margin: 0, fontSize: 14, fontWeight: 600, fontStyle: "italic", color: "#e8f4f2" }}>
                  "{topEvent.sales_angle}"
                </p>
              )}
            </div>
            <div style={{ minWidth: 180 }}>
              <p style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 700, color: "#5a8a82", letterSpacing: "0.08em" }}>WHO IS EXPOSED</p>
              {(topEvent.who_is_hurt || []).slice(0, 4).map(s => (
                <div key={s} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <span style={{ color: "#ff4444", fontSize: 12 }}>▼</span>
                  <span style={{ fontSize: 13, color: "#abc2bd" }}>{s}</span>
                </div>
              ))}
              {(topEvent.who_benefits || []).slice(0, 2).map(s => (
                <div key={s} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <span style={{ color: "#00e676", fontSize: 12 }}>▲</span>
                  <span style={{ fontSize: 13, color: "#abc2bd" }}>{s}</span>
                </div>
              ))}
            </div>
          </div>
        </Panel>
      )}

      {/* MAIN LAYOUT */}
      <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: 20 }}>

        {/* EVENT FEED */}
        <div>
          <Panel style={{ position: "sticky", top: 20, maxHeight: "calc(100vh - 40px)", overflow: "auto" }}>
            <SectionLabel>Event feed</SectionLabel>

            {!loading && events.length === 0 && (
              <div style={{ textAlign: "center", padding: "24px 0" }}>
                <p style={{ color: "#5a8a82", fontSize: 14 }}>No events yet.</p>
                <p style={{ color: "#5a8a82", fontSize: 12 }}>Run <code>python scripts/ingest.py</code></p>
              </div>
            )}

            {events.map(event => (
              <EventCard
                key={event.id}
                event={event}
                selected={selectedEventId === event.id}
                onSelect={setSelectedEventId}
              />
            ))}
          </Panel>
        </div>

        {/* LEADS */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div>
              <SectionLabel>Lead cards</SectionLabel>
              <p style={{ margin: 0, fontSize: 13, color: "#5a8a82" }}>
                {filteredLeads.length} companies
                {selectedEventId && " · filtered by event — click event to clear"}
              </p>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {["ALL", "HOT", "WARM", "QUEUE"].map(f => (
                <button key={f} onClick={() => setPriorityFilter(f)} style={{
                  all: "unset", cursor: "pointer",
                  padding: "5px 12px", borderRadius: 10, fontSize: 12, fontWeight: 700,
                  background: priorityFilter === f ? "rgba(117,224,207,0.12)" : "transparent",
                  border: `1px solid ${priorityFilter === f ? "rgba(117,224,207,0.4)" : "rgba(117,224,207,0.12)"}`,
                  color: priorityFilter === f ? "#75e0cf" : "#5a8a82",
                }}>
                  {f}
                </button>
              ))}
            </div>
          </div>

          {!loading && filteredLeads.length === 0 && <EmptyState />}
          {filteredLeads.map(lead => <LeadCard key={lead.id} lead={lead} />)}
        </div>
      </div>
    </div>
  );
}
