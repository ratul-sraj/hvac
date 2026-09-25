# Deploying LoadLens to AWS — the honest runbook

This puts LoadLens on AWS and keeps it inside the **always-free tier**, driven by
the AWS CLI and by GitHub Actions. It is written for someone who is new to AWS.
Take it one section at a time.

Everything is in `infra/`. You never have to write an AWS command by hand — each
step is one `bash infra/NN-....sh` line.

> **Read this first.** Nothing in `infra/` has ever been executed against AWS.
> There were no AWS credentials on the machine where this toolkit was written, so
> every script was only syntax-checked (`bash -n`) and the CloudFront config was
> only checked as JSON. The commands are correct as written, but the *first* run
> is genuinely the first run. `docs/DEPLOY-AWS.md` says exactly what was and was
> not verified at the end.

---

## 1. What you get, and what it costs

| piece | what it is | cost |
| --- | --- | --- |
| **S3** | the private bucket holding `index.html`, `css/`, `js/`, `vendor/` (~20 MB) | about **USD 0.0005 / month**. Not zero — S3 storage has no always-free allowance on an account this old. Half a tenth of a cent. |
| **CloudFront** | the public HTTPS address, reading S3 through an **Origin Access Control** | free: 1 TB out + 10 M requests every month, forever |
| **Lambda** | `/api/health` and `/api/parse` behind a Function URL | free: 1 M requests + 400,000 GB-s every month, forever |
| **IAM / Budgets** | the roles the deploy uses, and the $1 alert | free |

Your account was created **before 15 July 2025**, so the 12-month EC2/S3
allowances have already expired. Only the always-free parts above still apply.
That is fine for this design: S3 is used for **storage only**, and all egress
goes through CloudFront, which is the one service with a very large always-free
data allowance.

No Route 53, no ACM certificate, no WAF, no Cognito, no RDS. The site uses
CloudFront's default certificate (`*.cloudfront.net`), so there is no custom
domain to pay for and nothing to renew.

---

## 2. Do this by hand FIRST (about 15 minutes)

The scripts cannot do these three things for you.

### 2.1 Choose a region

**ap-south-1 (Mumbai)** — closest to Kerala, so uploads and downloads are quick.
Every script defaults to it.

### 2.2 Create an IAM user and an access key

1. AWS console → **IAM** → **Users** → **Create user**. Name it for yourself,
   e.g. `loadlens-deployer`. No console access is needed.
