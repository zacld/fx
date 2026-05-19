/**
 * sources/blocklists.ts — domains / URL paths / result titles that are never a
 * real company website. Used to filter DDG / Bing search results and source-page
 * outbound links. Port of the SKIP_* sets in scripts/discover_web.py (kept as a
 * representative set — this list is meant to grow; keep roughly in sync).
 */

export const SKIP_DOMAINS: ReadonlySet<string> = new Set([
  // UK trade directories / business listings
  "yell.com", "yell.co.uk", "yelp.com", "yelp.co.uk", "freeindex.co.uk", "thomsonlocal.com",
  "scoot.co.uk", "cylex.co.uk", "cylex-uk.co.uk", "hotfrog.co.uk", "brownbook.net", "misterwhat.co.uk",
  "kompass.com", "uk.kompass.com", "checkatrade.com", "ratedpeople.com", "bark.com", "rated.co.uk",
  "mybuilder.com", "trustatrader.com", "trustmark.org.uk", "getapp.co.uk", "bizwiki.co.uk", "192.com",
  "ukbusinessdirectory.co.uk", "thewholesaler.co.uk", "dinainternational.co.uk",
  // company intelligence / aggregators / registries
  "companieshouse.gov.uk", "find-and-update.company-information.service.gov.uk", "companies.house.gov.uk",
  "beta.companieshouse.gov.uk", "endole.co.uk", "duedil.com", "creditsafe.com", "experian.co.uk",
  "equifax.co.uk", "crunchbase.com", "pitchbook.com", "dnb.com", "dnb.co.uk", "opencorporates.com",
  "companieshouse.data.gov.uk", "bizdb.co.uk", "companycheck.co.uk", "companydata.co.uk", "bizbuysell.com",
  "globaldata.com", "ibisworld.com", "statista.com", "marketresearch.com", "mordorintelligence.com",
  "grandviewresearch.com", "grokipedia.com", "ensun.io", "craft.co", "zoominfo.com", "apollo.io",
  "leadiq.com", "hunter.io", "rocketreach.co",
  // industry-specific aggregators / chemical directories
  "chemeurope.com", "europages.co.uk", "europages.com", "thomasnet.com", "alibaba.com", "made-in-china.com",
  "globalsources.com", "tradekey.com", "eceurope.com", "chemspider.com", "sigmaaldrich.com", "icis.com",
  "chemanalyst.com", "cheminfo.com", "lookchem.com", "molbase.com", "italianfoodnews.com",
  "beveragetradenetwork.com", "beveragetradenews.com",
  // social media
  "linkedin.com", "facebook.com", "instagram.com", "twitter.com", "x.com", "tiktok.com", "youtube.com",
  "pinterest.com", "reddit.com", "whatsapp.com", "telegram.org",
  // news / media
  "bbc.co.uk", "bbc.com", "reuters.com", "ft.com", "bloomberg.com", "guardian.com", "theguardian.com",
  "telegraph.co.uk", "thetimes.co.uk", "independent.co.uk", "dailymail.co.uk", "sky.com", "itv.com",
  "forbes.com", "businessinsider.com", "techcrunch.com", "cityam.com", "thisismoney.co.uk", "thegrocer.co.uk",
  "foodmanufacture.co.uk", "just-drinks.com", "thedrinksbusiness.com", "decanter.com", "harpers.co.uk",
  "foodnavigator.com", "seafoodsource.com", "undercurrentnews.com", "chemweek.com",
  // government / NGO / trade associations
  "gov.uk", "hmrc.gov.uk", "legislation.gov.uk", "parliament.uk", "nhs.uk", "acas.org.uk", "ico.org.uk",
  "fca.org.uk", "cma.gov.uk", "food.gov.uk", "wsta.co.uk", "scotchwhisky.com", "swa.org.uk", "fdf.org.uk",
  "seafish.org", "cefic.org",
  // search / tech / reference / major cloud/SaaS whose pages are not companies
  "google.com", "google.co.uk", "bing.com", "yahoo.com", "duckduckgo.com", "wikipedia.org", "wikimedia.org",
  "wikidata.org", "microsoft.com", "azure.microsoft.com", "office.com", "office365.com",
  "salesforce.com", "hubspot.com", "shopify.com", "shopify.co.uk", "squarespace.com", "wix.com",
  "wordpress.com", "medium.com", "substack.com", "quora.com", "stackoverflow.com",
  // review / comparison sites
  "trustpilot.com", "glassdoor.com", "glassdoor.co.uk", "reviews.co.uk", "reviews.io", "reevoo.com", "feefo.com",
  "which.co.uk", "moneysavingexpert.com", "comparethemarket.com", "tripadvisor.com", "tripadvisor.co.uk",
  "booking.com", "airbnb.com", "airbnb.co.uk", "tripadvisor.co.uk",
  // marketplaces / B2C retail
  "amazon.co.uk", "amazon.com", "ebay.co.uk", "ebay.com", "etsy.com", "notonthehighstreet.com",
  "wayfair.co.uk", "asos.com", "next.co.uk", "argos.co.uk", "johnlewis.com", "gumtree.com", "preloved.co.uk",
  "onbuy.com", "manomano.co.uk", "aliexpress.com", "wish.com", "depop.com", "vinted.co.uk",
  // property portals
  "rightmove.co.uk", "zoopla.co.uk", "onthemarket.com", "propertypal.com",
  // job boards / HR
  "reed.co.uk", "indeed.com", "indeed.co.uk", "totaljobs.com", "cv-library.co.uk", "monster.co.uk",
  "jobs.co.uk", "seek.com", "fish4.co.uk", "workable.com", "caterer.com", "michaelpage.co.uk", "hays.co.uk",
  "robertwalters.co.uk", "linkedin.com/jobs", "ziprecruiter.co.uk",
  // AI / lead-gen / generic aggregators
  "clutch.co", "goodfirms.co", "g2.com", "capterra.com", "getapp.com", "sortlist.co.uk", "upcity.com",
  "semrush.com", "similarweb.com",
]);

