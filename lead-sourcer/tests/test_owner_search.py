import unittest

from sourcer import owner_search as o


class OwnerSearch(unittest.TestCase):
    def test_pe_owner_with_country(self):
        r = [("https://a.com/x", "TXO Systems acquired by TowerBrook",
              "TXO Systems has been acquired by TowerBrook Capital Partners, a US-based private equity firm.")]
        a = o.answer(r, "TXO SYSTEMS LTD")
        self.assertEqual((a["owner"], a["kind"], a["country"]), ("TowerBrook Capital Partners", "pe", "United States"))

    def test_portfolio_company(self):
        r = [("https://c.com", "CSM Ingredients", "CSM Ingredients is a portfolio company of Investindustrial, the European investment group.")]
        self.assertEqual(o.answer(r, "CSM INGREDIENTS UK LIMITED")["owner"], "Investindustrial")

    def test_knowledge_panel(self):
        r = [("knowledge-panel", "Senza Group", "Parent organization: NLC Group")]
        self.assertEqual(o.answer(r, "SENZA GROUP LIMITED")["owner"], "NLC Group")

    def test_not_itself_or_other_companies(self):
        r = [("https://z.com", "Acme Foods", "Acme Foods Limited is owned by Acme Foods Holdings."),
             ("https://y.com", "Other news", "Widget Co was acquired by Big Corp.")]
        self.assertIsNone(o.answer(r, "ACME FOODS LIMITED"))

    def test_kind(self):
        self.assertEqual(o.kind_of("Paul Rosen"), "person")
        self.assertEqual(o.kind_of("Axalta Coating Systems Ltd"), "company")


class AiReader(unittest.TestCase):
    R = [("https://a.com", "Bakels acquires Renshaw", "British Bakels is part of the Bakels Group, the Swiss-based bakery firm.")]

    def reply(self, ans):
        import json
        return lambda body: {"usage": {"total_tokens": 400}, "choices": [{"message": {"content": json.dumps(ans)}}]}

    def test_checked_answer(self):
        a = o.ai_read(self.R, "BRITISH BAKELS LIMITED", post=self.reply(
            {"owner": "Bakels Group", "type": "company", "country": "Switzerland", "result": 1, "quote": "part of the Bakels Group"}))
        self.assertEqual((a["owner"], a["read_by"]), ("Bakels Group", "ai"))

    def test_answer_not_in_results_dropped(self):
        a = o.ai_read(self.R, "BRITISH BAKELS LIMITED", post=self.reply(
            {"owner": "Unilever", "type": "company", "result": 1, "quote": "owned by Unilever"}))
        self.assertEqual(a, {"none": True})

    def test_country_not_stated_is_blank(self):
        a = o.ai_read(self.R, "BRITISH BAKELS LIMITED", post=self.reply(
            {"owner": "Bakels Group", "type": "company", "country": "Germany", "result": 1, "quote": "part of the Bakels Group"}))
        self.assertEqual(a["country"], "")


