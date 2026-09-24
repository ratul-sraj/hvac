#!/usr/bin/env python
"""Laya pilot: can the Laya decision model beat the hand-written room-type rules?

Measurement only. Reads the labelled set tests/samples/room-types.csv, asks Laya two typed
questions per room name (a 13-way `choice` for the space type and a `noul` for "is it air
conditioned?"), and compares the answers against tools/roomtype-baseline.mjs's baseline.

    tools/laya/.venv/Scripts/python.exe tools/laya/roomtype-pilot.py

Writes tests/qa/laya-roomtypes-<utcstamp>.json and prints an accuracy table with the delta
against tests/qa/roomtype-baseline.json.
"""
import csv
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CSV_PATH = ROOT / "tests" / "samples" / "room-types.csv"


def pct(a, b):
    """Percent as a FLOAT (callers format it with :.1f), so it must live at module level:
    print_table() calls it, and a nested copy inside summarize() is not visible there."""
    return (100.0 * a / b) if b else float("nan")
BASELINE_PATH = ROOT / "tests" / "qa" / "roomtype-baseline.json"
OUT_DIR = ROOT / "tests" / "qa"

# Keep Hugging Face downloads inside tools/laya/cache (gitignored), never in the repo root.
os.environ.setdefault("HF_HOME", str(ROOT / "tools" / "laya" / "cache" / "hf"))

# The 13 SPACE_TYPES keys from js/calc.js, with short criteria for Laya's choice question.
SPACE_TYPE_CRITERIA = {
    "office": "offices and open plan work areas: desks, workstations, admin, filing, records",
    "conference": "meeting rooms, board rooms, conference halls, auditoriums, training rooms, multipurpose halls",
    "cabin": "single-person office for a manager, director, chief or executive",
    "reception": "reception, lobby, foyer, waiting area, guest majlis or entrance hall",
    "retail": "shop, showroom, supermarket, boutique, retail unit",
    "restaurant": "restaurant, dining room, cafe, cafeteria, coffee shop, pantry, kitchen or food area",
    "bedroom": "bedroom, master bedroom, guest room or suite",
    "living": "living room, family room, lounge or drawing room",
    "classroom": "classroom, lecture room, laboratory or library",
    "hospital": "patient room, patient ward, ICU, clinic or consulting room",
    "server": "server room, IT room, data centre, telecom/IDF, BMS or electrical/plant equipment room",
    "gym": "gym, fitness room, sports hall, entertainment or recreation area",
    "general": "anything without a specific use: service areas, toilets, stairs, corridors, shafts, "
               "stores, cupboards, voids, parking, terraces, courtyards",
}

QUESTIONS = {
    "type": {
        "type": "choice",
        "instructions": "What kind of space is this room?",
        "criteria": SPACE_TYPE_CRITERIA,
    },
    "aircon": {
        "type": "noul",
        "instructions": "Is this space air conditioned?",
        "criteria": {
            "false": "not cooled: toilets, stairs, shafts, stores, parking, terraces, plant rooms, outdoor areas",
            "true": "cooled: occupied rooms that are normally supplied with conditioned air",
        },
    },
}


def group_of(name: str) -> str:
    """Same grouping as tools/roomtype-baseline.mjs."""
    import re
    if re.search(r"[\u0600-\u06FF]", name):
        return "arabic/urdu"
    if re.search(r"[\u0900-\u097F]", name):
        return "devanagari"
    if re.search(r"\b(salle|bureau|toilettes|recepción|sala)\b", name, re.I):
        return "european"
    return "english"


def load_cases():
    """Read the same rows the baseline uses (skip the header)."""
    rows = []
    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            name = (r.get("name") or "").strip()
            if not name:
                continue
            rows.append({
                "name": name,
                "name_en": (r.get("name_en") or "").strip(),
                "want_type": (r.get("type") or "").strip(),
                "want_include": (r.get("include") or "").strip().lower() == "true",
                "note": (r.get("note") or "").strip(),
                "group": group_of(name),
            })
    return rows


