---
name: csv-fx-normalize
description: Normalize a CSV's EUR amounts to USD using live FX rates, with a graceful offline fallback. Use to convert or normalize a currency column in tabular data.
---

# csv-fx-normalize

Converts EUR amounts in a CSV to USD using a live exchange rate, via a **bundled
producer script** (`scripts/normalize.py`). The skill's job genuinely needs the
network — fetching the rate — so this is also the worked example of **degrading
gracefully under a sealed network**: in Cowork (default-deny egress) the rate fetch
is blocked, and the skill falls back to reporting amounts in their source currency,
clearly flagged. It never fails or hangs because the network is sealed.

## When to use

The user has a CSV with a EUR-denominated `amount_eur` column and wants it normalized
to USD.

## How to run

1. Locate the CSV. Default for this example: `uploads/sales_eur.csv`.
2. Run the bundled producer (reachable via `${CLAUDE_PLUGIN_ROOT}`):

   ```bash
   python3 "${CLAUDE_PLUGIN_ROOT}/skills/csv-fx-normalize/scripts/normalize.py" uploads/sales_eur.csv outputs
   ```

   It makes one outbound call — to a public FX API — to get the EUR→USD rate. If that
   call is blocked (as it is under Cowork's default-deny egress), it falls back to the
   source currency. Either way it writes `outputs/normalized.json` and
   `outputs/summary.md` and prints a one-line summary.
3. Read `outputs/summary.md` and tell the user whether the amounts were **converted to
   USD** or it **fell back to source currency (offline)**, plus the path to the JSON.

## Constraints

- Standard library only; the **one** network call is the FX fetch, and it must degrade
  gracefully when blocked — that's the property this skill demonstrates.
- Treat `outputs/` as write-once for the deliverable.
