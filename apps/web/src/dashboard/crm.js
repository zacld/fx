// Lead status and follow-ups (CLAUDE.md priority 15), kept in this browser.
// (Split out of App.jsx; no behaviour change.)
import { useState, useCallback } from "react";

// ─── CRM ───────────────────────────────────────────────────────────
export const CRM_KEY      = "fx_crm_state";
export const CRM_STATUSES = ["new","reviewed","saved","contacted","follow_up","replied","meeting_booked","passed_to_closer","not_relevant"];
export const CRM_LABELS   = {
  new:             "New",
  reviewed:        "Reviewed",
  saved:           "Saved",
  contacted:       "Contacted",
  follow_up:       "Follow up",
  replied:         "Replied",
  meeting_booked:  "Meeting booked",
  passed_to_closer:"Passed to closer",
  not_relevant:    "Not relevant",
};
export const CRM_COLORS   = {
  new:             "#6366F1",
  reviewed:        "#F59E0B",
  saved:           "#10B981",
  contacted:       "#38BDF8",
  follow_up:       "#F97316",
  replied:         "#FBBF24",
  meeting_booked:  "#10B981",
  passed_to_closer:"#A855F7",
  not_relevant:    "#475569",
};

export function isoDaysFromNow(days) {
  const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString();
}

export function scheduleNextFollowUp(touchCount, action) {
  // touchCount is after increment
  if (action === "replied") return null;
  if (action === "meeting_booked") return null;
  if (action === "not_relevant") return null;
  if (touchCount <= 1) return isoDaysFromNow(2);
  if (touchCount === 2) return isoDaysFromNow(4);
  if (touchCount === 3) return isoDaysFromNow(7);
  return null; // move to nurture
}

export function computeRouteGrade(lead) {
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

export function useCrmState() {
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
      // a reply is their move, not a touch of ours: the touch count and last-contacted date stay as they were
      const ours = action !== "follow_later" && action !== "replied";
      const touch = (cur.touch_count||0) + (ours ? 1 : 0);
      const last_channel = action === "called" ? "phone" : action === "email_sent" ? "email" : action === "linkedin_sent" ? "linkedin" : action === "replied" ? "reply" : action === "meeting_booked" ? "meeting" : cur.last_channel || null;
      const status = action === "not_relevant" ? "not_relevant" : action === "replied" ? "replied" : action === "meeting_booked" ? "meeting_booked" : "contacted";
      const next_follow_up_at = scheduleNextFollowUp(touch, action);
      const next = {
        ...prev,
        [id]: {
          ...cur,
          last_contacted_at: ours ? new Date().toISOString() : cur.last_contacted_at || null,
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