def pick_prob(answer: dict):
    """Laya's choice answer key for the winning label's probability varies; try the known ones."""
    for k in ("probs", "probabilities", "confidence"):
        v = answer.get(k)
        if isinstance(v, dict):
            label = answer.get("choice")
            return v.get(label)
        if isinstance(v, (int, float)):
            return float(v)
    return None


def run(model=None, only=None, tag=""):
    from laya import Router

    cases = load_cases()
    if only is not None:
        cases = [c for c in cases if c["name"] in only]

    router = Router()
    print(f"[{tag}] Router ready. Preloading/warming checkpoint(s)...", flush=True)

    # Warm up so model load / download time is not counted in the latency figures.
    t_warm0 = time.perf_counter()
    warm = router.predict("OFFICE", QUESTIONS, **({"model": model} if model else {}))
    warm_s = time.perf_counter() - t_warm0
    print(f"[{tag}] warm-up call: {warm_s:.2f}s  checkpoint={warm['routing']['model']}", flush=True)

    results = []
    for c in cases:
        t0 = time.perf_counter()
        res = router.predict(c["name"], QUESTIONS, **({"model": model} if model else {}))
        dt = time.perf_counter() - t0
        ans = res["answers"]
        got_type = ans["type"].get("choice")
        got_type_prob = pick_prob(ans["type"])
        aircon = ans["aircon"].get("noul")
        routing = res.get("routing", {})
        c = dict(c)
        c.update({
            "got_type": got_type,
            "got_type_prob": got_type_prob,
            "got_include_prob": aircon,
            "got_include": bool(aircon is not None and aircon >= 0.5),
            "ok_type": got_type == c["want_type"],
            "ok_include": (aircon is not None and aircon >= 0.5) == c["want_include"],
            "model": routing.get("model"),
            "route_reason": routing.get("reason"),
            "seconds": round(dt, 4),
            "seconds_per_question": round(dt / len(QUESTIONS), 4),
        })
        results.append(c)
        mark = "ok " if (c["ok_type"] and c["ok_include"]) else "BAD"
        print(f"  {mark} {c['name'][:26]:<26} -> {str(got_type):<11} "
              f"p={got_type_prob if got_type_prob is None else round(got_type_prob, 3)} "
              f"aircon={None if aircon is None else round(aircon, 3)} "
              f"[{routing.get('model')}] {dt*1000:.0f}ms", flush=True)

    return results, warm_s


def summarize(results, baseline):
    def pct(a, b):
        return (100.0 * a / b) if b else 0.0

    groups = {}
    for c in results:
        g = groups.setdefault(c["group"], {"n": 0, "type": 0, "inc": 0})
        g["n"] += 1
        g["type"] += 1 if c["ok_type"] else 0
        g["inc"] += 1 if c["ok_include"] else 0

    overall = {
        "n": len(results),
        "type": sum(1 for c in results if c["ok_type"]),
        "inc": sum(1 for c in results if c["ok_include"]),
    }
    return overall, groups


