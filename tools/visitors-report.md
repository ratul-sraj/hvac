# LoadLens — unique real visitors (CloudFront access logs)

Human-readable output of `tools/visitors.mjs`, which reads **this site's own** CloudFront
standard access logs (bucket `loadlens-logs-395298786586`, prefix `cf/`) and counts unique real
visitors for a window, with bots and the owner's own traffic removed.

How to run:

```
node tools/visitors.mjs                 # the last 24 hours
node tools/visitors.mjs --hours 48      # a wider window
node tools/visitors.mjs --json          # add a machine-readable block
```

Privacy: a visitor is a 12-character salted hash of (the address that asked + the browser type),
one per UTC day. A raw address is never printed and never stored, here or in `--json`. Own traffic
is excluded by a bot/automation deny-list and by an own-address file kept **outside this repo**
(default `C:\Users\Aorus\Documents\LoadLens-Own-IPs.txt`; override with `--own-ips <path>`); the
addresses in that file are never printed either.

---

## Run: 2026-10-04 10:26 UTC, `node tools/visitors.mjs --hours 24`

```
$ node tools/visitors.mjs --hours 24
nothing delivered yet, CloudFront delivers in hourly batches with up to an hour of delay
  (looked in s3://loadlens-logs-395298786586/cf/)
```

The log bucket exists and is reachable (the AWS identity in this environment can list it), but no
`cf/` objects have arrived yet — standard access logging was only just switched on, and CloudFront
delivers its hourly batches with up to an hour of delay. Re-run the command after the first batch
lands to get the real counts (total requests, top paths, `/api/parse` status split, unique visitors
overall / per day / per page, excluded hits, and the same count with no exclusions applied).
