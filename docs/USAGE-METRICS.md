# Usage metrics — the anonymous ad funnel

LoadLens counts a small, fixed set of real actions so a few rupees of Google/Meta
ads can be read: how many people **arrived**, how many did something real, and
how many reached an **export**. It is deliberately the smallest thing that can
answer those questions, because the promise that a drawing is never sent to a third
party — and never stored or logged — is one the tool must keep.

## What is measured

Ten events, and nothing else. Each is a real button/action — there is no scroll,
hover, idle or "time on page" event.

| step (funnel) | event | fires when |
| --- | --- | --- |
| **arrived** | `app_open` | the calculator page loads (once per page load) |
| **engaged** | `sample_loaded` | the built-in sample drawing was loaded |
| **engaged** | `plan_parsed` | a PDF floor plan parsed successfully |
| **engaged** | `schedule_imported` | an Excel/CSV room schedule was imported |
| **worked** | `trace_run` | "trace real outlines" stored at least one outline |
| **worked** | `rooms_placed` | "place all rooms on the plan" placed at least one box |
| **converted** | `export_csv` | the CSV was downloaded |
| **converted** | `report_opened` | the printable report was opened |
| **converted** | `share_link_copied` | the "Copy link to LoadLens" button succeeded |
| (failure signal) | `calc_empty` | a calculation produced **zero** included rooms (once per page load) |

## What is sent

One small JSON body per event, posted to `POST /api/event`:

```json
{"e":"sample_loaded","p":{"source":"sample"},
 "utm_source":"google","utm_medium":"cpc","utm_campaign":"kerala-hvac","utm_content":"ad-3"}
```

That is the whole surface:

- the **event name** (must be one of the ten above),
- at most a few **coarse properties**, each restricted to a fixed vocabulary
  (`source`: sample/upload/schedule/manual/stored; `reader`: server/browser/ocr/schedule) —
  a value that is not on the list is dropped,
- the four **`utm_*` campaign tags already present in the page URL**.

## What is NOT sent (and cannot be)

- **No cookies**, no `localStorage`/`sessionStorage` id, no fingerprint, no user id.
- **No IP address, no user agent, no referrer** — the Lambda never logs them.
- **No plan data**: not the drawing, its bytes, room names, areas, counts, the
  project name, or anything derived from any of them. The property vocabulary is
  closed, so free text cannot ride along.
- **No third-party analytics** and no CDN script: `js/usage.js` is a plain ES
  module served from this same site and posts to this same origin.

The browser sends with `navigator.sendBeacon` when it is available and falls back
to `fetch(..., { keepalive: true })`. Every error is swallowed — counting can
never block or break the calculator. A page that never triggers a tracked action
sends **nothing**.

## Where it goes

`POST /api/event` is handled in `lambda/index.mjs` (before the Express app sees
it). It writes **one JSON line per accepted event** to CloudWatch Logs:

```
{"evt":"usage","e":"app_open","utm_source":"google","utm_campaign":"kerala-hvac"}
```

That `evt:"usage"` line is the only line that carries event data — and it is the only
thing this pipeline stores. The same log group also holds each Lambda invocation's own
AWS `START` / `END` / `REPORT` lines, and — when request logging is on (`LOG_REQUESTS`,
the default; see `lib/config.js`) — one line per HTTP request (method, path, status,
duration). **None of those other lines carry an IP address, a user agent, a referrer or
a request body.** `tools/funnel.mjs` filters the group down to the `evt:"usage"` lines,
so only the event counts below are ever read out.

Anything that is not one of the ten events, is bigger than ~1 KB, or does not
parse is answered with a bare **`204 No Content`** (no body, nothing leaked) and
is **not logged**. The log group is the function's own:
`/aws/lambda/loadlens-api`. There is no other storage — no database, no table.

## Reading the funnel

```bash
node tools/funnel.mjs                 # the last 24 hours
node tools/funnel.mjs --days 7        # the last 7 days
node tools/funnel.mjs --days 1 --json # also dump the raw counts as JSON
```

It prints the funnel (arrived → engaged → worked → converted) with each step as a
percentage of the one before, a per-event table, and a breakdown by
`utm_campaign` and by `utm_content` so ad groups can be compared side by side.
`share_link_copied` counts in the converted step; `calc_empty` is printed separately
as a **failure signal** (a rise in it means arrivals that reached a calculation and
found nothing) so it can never be read as a success. It works when there is no data
yet: it prints zeros and exits `0`.

Under the hood it runs the AWS CLI exactly like the rest of `infra/` — this is
the exact command it uses (paginated with `--next-token` when there is more):

```bash
aws logs filter-log-events \
  --log-group-name /aws/lambda/loadlens-api \
  --start-time <ms since epoch> --end-time <ms since epoch> \
  --filter-pattern '{ $.evt = "usage" }' \
  --limit 10000 --region ap-south-1 --output json
```

## Honest caveats

- **These are event counts, not unique people.** With no cookie and no id there
  is no way to tell one visitor from another, so someone who loads the page twice
  counts twice. That is the deliberate price of counting without tracking anyone.
- `trace_run` only counts when the trace actually stored an outline (`accepted > 0`);
  a trace that found nothing is not a "worked" signal.
- `calc_empty` is sent at most once per page load, and only after a real attempt
  (a load that added no rooms, or every room excluded) — an untouched empty page
  never counts.
- Campaign numbers only exist for arrivals that carry `utm_*` tags. Ad links must
  include them (see `docs/ADS-PLAN.md`); organic/direct traffic shows as `(none)`.
- **Cost:** this rides on CloudWatch Logs, which is inside the always-free
  allowance (5 GB ingestion / month). At ~60 bytes per event that is millions of
  events before it costs anything.

## Files

- `js/usage.js` — the browser side: the allowlist, the UTM reader, `track()`.
- `js/app.js` — the ten call sites (one per real action).
- `lambda/index.mjs` — `POST /api/event`: validate → one CloudWatch line → 204.
- `tools/funnel.mjs` — the readout above.
- `tests/test-usage.mjs` — proves the allowlist, the rejection of oversized/unknown
  bodies, and that no free text or plan data can travel.
