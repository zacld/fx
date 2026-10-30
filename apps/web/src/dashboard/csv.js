// CSV export of the visible leads.
// (Split out of App.jsx; no behaviour change.)
// ─── CSV / Sheets export ──────────────────────────────────────────────────────
import { safeCell } from "../accounts/format.js";

export function leadsToCSV(leads, crmState = {}) {
  const headers = [
    "Rank","Company","Website","Segment","Director","Role","Phone","Email",
    "FX Signals (n)","FX Signals","Exposure Thesis","Why Now",
    "Score","Priority","Accounts Type","Route Grade","LinkedIn Director",
    "CRM Status","Touches","Last Contacted","Next Follow-up","Notes","Rescored At"
  ];
  const esc = v => {
    const s = safeCell((v ?? "").toString()).replace(/"/g,'""');
    return /[",\n\r]/.test(s) ? `"${s}"` : s;
  };
  const rows = leads.map((l, i) => {
    const dms = l.decision_makers || [];
    const dm = dms.find(d=>d.tier===1) || dms[0] || {};
    const liUrl = dm.linkedin_search || dm.linkedin_url || "";
    const email = l.contact_email || dm.email_candidate || dm.email || "";
    const phone = l.contact_phone || "";
    const crmKey = l.id || l.company_name || "";
    const crm = crmState[crmKey] || {};
    return [
      i+1, l.company_name_clean || l.company_name, l.website, l.segment_name,
      l.director_name || (dm.first_name ? `${dm.first_name} ${dm.last_name||""}`.trim() : ""),
      l.director_role || dm.role || "",
      phone, email,
      (l.fx_payment_signals||[]).length,
      (l.fx_payment_signals||[]).slice(0,6).join("; "),
      l.exposure_thesis || l.why_affected || "",
      l.why_now || "",
      l.score, l.priority, l.accounts_type || "",
      l.route_grade || "", liUrl,
      crm.status || "new", crm.touch_count || 0,
      crm.last_contacted_at || "", crm.next_follow_up_at || "",
      crm.notes || "", l.rescored_at || ""
    ].map(esc).join(",");
  });
  return [headers.join(","), ...rows].join("\n");
}

export function downloadCSV(leads, filename, crmState = {}) {
  const csv = leadsToCSV(leads, crmState);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
