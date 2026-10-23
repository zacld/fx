# Market moves

The day-to-day market dashboard (`/moves` on the site): how the pound has
moved against each currency the account list deals in, why, and which
accounts each material move hits.

- **Rates:** the European Central Bank's official daily euro reference
  rates (free, no key), turned into pound rates (£1 = x euros, dollars, …).
  `moves.py` works out the change over 1 day, 1 week, 1 month and 3 months,
  and what it does per 1 million units ("every €1m of purchases now costs
  £20,000 more than on 21 Sep"). That's arithmetic on official rates, not an
  estimate.
- **Material:** the pound moved 1.5%+ in a month or 3%+ in three
  (`MOVE_RULES` in `moves.py`).
- **Why:** the event-led engine's recent strong/medium events for that
  currency pair, read from its public `events.json` (nothing in the event
  engine changes).
- **Accounts:** with the Accounts password, each material move lists the
  accounts whose main currency it is and which way it hits them: importers
  when the pound falls, exporters when it rises (the other side gets a
  lock-in angle). Qualified-out accounts are left off. A copyable call line
  per account.

Runs on weekdays at 06:07 and 15:37 UTC (`.github/workflows/fx-market-moves.yml`),
uploads `market.json` to the site's private Netlify Blobs store, served at
`/api/market`. No AI, no company data in it. The company finder
(`lead-sourcer/`) isn't touched.

    python3 moves.py --output market.json            # download and build
    python3 -m unittest discover -s tests            # tests
