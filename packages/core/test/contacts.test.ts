import { describe, it, expect } from "vitest";
import { extractContactInfo, bestContactRoute, hasContactRoute, clearContactFields, ensureContactFields } from "../src/contacts.js";

const SAMPLE_HTML = `
<html><head><title>Acme Wine Importers Ltd</title></head><body>
  <header>
    <a href="tel:+44 (0)20 7946 0123">Call us</a>
  </header>
  <main>
    <p>We import wine direct from Italy. Trade customers welcome.</p>
    <p>General enquiries: <a href="mailto:info@acmewine.co.uk">info@acmewine.co.uk</a>
       &nbsp; Accounts: <a href="mailto:accounts@acmewine.co.uk?subject=invoice">accounts@acmewine.co.uk</a></p>
    <p>Or phone the office on 0161 555 9988.</p>
  </main>
  <nav>
    <a href="/contact-us">Contact</a>
    <a href="/about">About us</a>
    <a href="/our-team">Meet the team</a>
    <a href="https://otherdirectory.com/listings/acme">Listed on a directory</a>
    <a href="https://twitter.com/acmewine">Twitter</a>
  </nav>
  <footer>For website issues email webmaster@somehost.net</footer>
</body></html>`;

describe("extractContactInfo", () => {
  it("pulls phones (tel: + free-text), domain-scoped emails (ranked), and contact/about/team links", () => {
    const c = extractContactInfo(SAMPLE_HTML, "https://www.acmewine.co.uk/", "acmewine.co.uk");
    expect(c.contact_phone).toBe("+44 (0)20 7946 0123");
    expect(c.contact_phones).toEqual(["+44 (0)20 7946 0123", "0161 555 9988"]);
    expect(c.contact_email).toBe("accounts@acmewine.co.uk");           // finance prefix ranks first
    expect(c.contact_emails_found).toEqual(["accounts@acmewine.co.uk", "info@acmewine.co.uk"]);
    expect(c.contact_emails_found).not.toContain("webmaster@somehost.net");  // off-domain → dropped
    expect(c.contact_page).toBe("https://www.acmewine.co.uk/contact-us");
    expect(c.about_page).toBe("https://www.acmewine.co.uk/about");
    expect(c.team_page).toBe("https://www.acmewine.co.uk/our-team");
  });

  it("ignores off-domain / social / mailto / tel links when picking page links", () => {
    const c = extractContactInfo(`<a href="https://facebook.com/x">fb</a><a href="https://acme.co.uk/contact">Contact</a>`, "https://acme.co.uk/", "acme.co.uk");
    expect(c.contact_page).toBe("https://acme.co.uk/contact");
  });

  it("derives the base domain from base_url when company_domain omitted", () => {
    const c = extractContactInfo(`<a href="mailto:hello@acme.co.uk">e</a><a href="mailto:bob@other.com">o</a>`, "https://acme.co.uk/");
    expect(c.contact_emails_found).toEqual(["hello@acme.co.uk"]);
  });

  it("returns the all-keys-present empty shape for empty / unparseable HTML", () => {
    expect(extractContactInfo("", "https://x.co.uk")).toEqual({
      contact_phone: null, contact_phones: [], contact_email: null, contact_emails_found: [],
      contact_page: null, about_page: null, team_page: null,
    });
  });

  it("does not treat a date-like number as a phone", () => {
    const c = extractContactInfo(`<p>Founded in 2010. Updated 12/03/2024.</p>`, "https://x.co.uk", "x.co.uk");
    expect(c.contact_phone).toBeNull();
  });
});

describe("bestContactRoute", () => {
  it("prefers an on-page finance email", () => {
    const c = extractContactInfo(SAMPLE_HTML, "https://www.acmewine.co.uk/", "acmewine.co.uk");
    expect(bestContactRoute({ website: "https://acmewine.co.uk", director_name: "Jane Doe", director_role: "FD", ...c }))
      .toMatch(/^Email accounts@acmewine\.co\.uk directly \(accounts\/finance\)/);
  });
  it("falls back: phone → generic email → contact page → director → guessed generic → website → none", () => {
    expect(bestContactRoute({ contact_phone: "020 7946 0000", director_name: "Bob", director_role: "MD" })).toMatch(/^Call the switchboard on 020 7946 0000 — ask for Bob \(MD\)\.$/);
    expect(bestContactRoute({ contact_emails_found: ["info@x.co.uk"] })).toMatch(/^Email info@x\.co\.uk/);
    expect(bestContactRoute({ contact_page: "https://x.co.uk/contact", director_name: "Sue" })).toMatch(/^Use the contact page \(https:\/\/x\.co\.uk\/contact\) — ask for Sue\.$/);
    expect(bestContactRoute({ director_name: "Pat", director_role: "Director" })).toMatch(/^Look up Pat \(Director\) on LinkedIn/);
    expect(bestContactRoute({ guessed_emails: [{ email: "p@x.co.uk" }] })).toMatch(/try p@x\.co\.uk/);
    expect(bestContactRoute({ website: "https://x.co.uk" })).toMatch(/^Pull the phone number/);
    expect(bestContactRoute({})).toMatch(/^No contact route yet/);
  });
});

describe("hasContactRoute / clear / ensure", () => {
  it("hasContactRoute is true if any route exists", () => {
    expect(hasContactRoute({ website: "https://x.co.uk" })).toBe(true);
    expect(hasContactRoute({})).toBe(false);
  });
  it("clearContactFields wipes the 7 fields; ensureContactFields fills missing ones", () => {
    const l: Record<string, unknown> = { contact_phone: "x", contact_emails_found: ["a@b"] };
    clearContactFields(l);
    expect(l.contact_phone).toBeNull();
    expect(l.contact_emails_found).toEqual([]);
    const m: Record<string, unknown> = { contact_phone: "keep" };
    ensureContactFields(m);
    expect(m.contact_phone).toBe("keep");        // not overwritten
    expect(m.contact_email).toBeNull();
    expect(m.contact_phones).toEqual([]);
  });
});