2. Open the user → **Permissions** → **Add permissions** → **Create inline
   policy** → JSON, and paste this (it is the smallest set that can run the
   scripts):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "Identity", "Effect": "Allow", "Action": ["sts:GetCallerIdentity"], "Resource": "*" },
    { "Sid": "Bucket", "Effect": "Allow",
      "Action": ["s3:CreateBucket","s3:DeleteBucket","s3:ListAllMyBuckets","s3:GetBucketLocation",
                 "s3:ListBucket","s3:GetObject","s3:PutObject","s3:DeleteObject",
                 "s3:GetBucketPolicy","s3:PutBucketPolicy","s3:DeleteBucketPolicy",
                 "s3:GetBucketPublicAccessBlock","s3:PutBucketPublicAccessBlock",
                 "s3:GetBucketWebsite","s3:PutBucketWebsite","s3:DeleteBucketWebsite",
                 "s3:GetBucketOwnershipControls","s3:PutBucketOwnershipControls",
                 "s3:GetEncryptionConfiguration","s3:PutEncryptionConfiguration",
                 "s3:GetBucketTagging","s3:PutBucketTagging"],
      "Resource": ["arn:aws:s3:::loadlens-site-*", "arn:aws:s3:::loadlens-site-*/*"] },
    { "Sid": "CloudFront", "Effect": "Allow",
      "Action": ["cloudfront:CreateDistribution","cloudfront:GetDistribution","cloudfront:GetDistributionConfig",
                 "cloudfront:UpdateDistribution","cloudfront:DeleteDistribution","cloudfront:ListDistributions",
                 "cloudfront:CreateInvalidation","cloudfront:GetInvalidation",
                 "cloudfront:CreateOriginAccessControl","cloudfront:GetOriginAccessControl",
                 "cloudfront:ListOriginAccessControls","cloudfront:DeleteOriginAccessControl",
                 "cloudfront:GetCachePolicy","cloudfront:GetOriginRequestPolicy"],
      "Resource": "*" },
    { "Sid": "Lambda", "Effect": "Allow",
      "Action": ["lambda:CreateFunction","lambda:GetFunction","lambda:GetFunctionConfiguration",
                 "lambda:UpdateFunctionCode","lambda:UpdateFunctionConfiguration","lambda:DeleteFunction",
                 "lambda:ListFunctions","lambda:TagResource",
                 "lambda:GetFunctionUrlConfig","lambda:CreateFunctionUrlConfig",
                 "lambda:UpdateFunctionUrlConfig","lambda:DeleteFunctionUrlConfig",
                 "lambda:PutFunctionConcurrency","lambda:DeleteFunctionConcurrency"],
      "Resource": "*" },
    { "Sid": "Iam", "Effect": "Allow",
      "Action": ["iam:CreateRole","iam:GetRole","iam:UpdateAssumeRolePolicy","iam:DeleteRole",
                 "iam:AttachRolePolicy","iam:DetachRolePolicy","iam:ListAttachedRolePolicies",
                 "iam:PutRolePolicy","iam:DeleteRolePolicy","iam:ListRolePolicies","iam:TagRole",
                 "iam:CreateOpenIDConnectProvider","iam:ListOpenIDConnectProviders",
                 "iam:GetOpenIDConnectProvider","iam:DeleteOpenIDConnectProvider"],
      "Resource": "*" },
    { "Sid": "Budget", "Effect": "Allow", "Action": ["budgets:*"], "Resource": "*" },
    { "Sid": "Logs", "Effect": "Allow",
      "Action": ["logs:DescribeLogGroups","logs:DeleteLogGroup","logs:ListTagsForResource"],
      "Resource": "*" }
  ]
}
```

3. Then **Security credentials** → **Create access key** → choose *Command Line
   Interface* → download the `.csv`. This is the only time the secret is shown.

> This user is more powerful than the app needs — it has to create roles and
> distributions. Keep the key in a password manager. The **GitHub Actions** side
> does *not* use it (see §6): GitHub gets a short-lived keyless role instead.

### 2.3 Configure the CLI yourself, with your own keys

In git-bash:

```bash
aws configure
# AWS Access Key ID     : <your key id>
# AWS Secret Access Key : <your secret>
# Default region name   : ap-south-1
# Default output format : json
```

Nobody else should ever type those keys — not into a script, not into a chat.

### 2.4 Create the budget alarm — the script does this, but it must be first

`infra/10-budget-alarm.sh` (step 3 below) is the guard. **Run it before anything
else touches AWS.** It is the only thing that will warn you if something starts
costing money.

---

## 3. The script order

Run these from `D:/webhvac`. Each one is safe to run twice: re-running updates
what exists instead of creating a duplicate.

```bash
cd D:/webhvac

