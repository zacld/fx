"""
sourcer/excel.py — the company list as an Excel workbook (.xlsx), written
with the standard library alone (an .xlsx file is a zip of XML parts).

Sheets:
  Checked              companies fully checked (finance contact, bank, wallet,
                       triggers) — the ones to spot check and call; key
                       columns first, ranked as the pipeline ranks them;
  one per section      every company in Core / Above / Below, all columns;
  About                when the list was made and what each sheet holds.

Money columns are real numbers (£ format), links are clickable, the header
row is frozen and filterable.
"""

from __future__ import annotations

import re
import zipfile
from datetime import datetime, timezone
from typing import Iterable, Optional
from xml.sax.saxutils import escape

NOT_CHECKED = "not checked"

# The spot-check sheet: who to call, how sure we are, and why they're worth it.
CHECKED_FIELDS = [
    "section", "company_name", "company_number", "trading_as",
    "finance_contact", "finance_contact_role", "finance_contact_confidence", "finance_contact_evidence", "search_check", "finance_contact_linkedin",
    "finance_contact_source",
    "verify_finance_contact_url", "linkedin_search_url", "lead_director", "lead_director_occupation",
    "main_bank", "bank_type", "own_bank_client",
    "turnover_gbp", "fx_wallet_low_gbp", "fx_wallet_high_gbp", "import_currencies", "export_currencies",
    "qualified", "qualify_reason", "warm_route", "incumbent_bank", "facility_ends", "fx_today",
    "fact_1", "fact_2", "main_currency", "currency_direction", "currency_evidence",
    "currency_confidence", "opener", "fx_estimate", "facility_ends_evidence", "fx_today_evidence", "lenders",
    "triggers", "pe_backed", "when_to_call", "fx_evidence_level", "untapped_level",
    "group_parent", "website", "generic_emails", "companies_house_url",
]

_LINK_TEXT = {
    "verify_finance_contact_url": "Google check",
    "linkedin_search_url": "LinkedIn search",
    "finance_contact_linkedin": "LinkedIn profile",
    "companies_house_url": "Companies House",
}
_WORDS = {"gbp": "(£)", "fx": "FX", "linkedin": "LinkedIn", "hmrc": "HMRC", "pe": "PE", "url": "link", "sic": "SIC"}
_WIDTHS = {"company_name": 34, "finance_contact": 22, "finance_contact_source": 40, "triggers": 50,
           "when_to_call": 36, "fx_evidence": 50, "untapped_reasons": 40, "banking_relationships": 40,
           "registered_address": 40, "trade_countries": 40, "fx_wallet_basis": 36,
           "fact_1": 60, "fact_2": 60, "qualify_reason": 40, "warm_route": 36, "incumbent_bank": 36,
           "facility_ends_evidence": 50, "lenders": 50, "fx_today_evidence": 50, "fx_estimate": 50, "currency_evidence": 50, "opener": 60}
MAX_LINKS_PER_SHEET = 60_000   # Excel stops at 65,530 hyperlinks a sheet; past this, links stay as text
MAX_CELL_CHARS = 32_000        # Excel's limit is 32,767
_BAD_XML = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
_NUMBER = re.compile(r"-?\d+(\.\d+)?")

# Cell styles (indexes into cellXfs below).
_TEXT, _HEADER, _MONEY, _LINK, _NUM = 0, 1, 2, 3, 4

_STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;£&quot;#,##0"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>"""


def header(field: str) -> str:
    """"fx_wallet_high_gbp" -> "FX wallet high (£)"."""
    words = [_WORDS.get(w, w) for w in field.split("_")]
    text = " ".join(words)
    return text[0].upper() + text[1:] if text else text


def is_checked(row: dict) -> bool:
    return row.get("untapped_reasons", "") != NOT_CHECKED


def _column(index: int) -> str:
    """0 -> "A", 25 -> "Z", 26 -> "AA"."""
    name = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        name = chr(65 + rem) + name
    return name