export const SKIP_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /\/blog\//, /\/news\//, /\/newsroom\//, /\/press-release/, /\/article\//, /\/articles\//, /\/forum\//, /\/community\//,
  /\/wiki\//, /\/help\//, /\/support\/faq/, /\/jobs\//, /\/careers\//, /\/recruit/, /\/vacancies/,
  /\/login/, /\/signup/, /\/register/, /\/checkout/, /\/basket/, /\/cart/, /\/search\?/, /\/results\?/,
  /\/find\?/, /\/category\//, /\/tag\//, /\/author\//, /\.pdf$/, /\.docx?$/, /\.xlsx?$/,
  // content / resource pages — not company homepages
  /\/collections\//, /\/insights\//, /\/guides?\//, /\/resources\//, /\/case-stud/, /\/white-paper/,
  /\/infographic/, /\/podcast\//, /\/webinar\//, /\/event\//, /\/pricing\/details\//,
];

export const SKIP_TITLE_PATTERNS: ReadonlyArray<RegExp> = [
  /^\d+\s+(companies|businesses|suppliers|importers|exporters|distributors|wholesalers)/i,
  /^(top|best|leading|largest|biggest)\s+\d+/i, /^list of\s/i, /directory\s*(of|for)/i,
  /\bsuppliers?\s+in\s+/i, /\bcompanies?\s+in\s+/i, /^search results/i, /trade show/i,
  /\bmarket report\b/i, /\bindustry report\b/i, /\bcompare\s+/i, /\breviews?\s+(of|for)\b/i,
  /^(find|discover)\s+(a|the|your)\s+/i, /\d+\s+importer/i, /\d+\s+exporter/i, /\d+\s+supplier/i,
  /database of\s/i, /register of\s/i,
  // news / statistics headlines — not company pages
  /industry records\s+[£$€]/, /\brecords?\s+[\$£€][\d.]+[bm]n?\b/i,
  /^how to\s+/i, /^guide\s+(to|for)\s+/i, /\b202\d\s+guide\b/i,
  /^(buy|shop|order)\s+[\w\s]+\s+online\b/i,
  // cloud/SaaS product pages
  /pricing\s*[-–—|:]\s*(cloud|azure|aws|saas)/i,
];

export function domainFromUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\d*\./, "");
    return host || null;
  } catch {
    return null;
  }
}

function domainBlocked(domain: string): string | null {
  for (const s of SKIP_DOMAINS) if (domain === s || domain.endsWith(`.${s}`)) return s;
  return null;
}

/** Returns { skip, reason }. true = drop this result/link. */
export function shouldSkipUrl(url: string): { skip: boolean; reason: string } {
  if (!url || !/^https?:\/\//i.test(url)) return { skip: true, reason: "not a valid http URL" };
  const domain = domainFromUrl(url);
  if (!domain) return { skip: true, reason: "could not parse domain" };
  const blocked = domainBlocked(domain);
  if (blocked) return { skip: true, reason: `blocked domain: ${blocked}` };
  let path = "";
  try { path = new URL(url).pathname.toLowerCase(); } catch { path = ""; }
  for (const re of SKIP_PATH_PATTERNS) if (re.test(path)) return { skip: true, reason: `blocked path: ${re}` };
  return { skip: false, reason: "" };
}

export function shouldSkipTitle(title: string): { skip: boolean; reason: string } {
  if (!title) return { skip: false, reason: "" };
  for (const re of SKIP_TITLE_PATTERNS) if (re.test(title)) return { skip: true, reason: `title pattern: ${re}` };
  return { skip: false, reason: "" };
}

// ── company-name ↔ domain coherence (port of discover_web.py domain_coherent_with_name) ──
const _NAME_STOPS = new Set([
  "ltd", "limited", "plc", "llp", "uk", "the", "and", "of", "co", "company", "group",
  "services", "solutions", "trading", "enterprises", "holdings", "international",
]);
export function nameTokens(name: string): Set<string> {
  return new Set((name.toLowerCase().match(/[a-z]+/g) ?? []).filter((t) => !_NAME_STOPS.has(t)));
}
function domainTokens(domain: string): Set<string> {
  const base = domain.toLowerCase().replace(/\.(co\.uk|com|co|uk|net|org|io|biz)$/, "");
  return new Set((base.match(/[a-z]{3,}/g) ?? []));
}
/** Does the domain plausibly belong to the company in the search title? */
export function domainCoherentWithName(domain: string, searchTitle: string): boolean {
  const nTok = nameTokens(searchTitle);
  if (nTok.size === 0) return true;                              // can't check — benefit of the doubt
  const dTok = domainTokens(domain);
  for (const t of dTok) if (nTok.has(t)) return true;
  const base = domain.split(".")[0]!.toLowerCase();
  for (const t of nTok) if (t.length >= 4 && base.includes(t)) return true;
  if (base.length <= 8) return true;                             // short brand-like domains are often valid
  return false;
}
