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


if __name__ == "__main__":
    unittest.main()
