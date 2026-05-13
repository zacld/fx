import { describe, it, expect } from "vitest";
import { extractPeople, classifyRole } from "../src/people.js";

describe("classifyRole", () => {
  it("maps common roles to tier + canonical label", () => {
    expect(classifyRole("Finance Director")?.tier).toBe(1);
    expect(classifyRole("CFO")?.label).toBe("CFO");
    expect(classifyRole("Managing Director")?.tier).toBe(1);
    expect(classifyRole("Commercial Director")?.tier).toBe(2);
    expect(classifyRole("Sales Director")?.tier).toBe(2);
    expect(classifyRole("Company Secretary")?.tier).toBe(3);
    expect(classifyRole("Director")?.tier).toBe(3);
    expect(classifyRole("Janitor")).toBeNull();
  });
});

describe("extractPeople", () => {
  it("reads schema.org/Person from JSON-LD with jobTitle and email", () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Organization",
      "employee": [{
        "@type": "Person", "name": "James Smith", "jobTitle": "Finance Director",
        "email": "mailto:james@acme.co.uk",
      }],
    })}</script></head><body></body></html>`;
    const people = extractPeople(html, "acme.co.uk");
    expect(people).toHaveLength(1);
    expect(people[0]!.name).toBe("James Smith");
    expect(people[0]!.tier).toBe(1);
    expect(people[0]!.role_canonical).toBe("Finance Director");
    expect(people[0]!.email).toBe("james@acme.co.uk");
    expect(people[0]!.source).toBe("jsonld");
  });

  it("reads team-card HTML structure (h3 name + sibling role)", () => {
    const html = `<div class="team">
      <div class="card"><h3>Jane Doe</h3><p>Managing Director — runs the show.</p></div>
      <div class="card"><h3>Bob Brown</h3><p>Sales Director</p></div>
    </div>`;
    const people = extractPeople(html);
    const jane = people.find((p) => p.name === "Jane Doe");
    expect(jane?.role_canonical).toBe("Managing Director");
    expect(jane?.tier).toBe(1);
    expect(jane?.source).toBe("structure");
    expect(people.find((p) => p.name === "Bob Brown")?.tier).toBe(2);
  });

  it("reads <img alt='Name, Role'> attributes", () => {
    const html = `<img alt="Susan Hill, Finance Director" src="/photos/susan.jpg">`;
    const people = extractPeople(html);
    expect(people[0]?.name).toBe("Susan Hill");
    expect(people[0]?.tier).toBe(1);
  });

  it("ignores stop-word 'names' from the body proximity pass", () => {
    const html = `<p>Meet Our Team — our Finance Director is here. Click Here for more.</p>`;
    const people = extractPeople(html);
    // Should not extract "Meet Our" or "Click Here" as people
    expect(people).toEqual([]);
  });

  it("merges Jim Smith (proximity) with James Smith (jsonld) into one person", () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@type": "Person", "name": "James Smith", "jobTitle": "Managing Director",
    })}</script></head><body>
      <p>Our Finance Director, Jim Smith, has been with us since 2010.</p>
    </body></html>`;
    const people = extractPeople(html);
    // Both find the same person — Jim is a nickname for James.
    expect(people).toHaveLength(1);
    expect(people[0]!.name).toBe("James Smith");
    // jsonld is higher priority than proximity → role from jsonld wins
    expect(people[0]!.tier).toBe(1);
  });

  it("attaches mailto: emails to a same-domain person with name context nearby", () => {
    const html = `<div>
      <h3>Sarah Brown</h3>
      <p>Finance Director — <a href="mailto:sarah@acme.co.uk">sarah@acme.co.uk</a></p>
    </div>`;
    const people = extractPeople(html, "acme.co.uk");
    const sarah = people.find((p) => p.name === "Sarah Brown");
    expect(sarah?.email).toBe("sarah@acme.co.uk");
  });

  it("rejects off-domain mailto: emails (linkedin, gmail, sentry)", () => {
    const html = `<p>Bob Brown, Director — email <a href="mailto:bob@gmail.com">bob@gmail.com</a></p>`;
    const people = extractPeople(html, "acme.co.uk");
    expect(people.find((p) => p.name === "Bob Brown")?.email ?? null).toBeNull();
  });

  it("returns [] for empty input", () => {
    expect(extractPeople("")).toEqual([]);
  });
});