class GeminiInteractions(unittest.TestCase):
    """Gemini 3 through the Interactions API: an owner counts only when the page it cites names it (and the company)."""

    PAGE = "https://www.cloetta.com/en/about"
    HTML = "<html><body><h1>Cloetta</h1><p>Cloetta UK Ltd is a subsidiary of Cloetta AB, the Swedish confectionery group.</p></body></html>"

    def setUp(self):
        o.GEMINI_SPENT.clear()
        o._gemini_model.clear()
        o._GEMINI_FAILS[0] = 0
        o.GEMINI_DROPS.clear()
        for k in o.GEMINI_USAGE:
            o.GEMINI_USAGE[k] = 0

    @staticmethod
    def nothing(query):
        return '{"results": []}'

    tearDown = setUp

    def test_failing_calls_stop_gemini_for_the_run(self):
        for _ in range(o.GEMINI_FAILS_MAX):
            self.assertIsNone(o.gemini_read("CLOETTA UK LIMITED", post=lambda prompt: None))
        self.assertEqual(o.GEMINI_SPENT, ["failing"])

    def reply(self, chain, searched=True):
        import json
        steps = [{"type": "google_search_call", "arguments": {"queries": ["who owns Cloetta UK", "Cloetta UK parent"]}}] if searched else []
        steps.append({"type": "model_output", "content": [{"type": "text", "text": "```json\n" + json.dumps(
            {"chain": chain, "answer": "Cloetta UK is owned by Cloetta AB."}) + "\n```"}]})
        return lambda prompt: {"status": "completed", "usage": {"total_tokens": 900}, "steps": steps}

    def pages(self, html=None, robots=""):
        seen = []

        def page(url):
            seen.append(url)
            if url.endswith("/robots.txt"):
                return (url, robots) if robots else None
            return (url, self.HTML if html is None else html)
        page.seen = seen
        return page

    CHAIN = [{"owner": "Cloetta AB", "type": "company", "country": "Sweden", "source_url": PAGE,
              "quote": "Cloetta UK Ltd is a subsidiary of Cloetta AB"}]

    def test_owner_on_the_cited_page(self):
        a = o.gemini_read("CLOETTA UK LIMITED", "01234567", post=self.reply(self.CHAIN), page=self.pages())
        self.assertEqual((a["owner"], a["kind"], a["country"], a["read_by"]), ("Cloetta AB", "company", "Sweden", "gemini"))
        self.assertEqual((a["url"], a["source"], a["sites"]), (self.PAGE, "cloetta.com", 1))
        self.assertIn("subsidiary of Cloetta AB", a["quote"])
        self.assertEqual((o.GEMINI_USAGE["searches"], o.GEMINI_USAGE["verified"], o.GEMINI_USAGE["tokens"]), (2, 1, 900))

    def test_page_without_the_owner_is_unchecked(self):
        a = o.gemini_read("CLOETTA UK LIMITED", post=self.reply(self.CHAIN), page=self.pages(html="<p>Cloetta sweets, made in Sweden.</p>"),
                          confirm=self.nothing)
        self.assertEqual(a, {"none": True, "unchecked": True})
        self.assertEqual(o.GEMINI_USAGE["dropped"], 1)

    def test_owner_sharing_the_company_name_needs_its_whole_name(self):
        html = "<p>Cloetta UK Ltd is a subsidiary of the Cloetta group, the Swedish confectioner.</p>"
        a = o.gemini_read("CLOETTA UK LIMITED", post=self.reply(self.CHAIN), page=self.pages(html=html), confirm=self.nothing)
        self.assertTrue(a.get("unchecked"))

    def test_page_must_say_something_about_ownership(self):
        html = "<p>Cloetta UK Ltd and Cloetta AB sponsor the Leeds sweets fair.</p>"
        a = o.gemini_read("CLOETTA UK LIMITED", post=self.reply(self.CHAIN), page=self.pages(html=html), confirm=self.nothing)
        self.assertTrue(a.get("unchecked"))

    def test_a_differently_named_owner(self):
        chain = [{"owner": "TowerBrook Capital Partners", "type": "private_equity", "country": "US",
                  "source_url": "https://news.example.com/txo", "quote": "acquired by TowerBrook"}]
        html = "<p>TXO Systems has been acquired by TowerBrook Capital Partners.</p>"
        a = o.gemini_read("TXO SYSTEMS LIMITED", post=self.reply(chain), page=self.pages(html=html))
        self.assertEqual((a["owner"], a["kind"], a["country"]), ("TowerBrook Capital Partners", "pe", "United States"))

    def test_a_search_can_back_it_when_the_page_doesnt_open(self):
        import json
        hits = {"results": [{"title": "Cloetta UK", "link": "https://news.example.com/cloetta-uk",
                             "snippet": "Cloetta UK Ltd, a subsidiary of Cloetta AB, makes Chewits."}]}
        asked = []
        a = o.gemini_read("CLOETTA UK LIMITED", post=self.reply(self.CHAIN), page=lambda url: None,
                          confirm=lambda q: asked.append(q) or json.dumps(hits))
        self.assertEqual((a["owner"], a["url"], a["source"]), ("Cloetta AB", "https://news.example.com/cloetta-uk", "news.example.com"))
        self.assertEqual(o.GEMINI_USAGE["confirmed_by_search"], 1)
        self.assertIn("Cloetta AB", asked[0])

    def test_a_search_that_doesnt_back_it(self):
        import json
        hits = {"results": [{"title": "Cloetta sweets", "link": "https://shop.example.com", "snippet": "Buy Cloetta sweets online."}]}
        a = o.gemini_read("CLOETTA UK LIMITED", post=self.reply(self.CHAIN), page=lambda url: None,
                          confirm=lambda q: json.dumps(hits))
        self.assertTrue(a.get("unchecked"))
        self.assertIn("no search result backs it either", o.GEMINI_DROPS)

    def test_google_redirect_link_never_opened_search_confirms(self):
        import json
        chain = [{**self.CHAIN[0], "source_url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQH"}]
        page = self.pages()
        hits = {"results": [{"title": "CLOETTA UK LIMITED", "link": "https://www.dnb.com/cloetta-uk",
                             "snippet": "Ultimate HQ Cloetta AB Sweden. CLOETTA UK LIMITED. United Kingdom."}]}
        a = o.gemini_read("CLOETTA UK LIMITED", post=self.reply(chain), page=page, confirm=lambda q: json.dumps(hits))
        self.assertEqual(page.seen, [])
        self.assertEqual((a["owner"], a["source"]), ("Cloetta AB", "dnb.com"))

    def test_social_site_never_opened(self):
        chain = [{**self.CHAIN[0], "source_url": "https://www.linkedin.com/company/cloetta"}]
        page = self.pages()
        a = o.gemini_read("CLOETTA UK LIMITED", post=self.reply(chain), page=page, confirm=self.nothing)
        self.assertTrue(a.get("unchecked"))
        self.assertEqual(page.seen, [])

    def test_robots_txt_respected(self):
        page = self.pages(robots="User-agent: *\nDisallow: /")
        a = o.gemini_read("CLOETTA UK LIMITED", post=self.reply(self.CHAIN), page=page, confirm=self.nothing)
        self.assertTrue(a.get("unchecked"))
        self.assertNotIn(self.PAGE, page.seen)

    def test_no_search_is_memory_not_a_source(self):
        a = o.gemini_read("CLOETTA UK LIMITED", post=self.reply(self.CHAIN, searched=False), page=self.pages(), confirm=self.nothing)
        self.assertTrue(a.get("unchecked"))

    def test_none_found(self):
        a = o.gemini_read("CLOETTA UK LIMITED", post=self.reply([]), page=self.pages())
        self.assertEqual(a, {"none": True})

    def test_prompt_caps_the_searches(self):
        got = []
        o.gemini_read("CLOETTA UK LIMITED", post=lambda prompt: got.append(prompt) or None)
        self.assertIn(f"at most\n{o.GEMINI_MAX_SEARCHES} searches", got[0])

    def test_models_and_routes(self):
        self.assertIn("gemini-3.8-flash", o.GEMINI_MODELS)
        self.assertTrue(o._uses_interactions("gemini-3.8-flash"))
        self.assertTrue(o._uses_interactions("gemini-flash-latest"))
        self.assertFalse(o._uses_interactions("gemini-2.5-flash"))

    def test_grounded_generate_content_still_read(self):
        import json
        ans = {"chain": [{"owner": "Cloetta AB", "type": "company", "country": "Sweden"}], "answer": "Owned by Cloetta AB."}
        data = {"usageMetadata": {"totalTokenCount": 300}, "candidates": [{
            "content": {"parts": [{"text": json.dumps(ans)}]},
            "groundingMetadata": {"groundingChunks": [{"web": {"uri": "https://x.example/r", "title": "cloetta.com"}}],
                                  "groundingSupports": [{"segment": {"text": "Cloetta UK is part of Cloetta AB"}}]}}]}
        a = o.gemini_read("CLOETTA UK LIMITED", post=lambda prompt: data)
        self.assertEqual((a["owner"], a["url"], a["sites"]), ("Cloetta AB", "https://x.example/r", 1))