bash infra/00-preflight.sh                     # 1. is the CLI + key working?
bash infra/10-budget-alarm.sh you@example.com  # 2. the USD 1/month alert  (FIRST!)
bash infra/20-site-bucket.sh                   # 3. the private S3 bucket
bash infra/40-lambda.sh                        # 4. the API + Function URL
bash infra/30-cloudfront.sh                    # 5. CDN with OAC + /api/*
bash infra/50-deploy-site.sh                   # 6. upload the site
bash infra/oidc-github-role.sh                 # 7. keyless deploys from GitHub
```

Note the order of 4 then 5: CloudFront needs the Function URL, and it reads it
from `infra/.state`. (Step 3 and 4 do not depend on each other.)

### What each step creates

| script | creates / does | can be re-run |
| --- | --- | --- |
| `00-preflight.sh` | prints CLI version, your account id, region, whether the key works. Changes nothing. | yes |
| `10-budget-alarm.sh` | one MONTHLY **COST** budget of USD 1 with an email at 80% actual and 100% forecast. Warning only — it never stops a resource. | upsert |
| `20-site-bucket.sh` | `loadlens-site-<account id>`, public access fully blocked, ACLs off, SSE-S3, website hosting on, tagged. | yes |
| `40-lambda.sh` | IAM role `loadlens-lambda-role` (**only** `AWSLambdaBasicExecutionRole` — the handler needs no AWS permissions), the function `loadlens-api` from `dist/loadlens-lambda.zip`, a **Function URL** with auth `NONE`, and reserved concurrency 5 as a cost ceiling. | yes |
| `30-cloudfront.sh` | one distribution: S3 origin via **OAC** + a bucket policy naming only that distribution, a `/api/*` behaviour pointed at the Function URL with caching disabled, default behaviour cached, `index.html` as the root object, 403/404 → `/index.html`. Prints `https://xxxx.cloudfront.net`. | yes |
| `50-deploy-site.sh` | uploads `*.html favicon.svg css js vendor` with the right content types and cache headers, then invalidates `/`, `/index.html`, `/*.html`. | yes |
| `oidc-github-role.sh` | the GitHub OIDC provider (if absent) and the role `loadlens-github-deploy`, scoped to `repo:ratul-sraj/hvac:*` **only**. Prints the role ARN. | yes |
| `99-teardown.sh` | removes all of the above, with a confirmation prompt. | yes |

`infra/lib-common.sh` and `infra/lib-state.sh` are shared by all of them and are
not run directly. `infra/.state` remembers the names that were created (never
any secret) — that is how the scripts agree on the same bucket, distribution and
function between runs. It is gitignored.

### Handy extras

```bash
bash infra/50-deploy-site.sh --with-samples   # also publish tests/samples/ as /samples/ (PUBLIC!)
bash infra/50-deploy-site.sh --prune          # list + delete objects that are no longer in the build
bash infra/30-cloudfront.sh --no-wait         # do not wait for the edge network
SKIP_INVALIDATION=1 bash infra/50-deploy-site.sh
SITE_BUCKET=loadlens-site-mine bash infra/20-site-bucket.sh
```

---

## 4. What you should see

After step 5 finishes, the script prints the distribution domain, e.g.
`https://d111111abcdef8.cloudfront.net`. Then:

```bash
curl -sS https://<distribution-domain>/api/health
# {"ok":true,"app":"WebHVAC",...}

curl -sSI https://<distribution-domain>/            # HTTP/2 200, content-type text/html
```

The **first** CloudFront deploy takes 3–8 minutes to reach every edge. Until
then a request may return a 404 — that is the propagation, not a broken upload.
The script waits up to 7 minutes for status `Deployed` by default.

`/api/*` goes to Lambda with caching off, so a health check should answer in a
few hundred milliseconds warm, or up to ~1 second cold.

---

## 5. Free-tier usage, stated honestly

| service | your usage | always-free limit | verdict |
| --- | --- | --- | --- |
| S3 storage | ~20 MB | none (expired on an old account) | **≈ USD 0.0005/month** |
| CloudFront out | you + a few testers | 1 TB + 10 M requests/month | far inside |
| CloudFront invalidation | 3 paths per deploy | 1,000 paths/month free | far inside |
| Lambda requests | one per API call | 1 M/month | far inside |
| Lambda duration | 1024 MB × ~2 s = ~2 GB-s per parse | 400,000 GB-s/month | ~200,000 parses/month |
| CloudWatch Logs | a few lines per cold start | 5 GB/month | far inside |
| AWS Budgets | 1 budget | first 2 free | free |
| Regional data transfer | CLI uploads/downloads | 100 GB/month | far inside |

A rough worst case: 10,000 PDF parses in a month ≈ 20,000 GB-s and 10,000
requests ≈ **USD 0.00**. A single misconfigured loop hammering the API is the
real risk, and that is what the USD 1 budget alert and the reserved concurrency
ceiling of 5 are for.

Why 1024 MB and 30 s for Lambda: a 25 MB drawing (the app's own per-file limit)
plus pdf.js's object graph comfortably needs more than 512 MB, and CPU scales
with memory, so 1024 MB finishes a big PDF in roughly half the time. Because
billing is GB-seconds, 2× memory for <½ the time costs about the same but is
quicker for the user. 30 s covers a multi-page drawing; one 30 s request costs
30 GB-s of the 400,000 GB-s allowance.

---

## 6. GitHub Actions deploys with OIDC (no stored keys)

`bash infra/oidc-github-role.sh` prints a role ARN. Put it in the repository as
a **variable** (it is not a secret — it is only useful to a workflow of that
same repository):

```bash
gh variable set AWS_DEPLOY_ROLE_ARN --repo ratul-sraj/hvac --body 'arn:aws:iam::123456789012:role/loadlens-github-deploy'
gh variable set AWS_REGION          --repo ratul-sraj/hvac --body 'ap-south-1'
```

or: repo → **Settings** → **Secrets and variables** → **Actions** → **Variables**.

Then `.github/workflows/deploy-aws.yml` runs on every push to `main`:

1. runs the tests, builds `dist/loadlens-lambda.zip`;
2. exchanges the workflow's OIDC token for **1-hour** temporary credentials
   (`aws-actions/configure-aws-credentials`, assuming the role above);
3. updates the Lambda code;
4. runs `infra/50-deploy-site.sh` (S3 sync + invalidation).

If `AWS_DEPLOY_ROLE_ARN` is not set, the workflow **skips with a notice and a
green run** — it does not fail the build and does not touch AWS. `pages.yml` is
untouched and keeps deploying GitHub Pages.

**Why the subject condition matters.** The role's trust policy allows
`repo:ratul-sraj/hvac:*` — *this one repository only*, any branch or PR of it. A
trust policy that used a bare `*` (or `repo:*`) would let **any GitHub
repository in the world** assume the role and write to your bucket. The script
refuses to build such a policy. If you want it tighter still:

```bash
GITHUB_SUB='repo:ratul-sraj/hvac:ref:refs/heads/main' bash infra/oidc-github-role.sh
```

Two honest caveats:

- `repo:OWNER/NAME:*` covers pull requests too. On a public repository, someone
  who can push a branch can therefore run a deploy. Tighten it to
  `ref:refs/heads/main` if this repository ever accepts outside pull requests.
- The role can update the Lambda and invalidate the cache — it cannot touch IAM,
  budgets, or other buckets. That is deliberate: the inline policy names exactly
  one bucket, one function and one distribution.

---

## 7. Removing everything

```bash
bash infra/99-teardown.sh                      # asks first (type the bucket name)
bash infra/99-teardown.sh --yes --all          # also the GitHub role, OIDC provider, budget
```

It disables and deletes the CloudFront distribution (a **disabled** distribution
is not billed, so a slow deletion costs nothing), empties and deletes the bucket,
deletes the Lambda and its role, and can optionally remove the GitHub OIDC role,
the identity provider and the budget.

Two things it deliberately leaves:

- the CloudWatch log group `/aws/lambda/loadlens-api` (free up to 5 GB, and it is
  your only record of what the API did);
- the GitHub Pages site, which this toolkit never touches.

Teardown does not cancel the current month's usage — the bill for the month still
settles at the start of the next one.

**Keep the budget even after teardown.** An idle account can still accrue charges
from anything else you have running.

---

## 8. Known limitations (please read before you trust it)

1. **6 MB request limit.** A Lambda Function URL — and therefore any request
   through CloudFront to `/api/*` — carries at most **6 MB** synchronously. The
   app allows 25 MB per file. Files larger than 6 MB cannot go through this API;
   the browser falls back to parsing the PDF locally, which is exactly what the
   app already does on GitHub Pages. This is a hard AWS limit, not a bug here.
2. **`/api/*` 404s are masked.** The 403/404 → `/index.html` mapping (needed for
   the static routes) also applies to a mistyped `/api/...` path: you get the app
   page with status 200 instead of JSON. Use the raw Function URL while
   debugging the API.
3. **Cold starts.** An idle Lambda takes roughly 1 second to answer the first
   request. Reserved concurrency of 5 is a deliberately low cost ceiling; above
   5 simultaneous requests visitors get a 429 and the browser parses locally.
4. **The API is public and has no rate limiting.** Anyone with the URL can call
   `/api/parse`. Reserved concurrency bounds the damage, and the budget alert
   warns you, but there is no authentication. If that matters, add a shared
   secret header or AWS WAF (WAF is **not** free — it was left out on purpose).
5. **Text-layer PDFs only.** Scanned drawings need OCR, which happens in the
   browser; the server path reads the PDF text layer. This is the app's existing
   behaviour, not something AWS adds.
6. **No versioning on the bucket.** Deliberate: every old copy is billable
   storage, and the site is in git anyway.
7. **`--prune` is manual.** Renaming a page leaves the old object in S3 (still
   reachable) until you run `bash infra/50-deploy-site.sh --prune`. CI never
   prunes, so it can never delete something unexpected.
8. **The load numbers are estimates.** Everything in the app is handbook-level
   early sizing; an engineer must check the inputs and results. AWS changes none
   of that.

---

## 9. What was and was not verified

Verified on the authoring machine (Windows, git-bash, AWS CLI 2.37.2, node 22):

- `bash -n` on every script in `infra/` — they all parse.
- The workflow YAML parses.
- The CloudFront distribution config that `30-cloudfront.sh` generates parses as
  JSON (`node -e JSON.parse`).
- The OIDC trust policy template, rendered with a sample subject, parses as JSON.

**Not** verified, because there were no AWS credentials on that machine:

- no `bash infra/*.sh` was executed against AWS — no bucket, distribution,
  function, role or budget was ever created;
- the `aws` command flags are written from the documented API shape, not from a
  successful run;
- the exact `--query` paths and the sed-rendered trust policy have not seen live
  output;
- nothing was curl-tested, because no URL exists yet.

Practically: run `infra/00-preflight.sh` first, then the steps in §3. If a step
fails, its message names the resource and the likely cause. The scripts only ever
create the names in §3 — nothing else — so a failed step leaves nothing hidden.

---

## Status: this toolkit HAS now been run — 25 Sep 2026

It was executed end to end against a real account (395298786586, ap-south-1) and the live
result was verified over HTTP. Everything below was measured, not assumed.

| what | value |
| --- | --- |
| site | https://d3cf28rp8goz0w.cloudfront.net/ (CloudFront `EJNXG9UBKL2OD`, status `Deployed`) |
| api | https://d3cf28rp8goz0w.cloudfront.net/api/health |
| function url | https://cwawlz2scsmtvbuewmfhcvai4i0gevpy.lambda-url.ap-south-1.on.aws/ |
| bucket | `loadlens-site-395298786586` |
| lambda | `loadlens-api` (nodejs22.x, 1024 MB, 30 s, x86_64, public Function URL) |
| deploy role | `arn:aws:iam::395298786586:role/loadlens-github-deploy` |
| month-to-date spend | **USD 0.00004** |
| credits | none — the account predates 15 Jul 2025, so the $200 pot never applied |

Verified: landing page 200 (12.5 kB), `/api/health` 200 through CloudFront, and
`POST /api/parse` with the 24 kB synthetic sample returned **200 with 159 rooms in ~2 s**.

### Bugs this first real run exposed (all fixed here)

1. **MSYS paths are invisible to native programs.** `aws.exe` and `node.exe` cannot open
   `/d/webhvac/...`; they need `D:/webhvac/...`. This broke file parameters
   (`file://`, `fileb://`), `aws s3 sync` sources and two JSON validators. Fixed with the
   `nativepath()`, `awsfile()` and `awsbin()` helpers in `lib-common.sh` — use them for every
   path handed to a native program.
2. **The handler path must include its folder:** the zip keeps the entry point at
   `lambda/index.mjs`, so the handler is `lambda/index.handler`, not `index.handler`
   (`index.handler` gives `Runtime.ImportModuleError`).
3. **A Function URL needs TWO resource-policy statements.** Since October 2025 AWS requires
   both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`; with only the first, every
   request gets a bare 403 `AccessDeniedException` from the front door. Note the CLI rejects
   `--function-url-auth-type` on the `InvokeFunction` statement.
4. **`Cors.AllowMethods` members must be at most 6 characters** — `"OPTIONS"` (7) is rejected;
   use `["*"]`.
5. **`IpAddressType` is not spelled `IPAddressType`** in a CloudFront `CustomOriginConfig`.
6. The AWS CLI is not on PATH inside a non-interactive shell: `lib-common.sh` now looks in
   `C:\Program Files\Amazon\AWSCLIV2` before failing.

### Still to do by hand

GitHub Actions needs repository **variables** (Settings → Secrets and variables → Actions →
Variables): `AWS_DEPLOY_ROLE_ARN=arn:aws:iam::395298786586:role/loadlens-github-deploy`,
`SITE_BUCKET=loadlens-site-395298786586`, `DISTRIBUTION_ID=EJNXG9UBKL2OD`
(`AWS_REGION` and `LAMBDA_FUNCTION` have working defaults). Nothing long-lived is stored —
the workflow exchanges a short-lived OIDC token. Until those exist the workflow skips itself
instead of failing. The subject is `repo:ratul-sraj/hvac:*`; tighten to
`repo:ratul-sraj/hvac:ref:refs/heads/main` if you want a branch-pinned deploy.

### Second pass: the hosted build's own bugs (found by pointing the browser test at CloudFront)

Running `node tests/browser-check.mjs https://<distribution>/app.html` against the live
deployment surfaced three things that localhost could not:

7. **A 200 is not proof of a PDF.** The deployment deliberately does not publish the sample
   drawing (`--with-samples` would make it public), and CloudFront's 403/404 -> /index.html
   fallback answered the missing `samples/sample-plan.pdf` with 12,539 bytes of HTML. The app
   then failed with the cryptic `InvalidPDFException: Invalid PDF structure`. `js/app.js` and
   `selftest.html` now check the `%PDF-` magic bytes and report "the sample drawing is not part
   of this deployment" instead; the sample-dependent checks in both test files are skipped rather
   than failed, so a deployment can be verified honestly either way.
8. **Unhashed code must not be cached immutably.** `js/` and `css/` were uploaded with
   `max-age=31536000, immutable`, so a fixed `js/app.js` would never reach a browser that already
   had the old copy — the fix had to be invalidated by hand to appear. They now use
   `public, max-age=300, must-revalidate`; `vendor/` stays immutable because those are libraries.
9. The browser check now runs with Chrome's download behaviour denied, because capturing the CSV
   Blob did not stop the following anchor click from saving a real file into the user's Downloads
   folder on every run.

Current state of the deployment check: **6/6 pass** against CloudFront
(site loads, title, no console errors, sample-absent message is clear, `/api/health` 200 from the
page itself, and the in-browser self test passes).
