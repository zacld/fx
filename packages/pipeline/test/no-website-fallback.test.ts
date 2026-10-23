import { describe, it, expect } from "vitest";
import {
  ukSwitchboardHint, townFromAddress, linkedinSearchForTown, guessDomainCandidates, buildNoWebsiteHints,
} from "../src/sources/no-website-fallback.js";

describe("ukSwitchboardHint", () => {
  it("recognises London postcodes (EC/WC/E/N/NW/SE/SW/W) → 020", () => {
    expect(ukSwitchboardHint("12 King Street, London SW1A 1AA")?.prefix).toBe("020");
    expect(ukSwitchboardHint("Suite 4, EC2A 4BX")?.prefix).toBe("020");
  });
  it("Manchester M1 → 0161, Edinburgh EH3 → 0131", () => {
    expect(ukSwitchboardHint("11 Oxford Road, Manchester M1 5QA")?.prefix).toBe("0161");
    expect(ukSwitchboardHint("4 George Street, Edinburgh EH3 9AB")?.prefix).toBe("0131");
  });
  it("returns null for unknown areas", () => {
    expect(ukSwitchboardHint("Smalltown ZZ9 9ZZ")).toBeNull();
    expect(ukSwitchboardHint("")).toBeNull();
  });
});

describe("townFromAddress", () => {
  it("picks the chunk before the postcode", () => {
    expect(townFromAddress("12 King Street, Bath BA1 1AA")).toBe("Bath");
    expect(townFromAddress("Unit 4, Bramble Lane, Manchester, M1 5QA")).toBe("Manchester");
  });
  it("falls back to second-to-last when no postcode present", () => {
    expect(townFromAddress("12 King Street, Bath, Avon")).toBe("Bath");
  });
});

describe("linkedinSearchForTown", () => {
  it("encodes name + town into a Google linkedin.com/in query", () => {
    const url = linkedinSearchForTown("Sarah Brown", "Bath");
    expect(url).toContain("site:linkedin.com/in");
    expect(url).toContain(encodeURIComponent('"Sarah Brown"'));
    expect(url).toContain(encodeURIComponent('"Bath"'));
  });
  it("omits the town qualifier when blank", () => {
    expect(linkedinSearchForTown("Sarah Brown", "")).not.toContain("%22%22");
  });
});

describe("guessDomainCandidates", () => {
  it("emits concatenated + hyphenated + prefixed stems × common TLDs", () => {
    const got = guessDomainCandidates("Acme Wine");
    expect(got).toEqual(expect.arrayContaining([
      "https://acmewine.co.uk", "https://acme-wine.co.uk",
      "https://acmewine.com", "https://theacmewine.co.uk",
    ]));
  });
  it("strips accents + non-letters", () => {
    const got = guessDomainCandidates("Café Brûlé");
    expect(got.some((u) => u.includes("cafebrule"))).toBe(true);
  });
  it("returns [] for empty inputs", () => {
    expect(guessDomainCandidates("")).toEqual([]);
  });
});

describe("buildNoWebsiteHints", () => {
  it("packages all three hints together", () => {
    const h = buildNoWebsiteHints({ companyNameClean: "Acme Wine", address: "12 King St, London SW1A 1AA" });
    expect(h.candidate_domains.length).toBeGreaterThan(0);
    expect(h.switchboard_prefix).toBe("020");
    expect(h.town).toBe("London");
  });
});