def print_table(title, results, baseline):
    overall, groups = summarize(results, baseline)
    print(f"\n=== {title} ===")
    n = overall["n"]
    print(f"overall            n={n:>3}  type {overall['type']}/{n} = {100*overall['type']/n:.1f}%"
          f"   include {overall['inc']}/{n} = {100*overall['inc']/n:.1f}%")

    order = ["english", "arabic/urdu", "devanagari", "european"]
    print(f"{'group':<13}{'n':>4}  {'laya type':>10} {'base type':>10} {'d':>7}   "
          f"{'laya inc':>9} {'base inc':>9} {'d':>7}")
    base_stats = baseline.get("stats", {})
    for g in order:
        if g not in groups:
            continue
        s = groups[g]
        lt = pct(s["type"], s["n"])
        li = pct(s["inc"], s["n"])
        bs = base_stats.get(g, {})
        bn = bs.get("n", 0)
        bt = pct(bs.get("type", 0), bn) if bn else float("nan")
        bi = pct(bs.get("inc", 0), bn) if bn else float("nan")
        print(f"{g:<13}{s['n']:>4}  {lt:>9.1f}% {bt:>9.1f}% {lt-bt:>+6.1f}   "
              f"{li:>8.1f}% {bi:>8.1f}% {li-bi:>+6.1f}")

    # baseline overall (recompute from baseline cases)
    bcases = baseline.get("cases", [])
    bn = len(bcases)
    bt = pct(sum(1 for c in bcases if c.get("okType")), bn)
    bi = pct(sum(1 for c in bcases if c.get("okInclude")), bn)
    lt = pct(overall["type"], n)
    li = pct(overall["inc"], n)
    print(f"{'OVERALL':<13}{n:>4}  {lt:>9.1f}% {bt:>9.1f}% {lt-bt:>+6.1f}   "
          f"{li:>8.1f}% {bi:>8.1f}% {li-bi:>+6.1f}")

    times = sorted(c["seconds"] for c in results)
    def q(p):
        if not times:
            return 0.0
        i = min(len(times) - 1, int(round(p * (len(times) - 1))))
        return times[i]
    tots = sorted(c["seconds_per_question"] for c in results)
    def qt(p):
        if not tots:
            return 0.0
        i = min(len(tots) - 1, int(round(p * (len(tots) - 1))))
        return tots[i]
    print(f"\nlatency per name (1 predict call = 2 questions, warm):  "
          f"p50 {q(0.5)*1000:.0f} ms  p90 {q(0.9)*1000:.0f} ms")
    print(f"latency per question                    :  "
          f"p50 {qt(0.5)*1000:.0f} ms  p90 {qt(0.9)*1000:.0f} ms")

    routing = {}
    for c in results:
        routing[(c["group"], c["model"])] = routing.get((c["group"], c["model"]), 0) + 1
    print("\ncheckpoint per language group:")
    for (g, m), k in sorted(routing.items()):
        print(f"  {g:<13} -> {m:<12} ({k})")

    mism = [c for c in results if not (c["ok_type"] and c["ok_include"])]
    print(f"\nmismatches ({len(mism)}):")
    for c in mism:
        bits = []
        if not c["ok_type"]:
            bits.append(f"type got \"{c['got_type']}\" want \"{c['want_type']}\"")
        if not c["ok_include"]:
            bits.append(f"include got {c['got_include']} want {c['want_include']}")
        print(f"  {c['name'][:26]:<26} {bits[0]}; {'; '.join(bits[1:]) if len(bits) > 1 else ''}")
    return overall, groups


def main():
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    baseline = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))

    print("=== LAYA PILOT: auto-routed run ===")
    t_start = time.perf_counter()
    results, warm_s = run(tag="auto")
    auto_elapsed = time.perf_counter() - t_start
    overall, groups = print_table("AUTO-ROUTED (default Router)", results, baseline)

    # Forced multilingual pass, to see how the multilingual checkpoint answers alone.
    print("\n=== FORCED multilingual run (model='multilingual') ===")
    t_ml0 = time.perf_counter()
    ml_results, ml_warm = run(model="multilingual", tag="multilingual")
    ml_elapsed = time.perf_counter() - t_ml0
    ml_overall, _ = print_table("FORCED multilingual", ml_results, baseline)

    out = {
        "generated": stamp,
        "csv": str(CSV_PATH.relative_to(ROOT)),
        "baseline": str(BASELINE_PATH.relative_to(ROOT)),
        "baseline_overall": {
            "n": len(baseline.get("cases", [])),
            "type": sum(1 for c in baseline.get("cases", []) if c.get("okType")),
            "inc": sum(1 for c in baseline.get("cases", []) if c.get("okInclude")),
        },
        "auto": {
            "elapsed_s": round(auto_elapsed, 2),
            "warmup_s": round(warm_s, 2),
            "overall": overall,
            "groups": groups,
            "cases": results,
        },
        "forced_multilingual": {
            "elapsed_s": round(ml_elapsed, 2),
            "warmup_s": round(ml_warm, 2),
            "overall": ml_overall,
            "cases": ml_results,
        },
    }
    out_path = OUT_DIR / f"laya-roomtypes-{stamp}.json"
    out_path.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"\nwritten: {out_path.relative_to(ROOT)}")
    print(f"auto elapsed {auto_elapsed:.1f}s (warm {warm_s:.1f}s); "
          f"multilingual elapsed {ml_elapsed:.1f}s (warm {ml_warm:.1f}s)")


if __name__ == "__main__":
    main()