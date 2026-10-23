// Helpers for the /moves page: describe the pound's moves, find recent events
// that explain them, and match moves to accounts on the list.

export const WINDOW_WORDS = { "1d": "since yesterday", "1w": "over the last week", "1m": "over the last month", "3m": "over the last 3 months" };
const PLURAL = { euro: "euros", "US dollar": "dollars" };

export const gbp = (n) => `£${Math.abs(Math.round(n)).toLocaleString("en-GB")}`;
export const pct = (n) => (Math.abs(n) < 0.05 ? "0.0%" : `${n > 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}%`);

// The window a move is shown for: the longest material one, else 1 month.
export const mainWindow = (cur) => (cur.material?.includes("3m") && !cur.material?.includes("1m") ? "3m" : "1m");

export function describeMove(cur, w = mainWindow(cur)) {
  const change = cur.changes?.[w];
  if (change === undefined) return "";
  const dir = change < 0 ? "fallen" : "risen";
  return `The pound has ${dir} ${Math.abs(change).toFixed(1)}% against the ${cur.name} ${WINDOW_WORDS[w]}`;
}

// "Every €1m of purchases now costs £20,000 more than on 21 Sep" (official rates arithmetic, not an estimate)
export function impactLine(cur, w = mainWindow(cur), flow = "purchases") {
  const pm = cur.impact_per_million?.[w];
  if (pm === undefined || !cur.since?.[w]) return "";
  const unit = `${cur.symbol || cur.code + " "}1m`;
  const when = new Date(cur.since[w]).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return flow === "purchases"
    ? `Every ${unit} of purchases now costs ${gbp(pm)} ${pm >= 0 ? "more" : "less"} than on ${when}`
    : `Every ${unit} of sales now brings in ${gbp(pm)} ${pm >= 0 ? "more" : "less"} than on ${when}`;
}

const BUYS = "Buys (importer)", SELLS = "Sells (exporter)", BOTH = "Both";

// How a move lands on an account: "hurt" (call now) or "helped" (a lock-in angle), and the call line.
export function effectOn(account, cur, w = mainWindow(cur)) {
  const change = cur.changes?.[w];
  const dir = account.currency_direction;
  if (change === undefined || ![BUYS, SELLS, BOTH].includes(dir)) return null;
  const poundFell = change < 0;
  const buys = dir === BUYS || dir === BOTH, sells = dir === SELLS || dir === BOTH;
  const hurt = (poundFell && buys) || (!poundFell && sells);
  const name = PLURAL[cur.name] || cur.name;
  const flow = buys && (poundFell || !sells) ? "purchases" : "sales";
  const role = flow === "purchases" ? `${cur.name} buyer` : `${cur.name} seller`;
  const line = `${describeMove(cur, w)} — as a ${role}, ${impactLine(cur, w, flow).replace(/^Every/, "every")}.`;
  return {
    hurt,
    line,
    angle: hurt ? `${flow === "purchases" ? "Costs up" : "Takings down"} in ${name}` : `Better rate for ${flow} in ${name}: lock-in angle`,
  };
}

// Accounts on the list this currency move touches (not those qualified out), hurt first.
export function affected(accounts, cur, w = mainWindow(cur)) {
  return accounts
    .filter((a) => a.main_currency === cur.code && a.qualified !== "Out")
    .map((a) => ({ account: a, effect: effectOn(a, cur, w) }))
    .filter((x) => x.effect)
    .sort((x, y) => Number(y.effect.hurt) - Number(x.effect.hurt) || (x.account.rank ?? 1e9) - (y.account.rank ?? 1e9));
}

// Recent events from the event-led engine that name this currency against the pound.
export function eventsFor(events, code, asOf, days = 7, strengths = ["strong", "medium"], now = Date.now()) {
  // From `days` before the last fixing up to now: weekend and same-morning news explains a Monday's move.
  const DAY = 86_400_000;
  const start = (asOf ? Date.parse(`${asOf}T00:00:00Z`) : now) - days * DAY;
  return events
    .filter((e) => (e.currency_pairs || []).some((p) => p === `GBP/${code}` || p === `${code}/GBP`))
    .filter((e) => strengths.includes(e.trigger_strength))
    .filter((e) => { const t = Date.parse(e.detected_at); return t >= start && t <= now; })
    .sort((a, b) => (b.detected_at || "").localeCompare(a.detected_at || ""));
}