def _text(value: str) -> str:
    return escape(_BAD_XML.sub("", value)[:MAX_CELL_CHARS])


def _attr(value: str) -> str:
    return escape(_BAD_XML.sub("", value), {'"': "&quot;"})


def _sheet_name(name: str, taken: set) -> str:
    """Excel sheet names: at most 31 characters, none of []:*?/\\, unique."""
    base = re.sub(r"[\[\]:*?/\\]", "", name)[:31] or "Sheet"
    candidate, n = base, 2
    while candidate.lower() in taken:
        candidate = f"{base[:28]} {n}"
        n += 1
    taken.add(candidate.lower())
    return candidate


def _sheet(rows: list[dict], fields: list[str]) -> tuple[str, list[str]]:
    """(worksheet XML, link targets in order) — links are referenced as rId1, rId2, ..."""
    links: list[str] = []
    out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
           'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
           '<sheetViews><sheetView workbookViewId="0"><pane xSplit="2" ySplit="1" topLeftCell="C2" '
           'activePane="bottomRight" state="frozen"/></sheetView></sheetViews><cols>']
    for i, field in enumerate(fields, 1):
        width = _WIDTHS.get(field, 18 if not field.endswith("_url") else 16)
        out.append(f'<col min="{i}" max="{i}" width="{width}" customWidth="1"/>')
    out.append("</cols><sheetData>")
    out.append('<row r="1">' + "".join(
        f'<c r="{_column(i)}1" t="inlineStr" s="{_HEADER}"><is><t>{_text(header(f))}</t></is></c>'
        for i, f in enumerate(fields)) + "</row>")
    hyperlinks = []
    for r, row in enumerate(rows, 2):
        cells = []
        for i, field in enumerate(fields):
            value = str(row.get(field, "") if row.get(field) is not None else "")
            if not value:
                continue
            ref = f"{_column(i)}{r}"
            if (field.endswith("_gbp") or field.endswith("_months") or field.endswith("_score")) \
                    and _NUMBER.fullmatch(value):
                style = _MONEY if field.endswith("_gbp") else _NUM
                cells.append(f'<c r="{ref}" s="{style}"><v>{value}</v></c>')
            elif (field.endswith("_url") or field in ("website", "finance_contact_linkedin")) and value.startswith("http") \
                    and len(links) < MAX_LINKS_PER_SHEET:
                links.append(value)
                hyperlinks.append(f'<hyperlink ref="{ref}" r:id="rId{len(links)}"/>')
                shown = _LINK_TEXT.get(field, value)
                cells.append(f'<c r="{ref}" t="inlineStr" s="{_LINK}"><is><t>{_text(shown)}</t></is></c>')
            else:
                cells.append(f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{_text(value)}</t></is></c>')
        out.append(f'<row r="{r}">' + "".join(cells) + "</row>")
    out.append("</sheetData>")
    out.append(f'<autoFilter ref="A1:{_column(len(fields) - 1)}{max(len(rows) + 1, 1)}"/>')
    if hyperlinks:
        out.append("<hyperlinks>" + "".join(hyperlinks) + "</hyperlinks>")
    out.append("</worksheet>")
    return "".join(out), links


def _about(lines: list[str]) -> str:
    rows = "".join(f'<row r="{i}"><c r="A{i}" t="inlineStr" s="{_HEADER if i == 1 else _TEXT}">'
                   f'<is><t xml:space="preserve">{_text(line)}</t></is></c></row>'
                   for i, line in enumerate(lines, 1))
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            f'<cols><col min="1" max="1" width="110" customWidth="1"/></cols><sheetData>{rows}</sheetData></worksheet>')


