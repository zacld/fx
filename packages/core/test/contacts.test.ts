import { describe, it, expect } from "vitest";
import {
  extractContactInfo, bestContactRoute, hasContactRoute, clearContactFields, ensureContactFields,
  parsePhone, deobfuscateCloudflareEmails, deobfuscateAtDot,
} from "../src/contacts.js";

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
    // libphonenumber-js normalises display to national format.
    expect(c.contact_phone).toBe("020 7946 0123");
    expect(c.contact_phones).toEqual(["020 7946 0123", "0161 555 9988"]);
    expect(c.contact_phones_e164).toEqual(["+442079460123", "+441615559988"]);
    expect(c.contact_phone_types[0]).toBe("fixed_line");
    expect(c.contact_email).toBe("accounts@acmewine.co.uk");           // finance prefix ranks first
    expect(c.contact_emails_found).toEqual(["accounts@acmewine.co.uk", "info@acmewine.co.uk"]);
    expect(c.contact_emails_found).not.toContain("webmaster@somehost.net");  // off-domain → dropped
    expect(c.contact_page).toBe("https://www.acmewine.co.uk/contact-us");
    expect(c.about_page).toBe("https://www.acmewine.co.uk/about");
    expect(c.team_page).toBe("https://www.acmewine.co.uk/our-team");
  });

  it("dedupes phones written in different formats to one entry", () => {
    const html = `<a href="tel:+44 20 7946 0123">x</a><p>Call us on 020 7946 0123 or +44 (0)20 7946 0123 anytime.</p>`;
    const c = extractContactInfo(html, "https://x.co.uk/", "x.co.uk");
    expect(c.contact_phones_e164).toEqual(["+442079460123"]);
    expect(c.contact_phones.length).toBe(1);
  });

  it("decodes Cloudflare email obfuscation", () => {
    // "info@acme.co.uk" obfuscated with key 0x9a:
    // letters i n f o @ a c m e . c o . u k → XOR with 0x9a:
    //   i(0x69)=0xf3 n(0x6e)=0xf4 f(0x66)=0xfc o(0x6f)=0xf5 @(0x40)=0xda
    //   a(0x61)=0xfb c(0x63)=0xf9 m(0x6d)=0xf7 e(0x65)=0xff
    //   .(0x2e)=0xb4 c(0x63)=0xf9 o(0x6f)=0xf5 .(0x2e)=0xb4 u(0x75)=0xef k(0x6b)=0xf1
    const html = `<a class="__cf_email__" data-cfemail="9af3f4fcf5dafbf9f7ffb4f9f5b4eff1">[email protected]</a>`;
    const c = extractContactInfo(html, "https://acme.co.uk/", "acme.co.uk");
    expect(c.contact_emails_found).toContain("info@acme.co.uk");
  });

  it("decodes [at]/[dot] obfuscation", () => {
    const c = extractContactInfo(`<p>Email james [at] acme [dot] co [dot] uk</p>`, "https://acme.co.uk/", "acme.co.uk");
    expect(c.contact_emails_found).toContain("james@acme.co.uk");
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
      contact_phone: null, contact_phones: [], contact_phones_e164: [], contact_phone_types: [],
      contact_email: null, contact_emails_found: [],
      contact_page: null, about_page: null, team_page: null,
    });
  });

  it("does not treat a date-like number as a phone", () => {
    const c = extractContactInfo(`<p>Founded in 2010. Updated 12/03/2024.</p>`, "https://x.co.uk", "x.co.uk");
    expect(c.contact_phone).toBeNull();
  });
});

describe("parsePhone", () => {
  it("normalises UK numbers across common formats and reports type", () => {
    for (const raw of ["+44 20 7946 0123", "020 7946 0123", "+44 (0)20 7946 0123", "0207 946 0123"]) {
      const p = parsePhone(raw);
      expect(p?.e164).toBe("+442079460123");
      expect(p?.display).toBe("020 7946 0123");
      expect(p?.type).toBe("fixed_line");
    }
  });
  it("detects mobile vs fixed_line", () => {
    expect(parsePhone("07911 123456")?.type).toBe("mobile");
    expect(parsePhone("020 7946 0123")?.type).toBe("fixed_line");
  });
  it("returns null for things that aren't phone numbers", () => {
    expect(parsePhone("12/03/2024")).toBeNull();
    expect(parsePhone("")).toBeNull();
  });
});

describe("deobfuscators", () => {
  it("deobfuscateCloudflareEmails is idempotent on non-CF input", () => {
    expect(deobfuscateCloudflareEmails("<a>hello</a>")).toBe("<a>hello</a>");
  });
  it("deobfuscateAtDot handles brackets and word-space variants", () => {
    expect(deobfuscateAtDot("james[at]acme[dot]co[dot]uk")).toBe("james@acme.co.uk");
    expect(deobfuscateAtDot("james (at) acme (dot) com")).toBe("james@acme.com");
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
  it("clearContactFields wipes every contact field; ensureContactFields fills missing ones", () => {
    const l: Record<string, unknown> = { contact_phone: "x", contact_emails_found: ["a@b"], contact_phones_e164: ["+44…"] };
    clearContactFields(l);
    expect(l.contact_phone).toBeNull();
    expect(l.contact_emails_found).toEqual([]);
    expect(l.contact_phones_e164).toEqual([]);
    expect(l.contact_phone_types).toEqual([]);
    const m: Record<string, unknown> = { contact_phone: "keep" };
    ensureContactFields(m);
    expect(m.contact_phone).toBe("keep");        // not overwritten
    expect(m.contact_email).toBeNull();
    expect(m.contact_phones).toEqual([]);
    expect(m.contact_phones_e164).toEqual([]);
    expect(m.contact_phone_types).toEqual([]);
  });
});
