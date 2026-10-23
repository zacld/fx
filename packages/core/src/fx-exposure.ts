/**
 * fx-exposure.ts — rule-based FX Exposure Score (0–100).
 *
 * A supplementary scoring dimension that estimates how commercially exposed a
 * company is to FX risk / how well it fits the target industry. Added to each
 * lead after the gate-based scoreLead() in the score stage — it does NOT
 * override or bypass any scoring gate.
 *
 * Six dimensions:
 *   SIC match          0–25   SIC code matches preset/trade SIC prefixes?
 *   Website signals    0–20   Preset-specific or FX signals found on site?
 *   Company age        0–15   2–15yr sweet spot (established but not legacy)
 *   Director tenure    0–10   Director appointed < 24 months (open to change?)
 *   Activity signals   0–10   Multi-event trigger, strong FX signal count
 *   Size band          0–20   Turnover £1m–£25m (UK SME target)
 *
 * Total: 100 max. All pure functions — no I/O, no side effects.
 */

/** Minimal interface compatible (structurally) with IndustryPreset from industries.ts. */
export interface FxExposurePreset {
  sicCodes?: string[];
  websiteSignals?: string[];
}

/** Minimal lead-shaped input — accepts a full Lead or any compatible partial. */
export interface FxExposureInput {
  sic_codes?: string[];
  fx_payment_signals?: string[];
  segment_signals?: string[];
  b2b_signals?: string[];
  secondary_signals?: string[];
  website_snippet?: string;
  incorporated?: string | null;
  decision_makers?: Array<{ appointed_on?: string | null }>;
  accounts_turnover_band?: string;
  pays_fx_confirmed?: boolean;
  multi_event_trigger?: boolean;
  multi_event_count?: number;
}

/** Compute FX exposure score (0–100). Pure function — no I/O. */
export function computeFxExposureScore(lead: FxExposureInput, preset?: FxExposurePreset): number {
  let total = 0;

  // ── 1. SIC match (0–25) ────────────────────────────────────────────────────
  const sics = (lead.sic_codes ?? []).map(String);
  if (sics.length > 0) {
    const prefixes = preset?.sicCodes?.length ? preset.sicCodes : ["46", "47", "50", "51", "52"];
    const mfgRange = (sic: string) => { const n2 = parseInt(sic.slice(0, 2), 10); return Number.isFinite(n2) && n2 >= 10 && n2 <= 33; };
    const matched = sics.some((s) => prefixes.some((p) => s.startsWith(p)) || (preset?.sicCodes == null && mfgRange(s)));
    total += matched ? 25 : 5; // small baseline for any known-SIC company
  }

  // ── 2. Website signals (0–20) ──────────────────────────────────────────────
  const allSignals = [
    ...(lead.fx_payment_signals ?? []),
    ...(lead.segment_signals ?? []),
    ...(lead.b2b_signals ?? []),
    ...(lead.secondary_signals ?? []),
  ].map((s) => s.toLowerCase());
  const snippet = (lead.website_snippet ?? "").toLowerCase();

  let sigScore = 0;
  if (preset?.websiteSignals?.length) {
    const hits = preset.websiteSignals.filter((sig) => {
      const sl = sig.toLowerCase();
      return allSignals.some((s) => s.includes(sl)) || snippet.includes(sl);
    }).length;
    sigScore = Math.min(20, hits * 5);
  } else {
    // No preset — reward raw FX payment signal count
    sigScore = Math.min(20, (lead.fx_payment_signals ?? []).length * 5);
  }
  if (lead.pays_fx_confirmed) sigScore = Math.min(20, sigScore + 5);
  total += sigScore;

  // ── 3. Company age (0–15) ──────────────────────────────────────────────────
  if (lead.incorporated) {
    const ageYrs = (Date.now() - new Date(lead.incorporated).getTime()) / (365.25 * 24 * 3600 * 1000);
    if (ageYrs >= 2 && ageYrs <= 15) total += 15;
    else if (ageYrs > 15 && ageYrs <= 30) total += 8;
    else if (ageYrs > 1 && ageYrs < 2) total += 5;
    // <1 yr or >30 yr = 0
  }

  // ── 4. Director tenure (0–10) ─────────────────────────────────────────────
  const hasRecentDirector = (lead.decision_makers ?? []).some((dm) => {
    if (!dm.appointed_on) return false;
    const months = (Date.now() - new Date(dm.appointed_on).getTime()) / (30 * 24 * 3600 * 1000);
    return months <= 24;
  });
  if (hasRecentDirector) total += 10;

  // ── 5. Activity signals (0–10) ────────────────────────────────────────────
  if (lead.multi_event_trigger) total += 6;
  else if ((lead.multi_event_count ?? 1) > 1) total += 3;
  if ((lead.fx_payment_signals ?? []).length >= 3) total += 4;

  // ── 6. Size band / turnover (0–20) ────────────────────────────────────────
  const band = lead.accounts_turnover_band ?? "";
  if (band === "1-5m" || band === "5-25m") total += 20;
  else if (band === "25m+") total += 12;
  else if (band === "<1m") total += 4;
  // "" (unknown) = 0

  return Math.min(100, Math.max(0, total));
}
