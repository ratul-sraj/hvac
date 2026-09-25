#!/usr/bin/env bash
# infra/lib-state.sh — the shared naming + state convention for LoadLens on AWS.
# SOURCED by every numbered script so that prod and re-runs agree on one set of
# names. Everything can be overridden with an environment variable of the same
# name; the local state file remembers what was created.
#
#   bash infra/00-preflight.sh   # sources this too

# ---------------------------------------------------------------------------
# locations
# ---------------------------------------------------------------------------
INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$INFRA_DIR/.." && pwd)"
STATE_FILE="${LOADLENS_STATE_FILE:-$INFRA_DIR/.state}"
STAGE_DIR="${LOADLENS_STAGE_DIR:-$INFRA_DIR/.stage/site}"
TMP_DIR="${LOADLENS_TMP_DIR:-$INFRA_DIR/.tmp}"

. "$INFRA_DIR/lib-common.sh"

# ---------------------------------------------------------------------------
# naming convention  (override by exporting the variable before running)
# ---------------------------------------------------------------------------
PROJECT="${PROJECT:-loadlens}"

# The region must be decided before any aws call. ap-south-1 (Mumbai) is the
# closest region to the user and the one the runbook tells you to configure.
AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-south-1}}"
export AWS_REGION
export AWS_DEFAULT_REGION="$AWS_REGION"

# GitHub repository that is allowed to deploy (used by the OIDC role).
GITHUB_REPO="${GITHUB_REPO:-ratul-sraj/hvac}"
# `sub` condition for the OIDC trust policy: repo:<owner>/<name>:<ref-or-environment>
# "*" here means "any branch, tag, environment or PR of THIS repository" —
# never a wildcard over repositories (see infra/oidc-github-role.sh).
GITHUB_SUB="${GITHUB_SUB:-repo:${GITHUB_REPO}:*}"
GITHUB_PAGES_HOST="${GITHUB_PAGES_HOST:-$(printf '%s' "$GITHUB_REPO" | cut -d/ -f1).github.io}"

# S3 bucket holding the static site. Globally unique; default derives from the
# account id, so prod and re-runs agree without any hand-written config.
SITE_BUCKET="${SITE_BUCKET:-}"          # resolved by resolve_site_bucket()

# CloudFront
OAC_NAME="${OAC_NAME:-loadlens-site-oac}"
DIST_COMMENT="${DIST_COMMENT:-loadlens-site (managed by infra/)}"
# AWS *managed* cache / origin-request policies (global ids, free to use).
CF_POLICY_CACHING_OPTIMIZED="${CF_POLICY_CACHING_OPTIMIZED:-658327ea-f89d-4fab-a63d-7e88639e58f6}"
CF_POLICY_CACHING_DISABLED="${CF_POLICY_CACHING_DISABLED:-4135ea2d-6df8-44a3-9df3-4b5a84be39ad}"
CF_POLICY_ALL_VIEWER_EXCEPT_HOST="${CF_POLICY_ALL_VIEWER_EXCEPT_HOST:-b689b0a8-53d0-40ab-baf2-68738e2966ac}"

# Lambda
LAMBDA_FUNCTION="${LAMBDA_FUNCTION:-loadlens-api}"
LAMBDA_ROLE="${LAMBDA_ROLE:-loadlens-lambda-role}"
# The zip keeps the handler under lambda/ (see tools/build-lambda.mjs), so the handler path
# must include that folder — "index.handler" yields Runtime.ImportModuleError at invoke time.
LAMBDA_HANDLER="${LAMBDA_HANDLER:-lambda/index.handler}"
LAMBDA_RUNTIME="${LAMBDA_RUNTIME:-nodejs22.x}"
LAMBDA_MEMORY_MB="${LAMBDA_MEMORY_MB:-1024}"     # see infra/40-lambda.sh
LAMBDA_TIMEOUT_S="${LAMBDA_TIMEOUT_S:-30}"       # see infra/40-lambda.sh
LAMBDA_ARCH="${LAMBDA_ARCH:-x86_64}"             # set to arm64 to try the cheaper arch
LAMBDA_RESERVED_CONCURRENCY="${LAMBDA_RESERVED_CONCURRENCY:-5}"   # 0 = do not set
LAMBDA_ZIP="${LAMBDA_ZIP:-$REPO_ROOT/dist/loadlens-lambda.zip}"

