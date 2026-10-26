// Fetching the events (public) and the leads (behind the Accounts password).
// (Split out of App.jsx; no behaviour change.)
// Leads hold director names, phones and emails, so they come from /api/leads behind the Accounts password
// (gzipped; un-gzipped here). Events are market analysis only and stay a public file.
export const PW_KEY = "fx-accounts-password";   // the Accounts page's key: unlocked there = unlocked here
export const rememberedPw = () => { try { return sessionStorage.getItem(PW_KEY) || ""; } catch { return ""; } };
export const rememberPw = (pw) => { try { pw ? sessionStorage.setItem(PW_KEY, pw) : sessionStorage.removeItem(PW_KEY); } catch { /* private mode */ } };

export async function fetchLeads(password) {
  if (import.meta.env.DEV) {   // local dev: the file the pipeline writes (no Netlify functions under vite)
    const r = await fetch(`${import.meta.env.BASE_URL}data/leads.json?t=${Date.now()}`);
    return { leads: r.ok ? await r.json() : {}, locked: false };
  }
  if (!password) return { leads: {}, locked: true };
  const r = await fetch("/api/leads", { headers: { authorization: `Bearer ${password}` }, cache: "no-store" });
  if (r.status === 401) return { leads: {}, locked: true, error: "Wrong password." };
  if (!r.ok) return { leads: {}, locked: false, error: (await r.json().catch(() => ({}))).error || `Leads unavailable (${r.status}).` };
  const text = await new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).text();
  return { leads: JSON.parse(text), locked: false };
}

export async function fetchData(password) {
  const [evRes, ld] = await Promise.all([
    fetch(`${import.meta.env.BASE_URL}data/events.json?t=${Date.now()}`),
    fetchLeads(password),
  ]);
  const evObj = evRes.ok ? await evRes.json() : {};
  return {
    events: Object.values(evObj).sort((a,b)=>new Date(b.detected_at||0)-new Date(a.detected_at||0)),
    leads:  Object.values(ld.leads).sort((a,b)=>(b.score||0)-(a.score||0)),
    locked: ld.locked, error: ld.error || "",
  };
}
