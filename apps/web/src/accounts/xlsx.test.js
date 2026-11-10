import { describe, expect, it } from "vitest";
import { columnName, columnsFor, crc32, sheetBytes, sheetXml } from "./xlsx.js";

// Reads a stored (uncompressed) zip back: {name: text}.
function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = {};
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const size = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const name = new TextDecoder().decode(bytes.slice(at + 30, at + 30 + nameLen));
    const data = bytes.slice(at + 30 + nameLen, at + 30 + nameLen + size);
    expect(crc32(data)).toBe(view.getUint32(at + 14, true));
    files[name] = new TextDecoder().decode(data);
    at += 30 + nameLen + size;
  }
  return files;
}

describe("Excel export", () => {
  it("names columns like Excel", () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual(["A", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
  });
  it("writes a workbook with real columns: text as text, numbers as numbers, nothing as a formula", () => {
    const cols = columnsFor(["company_name", "turnover_gbp", "notes"], { turnover_gbp: "Turnover (£)" }, ["turnover_gbp"]);
    expect(cols.map((c) => c.header)).toEqual(["Company name", "Turnover (£)", "Notes"]);
    const files = unzip(sheetBytes([{ company_name: "ACME & SONS <LTD>", turnover_gbp: "45000000", notes: '=HYPERLINK("x")' }, { company_name: "B LTD" }], cols, "Call today"));
    expect(Object.keys(files)).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"]);
    const sheet = files["xl/worksheets/sheet1.xml"];
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Company name</t></is></c>');
    expect(sheet).toContain('<c r="B1" s="1" t="inlineStr"><is><t xml:space="preserve">Turnover (£)</t></is></c>');
    expect(sheet).toContain("ACME &amp; SONS &lt;LTD&gt;");
    expect(sheet).toContain('<c r="B2"><v>45000000</v></c>');
    expect(sheet).toContain('<c r="C2" t="inlineStr"><is><t xml:space="preserve">=HYPERLINK(&quot;x&quot;)</t></is></c>');
    expect(sheet).not.toContain("<f>");
    expect(sheet).toContain('<autoFilter ref="A1:C3"/>');
    expect(sheet).toContain('state="frozen"');
    expect(files["xl/workbook.xml"]).toContain('name="Call today"');
  });
  it("leaves empty cells out", () => {
    expect(sheetXml([{ a: "" }], [{ key: "a", header: "A" }])).toContain('<row r="2"></row>');
  });
});
