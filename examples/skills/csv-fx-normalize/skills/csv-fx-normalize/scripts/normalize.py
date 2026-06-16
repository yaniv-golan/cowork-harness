#!/usr/bin/env python3
"""csv-fx-normalize producer — convert a CSV's EUR amounts to USD via live FX rates,
with a graceful offline fallback.

Bundled with the csv-fx-normalize skill. Standard library ONLY. The skill's job
genuinely needs the network (fetch the EUR->USD rate); the ONE outbound call is to
a public FX API. Under a sealed/offline environment — e.g. Cowork's default-deny
egress — that call is blocked, so the producer falls back to reporting amounts in
their source currency, clearly flagged. It never crashes or hangs on a blocked net.

Usage:
    python3 normalize.py <input.csv> <output_dir>     # CSV needs an `amount_eur` column

Writes:
    <output_dir>/normalized.json   structured result (incl. fx status + converted flag)
    <output_dir>/summary.md        short human-readable report
and prints a one-line summary to stdout.
"""
import csv
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

FX_ENDPOINT = "https://api.frankfurter.app/latest?from=EUR&to=USD"
FX_TIMEOUT_S = 5


def fetch_eur_usd():
    """Return (rate, status_dict). On any network failure (e.g. blocked by default-deny
    egress) return (None, {...}) so the caller falls back to source currency.

    urllib honors the HTTP(S)_PROXY env the sandbox injects, so a denied CONNECT to the
    FX host is what gets logged as an egress deny — the attempt is real, not synthetic.
    """
    try:
        with urllib.request.urlopen(FX_ENDPOINT, timeout=FX_TIMEOUT_S) as resp:
            rate = json.load(resp)["rates"]["USD"]
        return float(rate), {"status": "ok", "target": "USD", "endpoint": FX_ENDPOINT, "rate": float(rate)}
    except Exception as e:  # noqa: BLE001 — any failure to reach the net → degrade, don't die
        return None, {
            "status": "unavailable_offline",
            "target": "USD",
            "endpoint": FX_ENDPOINT,
            "detail": f"{type(e).__name__}: {e}",
        }


def _num(x: float):
    return int(x) if x == int(x) else round(x, 4)


def compute(csv_path: Path) -> dict:
    with csv_path.open(newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    eur = [float(r["amount_eur"]) for r in rows if (r.get("amount_eur") or "").strip() != ""]
    units = [float(r["units"]) for r in rows if (r.get("units") or "").strip() != ""]

    rate, fx = fetch_eur_usd()
    converted = rate is not None

    totals = {
        "amount_eur": {"sum": _num(sum(eur)), "currency": "EUR"},
        "units": {"sum": _num(sum(units))},
    }
    if converted:
        totals["amount_usd"] = {"sum": _num(sum(eur) * rate), "currency": "USD"}

    return {
        "source": str(csv_path),
        "rows": len(rows),
        "base_currency": "EUR",
        "fx": fx,
        "converted": converted,
        "totals": totals,
    }


def render_markdown(d: dict) -> str:
    lines = [f"# FX normalize — {Path(d['source']).name}", "", f"Rows: **{d['rows']}**", ""]
    if d["converted"]:
        lines += [
            f"Converted EUR -> USD at rate **{d['fx']['rate']}** (live).",
            f"- Total: €{d['totals']['amount_eur']['sum']} -> ${d['totals']['amount_usd']['sum']}",
        ]
    else:
        lines += [
            "**FX rate unavailable (offline / egress blocked)** — fell back to source currency.",
            "Amounts are reported in EUR, without conversion.",
            f"- Total: €{d['totals']['amount_eur']['sum']} (not converted)",
        ]
    lines.append("")
    return "\n".join(lines)


def main(argv) -> int:
    if len(argv) != 3:
        print("usage: normalize.py <input.csv> <output_dir>", file=sys.stderr)
        return 2
    csv_path, out_dir = Path(argv[1]), Path(argv[2])
    if not csv_path.exists():
        print(f"input CSV not found: {csv_path}", file=sys.stderr)
        return 2

    d = compute(csv_path)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "normalized.json").write_text(json.dumps(d, indent=2) + "\n", encoding="utf-8")
    (out_dir / "summary.md").write_text(render_markdown(d), encoding="utf-8")

    mode = "converted to USD" if d["converted"] else "fell back to source currency (offline)"
    print(f"csv-fx-normalize: {d['rows']} rows, {mode} -> {out_dir / 'normalized.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
