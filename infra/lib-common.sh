#!/usr/bin/env bash
# infra/lib-common.sh — shared helpers for the LoadLens AWS scripts.
# This file is SOURCED by the numbered scripts; never run it directly.
#
# Nothing here talks to AWS by itself except assert_credentials().

# ---------------------------------------------------------------------------
# environment hygiene: never let the AWS CLI open an interactive pager or
# auto-prompt during an unattended run.
# ---------------------------------------------------------------------------
export AWS_PAGER=""
export AWS_CLI_AUTO_PROMPT=off
export AWS_CLI_FILE_ENCODING="UTF-8"

# The scripts run fine under `bash` on Windows/git-bash, Linux and macOS.
# They deliberately use only: bash 3.2+, the AWS CLI v2, and `sed`/`grep`/`find`.
# No jq, no system zip, no python.

# ---------------------------------------------------------------------------
# output
# ---------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_INFO=$'\033[36m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_OK=""; C_WARN=""; C_ERR=""; C_INFO=""
fi

log_title() {
  printf '\n%s%s%s\n' "$C_BOLD" "$*" "$C_RESET"
  printf '%s%s%s\n' "$C_DIM" "--------------------------------------------------------------------------------" "$C_RESET"
}
log_step() { printf '%s==>%s %s\n' "$C_INFO" "$C_RESET" "$*"; }
log_ok()   { printf '%s  ok%s %s\n' "$C_OK" "$C_RESET" "$*"; }
log_info() { printf '     %s\n' "$*"; }
log_warn() { printf '%swarn%s %s\n' "$C_WARN" "$C_RESET" "$*" >&2; }
log_err()  { printf '%serr %s %s\n' "$C_ERR" "$C_RESET" "$*" >&2; }
die()      { log_err "$*"; exit 1; }

# confirm "Question?" -> 0 when the user says yes. Reads from stdin.
confirm() {
  _q="$1"
  printf '%s [y/N] ' "$_q"
  read -r _a || _a=""
  case "$_a" in
    y|Y|yes|YES|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

nativepath() {
  # Any NATIVE Windows program (aws.exe, node.exe) cannot read an MSYS path like /d/webhvac/x and
  # needs D:/webhvac/x instead. cygpath does the conversion.
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$p"; else printf '%s' "$p"; fi
}

awsbin() {
  # Same as awsfile(), but for the binary scheme the AWS CLI uses for --zip-file uploads.
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then p="$(cygpath -m "$p")"; fi
  printf 'fileb://%s' "$p"
}

awsfile() {
  # Build a file:// parameter for the AWS CLI. aws.exe is a NATIVE Windows program, so it cannot
  # read an MSYS path like /d/webhvac/... — it must get D:/webhvac/... . cygpath does that.
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then p="$(cygpath -m "$p")"; fi
  printf 'file://%s' "$p"
}

# ---------------------------------------------------------------------------
# requirements
# ---------------------------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

require_cmd() {
  # The AWS CLI MSI installs to C:\Program Files\Amazon\AWSCLIV2 but a non-interactive shell
  # (cron / a detached background job) may not have it on PATH yet, so look there before giving up.
  if [ "$1" = "aws" ] && ! command -v aws >/dev/null 2>&1; then
    for _d in "/c/Program Files/Amazon/AWSCLIV2" "/c/Program Files (x86)/Amazon/AWSCLIV2"; do
      [ -x "$_d/aws.exe" ] && PATH="$PATH:$_d" && export PATH && break
    done
  fi
  have "$1" || die "required command '$1' is not on PATH"
}

require_aws_cli() {
  require_cmd aws
  AWS_CLI_VERSION="$(aws --version 2>&1 | head -n 1)"
  log_ok "AWS CLI: $AWS_CLI_VERSION"
}

# Fail early (with instructions) when there are no usable credentials.
# Never prints any secret value.
assert_credentials() {
  if aws sts get-caller-identity --output text --query '[Account,Arn]' --no-cli-pager >/dev/null 2>&1; then
    return 0
  fi
  log_err "No usable AWS credentials were found."
  log_info "Create an access key for an IAM user in the console, then run this YOURSELF"
  log_info "(never paste keys into a chat or a script):"
  log_info ""
  log_info "    aws configure            # access key id, secret access key, region"
  log_info "    # region: ${AWS_REGION:-ap-south-1}"
  log_info ""
  log_info "or export AWS_PROFILE=<name> / AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY."
  log_info "Check with:  bash infra/00-preflight.sh"
  die "credentials are required for this step"
}

# ---------------------------------------------------------------------------
# tiny JSON helpers (no jq on this machine)
# ---------------------------------------------------------------------------

# json_string_array a b c -> ["a","b","c"]   (values are not escaped; use only
# for the simple host names / URLs we build here)
json_string_array() {
  _out=""; _sep=""
  for _x in "$@"; do
    _out="$_out$_sep\"$_x\""
    _sep=","
  done
  printf '[%s]' "$_out"
}

# copy the *first* line of a command's stdout (used to read a single aws value)
aws_value() {
  aws "$@" --no-cli-pager 2>/dev/null | head -n 1
}

# Run a command; return 0 when it fails with an "already exists"-style message.
# Usage: run_ignoring_duplicate <pattern> cmd args...
run_ignoring_duplicate() {
  _pat="$1"; shift
  if _out="$("$@" 2>&1)"; then
    return 0
  fi
  case "$_out" in
    *"$_pat"*) log_ok "already exists — nothing to do" ; return 0 ;;
    *) log_err "$_out"; return 1 ;;
  esac
}
