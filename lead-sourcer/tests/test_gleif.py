"""GLEIF ownership (sourcer/gleif.py) on small made-up files — no network."""

import io
import os
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sourcer import gleif  # noqa: E402


def zipped(path, text):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("data.csv", text)


class TestGleif(unittest.TestCase):
    def test_owners_from_the_three_files(self):
        d = tempfile.mkdtemp()
        paths = {k: os.path.join(d, f"{k}.zip") for k in ("lei2", "rr", "repex")}
        zipped(paths["lei2"], 'LEI,Entity.LegalName,Entity.LegalAddress.Country,Entity.RegistrationAuthority.RegistrationAuthorityID,'
                              'Entity.RegistrationAuthority.RegistrationAuthorityEntityID\n'
                              'L1,ACME LIMITED,GB,RA000585,1234567\n'
                              'L2,ACME HOLDING GMBH,DE,RA000100,HRB1\n'
                              'L3,BRICKS LIMITED,GB,RA000585,SC123456\n'
                              'L4,OTHER LIMITED,GB,RA000585,07654321\n')
        zipped(paths["rr"], 'Relationship.StartNode.NodeID,Relationship.EndNode.NodeID,Relationship.RelationshipType,Relationship.RelationshipStatus\n'
                            'L1,L2,IS_ULTIMATELY_CONSOLIDATED_BY,ACTIVE\nL1,L2,IS_DIRECTLY_CONSOLIDATED_BY,ACTIVE\n')
        zipped(paths["repex"], 'LEI,ExceptionCategory,ExceptionReason\nL3,ULTIMATE_ACCOUNTING_CONSOLIDATION_PARENT,NATURAL_PERSONS\n')
        out = gleif.owners(paths, {"01234567", "SC123456"})
        self.assertEqual(set(out), {"01234567", "SC123456"})   # OTHER isn't tracked
        self.assertEqual((out["01234567"]["ultimate"], out["01234567"]["ultimate_country"], out["01234567"]["uk"]),
                         ("ACME HOLDING GMBH", "Germany", False))
        self.assertEqual((out["SC123456"]["exception"], out["SC123456"]["uk"]), ("owned by individuals (no parent company)", None))

    def test_numbers(self):
        self.assertEqual(gleif.normalise_number("1234567"), "01234567")
        self.assertEqual(gleif.normalise_number("SC12345"), "SC012345")
        self.assertEqual(gleif.normalise_number("oc 300001"), "OC300001")


if __name__ == "__main__":
    unittest.main()
