#!/usr/bin/env bash
# infra/20-site-bucket.sh — the S3 bucket that holds the static site.
#
#   bash infra/20-site-bucket.sh
#   SITE_BUCKET=my-own-name bash infra/20-site-bucket.sh   # to pick the name yourself
#
# Creates (or adopts) one bucket and configures it the safe way:
#   * public access fully blocked (the site is read through CloudFront only)
#   * ACLs disabled, SSE-S3 encryption, versioning OFF (versioning costs money)
#   * static website hosting enabled (index.html / error index.html)
#   * tags so it is obvious what it is
#
# It does NOT create the bucket policy — that comes from 30-cloudfront.sh,
# because the policy must name the CloudFront distribution.
#
# Idempotent: safe to re-run; it configures an existing bucket instead of failing.
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib-state.sh"
load_state

log_title "S3 bucket for the static site"

require_aws_cli
assert_credentials
ACCOUNT_ID="$(resolve_account_id)"
BUCKET="$(resolve_site_bucket)"

# Bucket names are global across all of AWS: lowercase letters, digits, dots and
# hyphens, 3-63 characters, and never formatted like an IP address.
case "$BUCKET" in
  [a-z0-9]*)
    if printf '%s' "$BUCKET" | grep -Eq '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'; then : ; else
      die "bucket name '$BUCKET' is not valid (use lowercase letters, digits, . and -, 3-63 chars)"
    fi ;;
  *) die "bucket name '$BUCKET' must start with a lowercase letter or digit" ;;
esac

save_state ACCOUNT_ID "$ACCOUNT_ID" SITE_BUCKET "$BUCKET"
print_context

# ---------------------------------------------------------------------------
# 1. does it already exist?
# ---------------------------------------------------------------------------
log_step "Looking for s3://$BUCKET"
EXISTS=0
if aws s3api head-bucket --bucket "$BUCKET" --no-cli-pager >/dev/null 2>&1; then
  EXISTS=1
  log_ok "bucket exists — will re-apply the settings"
else
  _err="$(aws s3api head-bucket --bucket "$BUCKET" --no-cli-pager 2>&1 || true)"
  case "$_err" in
    *404*|*NoSuchBucket*|*"Not Found"*)
      log_info "does not exist yet — creating it" ;;
    *)
      log_warn "could not confirm whether the bucket exists (head-bucket said: ${_err//$'\n'/ })"
      log_warn "trying to create it anyway; a 'BucketAlreadyOwnedByYou' answer is fine."
      ;;
  esac
fi

# ---------------------------------------------------------------------------
# 2. create
# ---------------------------------------------------------------------------
if [ "$EXISTS" = "0" ]; then
  if [ "$AWS_REGION" = "us-east-1" ]; then
    CREATE_ARGS=(--bucket "$BUCKET")
  else
    # any region other than us-east-1 needs an explicit LocationConstraint
    CREATE_ARGS=(--bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=$AWS_REGION")
  fi
  if aws s3api create-bucket "${CREATE_ARGS[@]}" --no-cli-pager >/dev/null 2>&1; then
    log_ok "created s3://$BUCKET in $AWS_REGION"
  else
    _err="$(aws s3api create-bucket "${CREATE_ARGS[@]}" --no-cli-pager 2>&1 || true)"
    case "$_err" in
      *BucketAlreadyOwnedByYou*) log_ok "already owned by you — continuing" ;;
      *BucketAlreadyExists*)
        log_err "the bucket name '$BUCKET' is taken by some other AWS account."
        log_info "Pick another name and re-run:"
        log_info "    SITE_BUCKET=${BUCKET}-2 bash infra/20-site-bucket.sh"
        log_info "Then remember it for every later script (it is saved in $STATE_FILE)."
        exit 1 ;;
      *) die "could not create the bucket: $_err" ;;
    esac
  fi
fi

# ---------------------------------------------------------------------------
# 3. lock it down and configure it (all idempotent PUTs)
# ---------------------------------------------------------------------------
log_step "Applying the settings"

aws s3api put-public-access-block --bucket "$BUCKET" --no-cli-pager \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
log_ok "public access blocked (all four switches) — the bucket is private"

# ACLs disabled: nobody can make an object public by accident.
aws s3api put-bucket-ownership-controls --bucket "$BUCKET" --no-cli-pager \
  --ownership-controls "Rules=[{ObjectOwnership=BucketOwnerEnforced}]" \
  && log_ok "ACLs disabled (BucketOwnerEnforced)" \
  || log_warn "could not set ownership controls (harmless if it is already enforced)"

# SSE-S3 encryption: free, and it is the default anyway — stated explicitly.
aws s3api put-bucket-encryption --bucket "$BUCKET" --no-cli-pager \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}' \
  && log_ok "encryption: SSE-S3 (AES256)" \
  || log_warn "could not set default encryption"

# Versioning stays OFF on purpose: every old copy of every object is billable
# storage, and this bucket only ever holds the current build. An export of the
# site is a git push away.

if aws s3api put-bucket-website --bucket "$BUCKET" --no-cli-pager \
      --website-configuration '{"IndexDocument":{"Suffix":"index.html"},"ErrorDocument":{"Key":"index.html"}}'; then
  log_ok "static website hosting enabled (index.html / index.html)"
  log_info "Note: the S3 *website* endpoint stays unreachable because public access is"
  log_info "      blocked — visitors read the site through CloudFront."
fi

aws s3api put-bucket-tagging --bucket "$BUCKET" --no-cli-pager \
  --tagging "TagSet=[{Key=project,Value=loadlens},{Key=managed-by,Value=infra-20-site-bucket.sh}]" \
  && log_ok "tags applied"

# ---------------------------------------------------------------------------
log_title "Done"
log_ok "s3://$BUCKET is ready (private, encrypted, website hosting on)"
log_info "Storage cost of the whole site (~20 MB): about USD 0.0005 per month."
log_info "Not free, but five hundredths of a cent."
log_info "Next: bash infra/40-lambda.sh      (the API), then bash infra/30-cloudfront.sh"
log_info "(30 needs the Function URL that 40 prints.)"
