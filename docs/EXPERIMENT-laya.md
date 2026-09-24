# Experiment: could Laya replace the room-type rules? (No — removed)

**Date:** 24 Sep 2026 · **Outcome:** rejected and deleted (~2.2 GB of local checkpoints + venv freed).
This note exists so nobody repeats the experiment without reading the numbers first.

## What was tested

[Laya](https://github.com/NandhaKishorM/laya) is a small "typed decision" model: you ask it a
`choice` question (pick one of N options with your criteria) or a `noul` question (yes/no as a
probability) and it answers in one forward pass, no text generation. The idea was to let it type
rooms (office / conference / cabin / …) and decide the air-conditioned flag, instead of the
hand-written rules in `js/calc.js`.

Setup that was required: a Python venv (torch 2.14 CPU + transformers 5.17, 716 MB), plus the two
checkpoints it downloads on first use — `english` (804 MB) and `multilingual` (615 MB).

## Result (99 labelled cases, tests/samples/room-types.csv)

| | rules in js/calc.js | Laya auto-routed | Laya forced multilingual |
|---|---|---|---|
| room type | **83.8%** | 29.3% | 23.2% |
| air-conditioned flag | **91.9%** | 57.6% | 56.6% |
| English names (77) | **96.1%** | 33.8% | 27.3% |
| Arabic / Urdu (14) | **42.9%** | 0.0% | 0.0% |
| Devanagari (3) | **33.3%** | 0.0% | 0.0% |
| European (5) | 40.0% | 60.0% | 40.0% |
| latency per name (CPU) | instant | 938 ms | 454 ms |

Laya collapsed to a single answer (`office` for nearly every English name, `bedroom` for the
multilingual pass) and its confidences sat at ~0.5 because the shipped checkpoint ships invalid
temperature metadata — the library warns about it and floors every choice confidence to 0.5, so the
probabilities are uncalibrated as well as wrong.

## What was kept from the experiment

The measurement itself was worth it: it exposed three real bugs in the rules, which stay fixed —

- `NON_AC_WORDS` ended in `\b` after abbreviations, so `ELEC. C.`, `M. TL.` and `COR.` were never
  matched and were counted as air conditioned (rebuilt with lookarounds and optional dots).
- a trailing `\b` after `\d` lost `ST. 01` and `PL 1`.
- room typing is now an ordered rule table: `Coffee Shop` is a restaurant, `Video Display Hall` is a
  conference room, `KIT.` is a kitchenette.

Measured effect: room type 66.7% → 83.8%, air-conditioned flag 66.7% → 91.9% (English 96.1% / 100%).
`tests/samples/room-types.csv` (99 labelled cases) and `tools/roomtype-baseline.mjs` remain, so any
future classifier can be scored against the same yardstick:

```bash
node tools/roomtype-baseline.mjs
```

## If someone wants to try again

Zero-shot is not Laya's strong mode — its own README reports 0.362 base accuracy rising to 0.766
after fine-tuning on a few thousand of your own decisions. That would mean labelling real rooms,
training, and keeping a ~2 GB dependency alive. Given zero-shot scored 29.3% here, the honest
expectation is uncertain, and the rules already do 96% on English names for free and offline.