class SearchFallsBack(unittest.TestCase):
    """An owner Gemini named that no page backs is asked the older way (search APIs + the checked AI reader)."""

    def setUp(self):
        self.saved = (o.gemini_read, o._chain)

    def tearDown(self):
        o.gemini_read, o._chain = self.saved

    def test_unchecked_asks_the_search_apis(self):
        o.gemini_read = lambda name, number="": {"none": True, "unchecked": True}
        o._chain = lambda number, name, fetch: {"owner": "Cloetta AB", "kind": "company", "read_by": "ai"}
        self.assertEqual(o.search("01", "CLOETTA UK LIMITED")["owner"], "Cloetta AB")

    def test_unchecked_and_no_search_api_is_nothing_found(self):
        o.gemini_read = lambda name, number="": {"none": True, "unchecked": True}
        o._chain = lambda number, name, fetch: {"error": True}
        self.assertEqual(o.search("01", "CLOETTA UK LIMITED"), {"none": True})

    def test_checked_answer_kept(self):
        o.gemini_read = lambda name, number="": {"owner": "Cloetta AB", "read_by": "gemini"}
        o._chain = lambda number, name, fetch: self.fail("the search APIs aren't asked")
        self.assertEqual(o.search("01", "CLOETTA UK LIMITED")["read_by"], "gemini")

    def test_no_gemini_call_uses_the_search_apis(self):
        o.gemini_read = lambda name, number="": None
        o._chain = lambda number, name, fetch: {"error": True}
        self.assertEqual(o.search("01", "CLOETTA UK LIMITED"), {"error": True})


