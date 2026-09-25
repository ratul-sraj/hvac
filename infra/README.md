# `infra/` — LoadLens on AWS (always-free tier)

The plain-English runbook is **[../docs/DEPLOY-AWS.md](../docs/DEPLOY-AWS.md)**.
Start there. This file is just the index.

## The order

```bash
bash infra/00-preflight.sh                     # CLI + credentials + region
bash infra/10-budget-alarm.sh you@example.com  # USD 1/month alert  — FIRST
bash infra/20-site-bucket.sh                   # private S3 bucket
bash infra/40-lambda.sh                        # Lambda + Function URL
bash infra/30-cloudfront.sh                    # CDN + OAC + /api/* behaviour
bash infra/50-deploy-site.sh                   # upload the site + invalidate
bash infra/oidc-github-role.sh                 # keyless GitHub Actions deploys
bash infra/99-teardown.sh                      # remove everything
```

## Files

| file | purpose |
| --- | --- |
| `lib-common.sh` | logging, `confirm`, the no-secrets credential check |
| `lib-state.sh` | the naming convention (bucket / distribution / function / role) and `infra/.state` |
| `lib-prune.mjs` | works out which S3 objects are no longer part of the site (used by `--prune`) |
| `00-preflight.sh` | read-only check of the CLI, credentials and region |
| `10-budget-alarm.sh` | the money guard: a USD 1/month budget with email alerts |
| `20-site-bucket.sh` | create/configure the private bucket (public access blocked, SSE-S3) |
| `30-cloudfront.sh` | distribution, OAC, bucket policy, `/api/*` → Function URL |
| `40-lambda.sh` | execution role, function, public Function URL, concurrency ceiling |
| `50-deploy-site.sh` | S3 sync with content types + cache headers, then invalidation |
| `99-teardown.sh` | ordered, confirmed deletion of all of it |
| `oidc-github-role.sh` | GitHub OIDC provider + least-privilege deploy role |
| `oidc-trust-policy.json.tmpl` | trust policy with `__GITHUB_SUB__` pinned to one repository |

`infra/.state`, `infra/.stage/` and `infra/.tmp/` are local, gitignored and
contain no secrets.

## Rules this toolkit keeps

- Everything is idempotent — run any script twice.
- No secret is ever printed, stored in the repo, or typed by a script.
- No paid service: no Route 53, ACM, WAF, Cognito or RDS. CloudFront's default
  certificate, S3 only for storage, CloudFront for all egress.
- The bucket is private; only the CloudFront distribution (via OAC) may read it.
- The Lambda role can only write CloudWatch Logs. The handler needs nothing else.
- The GitHub role can only sync one bucket, update one function and invalidate
  one distribution, and only for the configured repository.
