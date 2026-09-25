#!/usr/bin/env bash
# infra/00-preflight.sh — check that this machine can talk to AWS at all.
#
#   bash infra/00-preflight.sh
#
# Prints: the AWS CLI version, the caller identity, the region that will be
# used, and whether credentials are configured. It NEVER prints a secret value
# (the secret_key row from `aws configure list` is filtered out on purpose).
#
# Nothing is created or changed by this script.
set -uo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib-state.sh"
load_state

log_title "LoadLens on AWS — preflight"

# ---------------------------------------------------------------------------
# 1. tools
# ---------------------------------------------------------------------------
log_step "Tools"
FAIL=0

if have aws; then
  require_aws_cli
else
  log_err "the AWS CLI is not on PATH."
  log_info "Windows (git-bash):  winget install Amazon.AWSCLI"
  log_info "macOS:               brew install awscli"
  log_info "Linux:               https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
  FAIL=1
fi

if have node; then
  log_ok "node: $(node --version)   (the Lambda zip is built by tools/build-lambda.mjs)"
else
  log_warn "node is not on PATH — infra/50-deploy-site.sh still works, but you cannot build the Lambda zip."
fi

if have zip; then
  log_ok "zip: present (not required — the zip is built by node)"
else
  log_info "zip: not installed (fine — the Lambda zip is built by node, not by zip)"
fi

# ---------------------------------------------------------------------------
# 2. credentials — report the TYPE and the masked key, never the secret
# ---------------------------------------------------------------------------
log_step "Credentials"
CREDS_OK=0
if have aws; then
  CONFIG_LIST="$(aws configure list 2>&1 | grep -v '^secret_key')"
  printf '%s\n' "$CONFIG_LIST" | sed 's/^/     /'
  if aws sts get-caller-identity --output text --query '[Account,Arn]' --no-cli-pager >/dev/null 2>&1; then
    CREDS_OK=1
  fi
fi

if [ "$CREDS_OK" = "1" ]; then
  IDENTITY="$(aws sts get-caller-identity --output json --no-cli-pager 2>/dev/null)"
  ACCOUNT_ID="$(printf '%s' "$IDENTITY" | sed -n 's/.*"Account"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  ARN="$(printf '%s' "$IDENTITY" | sed -n 's/.*"Arn"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  USER_ID="$(printf '%s' "$IDENTITY" | sed -n 's/.*"UserId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  log_ok "credentials work"
  log_info "account id : ${ACCOUNT_ID:-<unknown>}"
  log_info "identity   : ${ARN:-<unknown>}"
  log_info "user id    : ${USER_ID:-<unknown>}"
  if [ -n "${ACCOUNT_ID:-}" ]; then
    save_state ACCOUNT_ID "$ACCOUNT_ID"
    SITE_BUCKET="loadlens-site-$ACCOUNT_ID"
    save_state SITE_BUCKET "$SITE_BUCKET"
  fi
else
  log_err "credentials are NOT configured (or are not valid)."
  log_info ""
  log_info "What to do (do this yourself — never paste a key into a chat or a file):"
  log_info "  1. AWS console -> IAM -> Users -> Create user (no console access needed)"
  log_info "  2. Create an access key (\"Command Line Interface\") and download the .csv ONCE"
  log_info "  3. In this terminal:"
  log_info "         aws configure"
  log_info "         AWS Access Key ID     : <paste your key id>"
  log_info "         AWS Secret Access Key : <paste your secret>"
  log_info "         Default region name   : ap-south-1"
  log_info "         Default output format : json"
  log_info "  4. Re-run:  bash infra/00-preflight.sh"
  log_info ""
  log_info "The runbook (docs/DEPLOY-AWS.md) lists the IAM permissions that user needs."
  FAIL=1
fi

# ---------------------------------------------------------------------------
# 3. the region everything will be created in
# ---------------------------------------------------------------------------
log_step "Region"
log_info "region for every resource: $AWS_REGION"
log_info "CloudFront is global; it will still be managed from this region."
if [ -n "${ACCOUNT_ID:-}" ]; then
  log_info "site bucket name: loadlens-site-$ACCOUNT_ID  (globally unique by design)"
fi
case "$AWS_REGION" in
  ap-south-1) log_ok "ap-south-1 (Mumbai) — closest region to Kerala" ;;
  us-east-1)  log_warn "us-east-1: works, but every upload from India travels further" ;;
  *)          log_warn "unusual region for this project: $AWS_REGION" ;;
esac

# ---------------------------------------------------------------------------
# 4. what this account's free tier actually is
# ---------------------------------------------------------------------------
log_step "Free tier reality check (read this)"
log_info "This AWS account is OLD (created before 15 Jul 2025), so the 12-month"
log_info "EC2/S3 allowances have EXPIRED. Only the always-free parts apply:"
log_info "  * Lambda      : 1,000,000 requests + 400,000 GB-s per month"
log_info "  * CloudFront  : 1 TB data transfer out + 10,000,000 requests per month"
log_info "  * Regional data transfer out: 100 GB per month"
log_info "  * S3 storage  : ~20 MB of static files is about USD 0.0005 per month"
log_info "                  (NOT zero — S3 storage has no always-free allowance)"
log_info "  * Budgets     : the first 2 budgets are free"
log_info "Run infra/10-budget-alarm.sh FIRST so a surprise is emailed to you."

# ---------------------------------------------------------------------------
log_title "Result"
if [ "$FAIL" = "0" ]; then
  log_ok "preflight passed — next:  bash infra/10-budget-alarm.sh you@example.com"
  exit 0
fi
log_err "preflight found problems — fix the items above, then run it again."
exit 1