class GoodLeadsOnly(unittest.TestCase):
    """tools/owner_search.py --only-first: only Zac's good leads are asked about; Gemini stops at its monthly cap."""

    def run_tool(self, extra, usage=None):
        import json
        import os
        import sys
        import tempfile
        from datetime import date
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
        import owner_search as tool
        d = tempfile.mkdtemp()
        files = {"tracked": {"companies": {"01": {"name": "GOOD LEAD LTD"}, "02": {"name": "OTHER LEAD LTD"},
                                           "03": {"name": "THIRD LEAD LTD"}}},
                 "order": ["02", "03", "01"], "first": ["01"],
                 "cache": {"companies": {}, "usage": {date.today().strftime("%Y-%m"): usage or {}}}}
        for k, v in files.items():
            with open(os.path.join(d, k + ".json"), "w") as f:
                json.dump(v, f)
        asked = []
        saved = (tool.owner_search.search, sys.argv, os.environ.get("GEMINI_API_KEY"), list(tool.owner_search.GEMINI_SPENT))
        tool.owner_search.search = lambda n, name: asked.append(n) or {"none": True}
        os.environ["GEMINI_API_KEY"] = "test"
        tool.owner_search.GEMINI_SPENT.clear()
        tool.owner_search.GEMINI_USAGE["searches"] = 0
        sys.argv = ["owner_search.py", "--tracked", f"{d}/tracked.json", "--order", f"{d}/order.json", "--first",
                    f"{d}/first.json", "--cache", f"{d}/cache.json", "--out", f"{d}/out.json"] + extra
        try:
            tool.main()
            spent = list(tool.owner_search.GEMINI_SPENT)
        finally:
            tool.owner_search.search, sys.argv = saved[0], saved[1]
            if saved[2] is None:
                os.environ.pop("GEMINI_API_KEY", None)
            else:
                os.environ["GEMINI_API_KEY"] = saved[2]
            tool.owner_search.GEMINI_SPENT[:] = saved[3]
        with open(f"{d}/out.json") as f:
            return asked, spent, json.load(f)

    def test_only_good_leads(self):
        asked, _, _ = self.run_tool(["--only-first"])
        self.assertEqual(asked, ["01"])

    def test_without_the_flag_good_leads_first_then_the_rest(self):
        asked, _, _ = self.run_tool([])
        self.assertEqual(asked, ["01", "02", "03"])

    def test_monthly_cap_stops_gemini(self):
        from datetime import date
        asked, spent, out = self.run_tool(["--only-first"], usage={"gemini_searches": 4500})
        self.assertEqual((asked, spent), (["01"], ["monthly search cap"]))
        self.assertEqual(out["usage"][date.today().strftime("%Y-%m")]["gemini_searches"], 4500)


if __name__ == "__main__":
    unittest.main()