def write_workbook(rows: list[dict], fields: list[str], output_path: str, section_order: Iterable[str] = (),
                   made_at: Optional[datetime] = None) -> None:
    """The workbook described at the top of this module."""
    made_at = made_at or datetime.now(timezone.utc)
    checked = [r for r in rows if is_checked(r)]
    sections: dict[str, list[dict]] = {s: [] for s in section_order}
    for row in rows:
        sections.setdefault(row.get("section") or "Unsorted", []).append(row)
    sheets: list[tuple[str, list[dict], list[str]]] = [("Checked", checked, [f for f in CHECKED_FIELDS if f in fields])]
    sheets += [(name, sec_rows, fields) for name, sec_rows in sections.items() if sec_rows]

    about = [
        "FX company list",
        f"Made {made_at.strftime('%Y-%m-%d %H:%M UTC')} — {len(rows):,} companies, {len(checked):,} fully checked.",
        "",
        f"Checked: the {len(checked):,} companies checked in full (finance contact, bank, FX wallet, triggers), "
        "ranked best first. Start here.",
        *(f"{name}: all {len(sec_rows):,} companies in this turnover band, every column. "
          f"Rows marked '{NOT_CHECKED}' haven't been looked up yet." for name, sec_rows in sections.items() if sec_rows),
        "",
        "Finance contact confidence: Verified = a finance title, the same person named by 2+ independent sources "
        "(register, accounts, website, news, gender pay gap or modern slavery filing) and one of them current; "
        "Confirmed = a finance job title in the register, accounts, website, a registry filing or recent news; "
        "Likely = a qualified accountant officer, or the secretary who signed the accounts; Guess = secretary or "
        "the director who signed the accounts. Use 'Google check' to verify by hand.",
        "Triggers lift a company's rank a little; 'When to call' is information only.",
        "Every figure comes from public records (HMRC customs and trade statistics, Companies House, filed accounts).",
    ]

    taken: set = set()
    names = [_sheet_name(name, taken) for name, _, _ in sheets] + [_sheet_name("About", taken)]
    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as z:
        n = len(names)
        z.writestr("[Content_Types].xml",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="xml" ContentType="application/xml"/>'
                   '<Override PartName="/xl/workbook.xml" '
                   'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                   '<Override PartName="/xl/styles.xml" '
                   'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
                   + "".join(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType='
                             f'"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
                             for i in range(1, n + 1))
                   + "</Types>")
        z.writestr("_rels/.rels",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
                   'officeDocument" Target="xl/workbook.xml"/></Relationships>')
        z.writestr("xl/workbook.xml",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                   'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
                   + "".join(f'<sheet name="{escape(name)}" sheetId="{i}" r:id="rId{i}"/>'
                             for i, name in enumerate(names, 1))
                   + "</sheets><definedNames>"
                   + "".join(f'<definedName name="_xlnm._FilterDatabase" localSheetId="{i}" hidden="1">'
                             f"'{escape(names[i])}'!$A$1:${_column(len(f) - 1)}${len(r) + 1}</definedName>"
                             for i, (_, r, f) in enumerate(sheets))
                   + "</definedNames></workbook>")
        z.writestr("xl/_rels/workbook.xml.rels",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   + "".join(f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
                             f'relationships/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in range(1, n + 1))
                   + f'<Relationship Id="rId{n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
                     'relationships/styles" Target="styles.xml"/></Relationships>')
        z.writestr("xl/styles.xml", _STYLES)
        for i, (_, sheet_rows, sheet_fields) in enumerate(sheets, 1):
            xml, links = _sheet(sheet_rows, sheet_fields)
            z.writestr(f"xl/worksheets/sheet{i}.xml", xml)
            if links:
                z.writestr(f"xl/worksheets/_rels/sheet{i}.xml.rels",
                           '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                           '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                           + "".join(f'<Relationship Id="rId{k}" Type="http://schemas.openxmlformats.org/'
                                     f'officeDocument/2006/relationships/hyperlink" Target="{_attr(url)}" '
                                     'TargetMode="External"/>' for k, url in enumerate(links, 1))
                           + "</Relationships>")
        z.writestr(f"xl/worksheets/sheet{n}.xml", _about(about))