# Budget guard
BUDGET_NAME="${BUDGET_NAME:-loadlens-monthly-1usd}"
BUDGET_LIMIT_USD="${BUDGET_LIMIT_USD:-1}"

# GitHub Actions deploy role
OIDC_ROLE="${OIDC_ROLE:-loadlens-github-deploy}"
OIDC_PROVIDER_HOST="${OIDC_PROVIDER_HOST:-token.actions.githubusercontent.com}"
OIDC_THUMBPRINT="${OIDC_THUMBPRINT:-6938fd4d98bab03faadb97b34396831e3780aea1}"

# ---------------------------------------------------------------------------
# state file: plain `KEY='value'` lines, gitignored, never contains secrets
# ---------------------------------------------------------------------------
STATE_LOADED=0

load_state() {
  # remember a region that came from the real environment: an exported
  # AWS_REGION must win over the one remembered in the state file.
  _env_region="${AWS_REGION:-}"
  if [ -f "$STATE_FILE" ]; then
    # shellcheck disable=SC1090
    . "$STATE_FILE"
    STATE_LOADED=1
  else
    STATE_LOADED=0
  fi
  if [ -n "$_env_region" ]; then AWS_REGION="$_env_region"; fi
  AWS_REGION="${AWS_REGION:-ap-south-1}"
  export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
}

_set_state_line() {
  _f="$1"; _k="$2"; _v="$3"
  if [ -f "$_f" ]; then
    grep -v "^${_k}=" "$_f" > "$_f.new" 2>/dev/null || : > "$_f.new"
  else
    : > "$_f.new"
  fi
  printf "%s='%s'\n" "$_k" "$_v" >> "$_f.new"
  mv "$_f.new" "$_f"
}

# save_state KEY VALUE [KEY VALUE ...]  — writes the file and updates the shell
save_state() {
  mkdir -p "$(dirname "$STATE_FILE")"
  _tmp="$STATE_FILE.tmp.$$"
  if [ -f "$STATE_FILE" ]; then cp "$STATE_FILE" "$_tmp"; else : > "$_tmp"; fi
  while [ "$#" -ge 2 ]; do
    _set_state_line "$_tmp" "$1" "$2"
    export "$1"="$2"
    shift 2
  done
  mv "$_tmp" "$STATE_FILE"
}

# ---------------------------------------------------------------------------
# resolvers
# ---------------------------------------------------------------------------
resolve_account_id() {
  if [ -n "${ACCOUNT_ID:-}" ]; then printf '%s' "$ACCOUNT_ID"; return 0; fi
  ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text --no-cli-pager 2>/dev/null | head -n 1)"
  case "$ACCOUNT_ID" in
    ""|None) die "could not read the AWS account id — are credentials configured? (bash infra/00-preflight.sh)" ;;
  esac
  printf '%s' "$ACCOUNT_ID"
}

resolve_site_bucket() {
  if [ -n "$SITE_BUCKET" ]; then printf '%s' "$SITE_BUCKET"; return 0; fi
  SITE_BUCKET="loadlens-site-$(resolve_account_id)"
  printf '%s' "$SITE_BUCKET"
}

resolve_distribution_id() {
  if [ -n "${DISTRIBUTION_ID:-}" ]; then printf '%s' "$DISTRIBUTION_ID"; return 0; fi
  # fall back to a lookup by the comment we always set
  DISTRIBUTION_ID="$(aws cloudfront list-distributions \
      --query "DistributionList.Items[?Comment=='$DIST_COMMENT'].Id | [0]" \
      --output text --no-cli-pager 2>/dev/null | head -n 1)"
  case "$DISTRIBUTION_ID" in
    ""|None) printf ''; return 0 ;;
  esac
  printf '%s' "$DISTRIBUTION_ID"
}

# printed once by each script so the log shows what was targeted
print_context() {
  log_info "repo      : $REPO_ROOT"
  log_info "region    : $AWS_REGION"
  log_info "bucket    : $(resolve_site_bucket)"
  [ -n "${LAMBDA_URL:-}" ] && log_info "lambda url: $LAMBDA_URL"
  [ -n "${DISTRIBUTION_ID:-}" ] && log_info "cloudfront: $DISTRIBUTION_ID"
  log_info "state file: $STATE_FILE (loaded=$STATE_LOADED)"
  log_info "GitHub repo allowed to deploy: $GITHUB_REPO"
  return 0
}
