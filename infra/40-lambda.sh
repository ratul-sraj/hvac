#!/usr/bin/env bash
# infra/40-lambda.sh — the API: IAM role, function, Function URL.
#
#   bash infra/40-lambda.sh
#
# Requires the zip built by another part of the project:
#     node tools/build-lambda.mjs       ->  dist/loadlens-lambda.zip
#
# Creates / updates:
#   1. IAM role "loadlens-lambda-role" with ONLY AWSLambdaBasicExecutionRole
#      (the handler needs no AWS permissions at all — it just parses PDFs in RAM)
#   2. the Lambda function "loadlens-api" (nodejs22.x, ZIP) from that zip
#   3. a public Function URL (auth type NONE) and prints it
#
# Idempotent: existing role/function/URL are updated, never duplicated.
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib-state.sh"
load_state

log_title "Lambda function + Function URL"

require_aws_cli
assert_credentials
ACCOUNT_ID="$(resolve_account_id)"
save_state ACCOUNT_ID "$ACCOUNT_ID"
print_context

# ---------------------------------------------------------------------------
# 0. the zip must exist
# ---------------------------------------------------------------------------
log_step "Checking the deployment package"
if [ ! -f "$LAMBDA_ZIP" ]; then
  log_err "the Lambda zip is missing: $LAMBDA_ZIP"
  log_info "Build it first (another part of the project owns this):"
  log_info "    cd $REPO_ROOT && node tools/build-lambda.mjs"
  log_info "If that file does not exist yet, the Lambda worker has not landed its part."
  exit 1
fi
ZIP_BYTES="$(wc -c < "$LAMBDA_ZIP" | tr -d ' ')"
log_ok "found $(basename "$LAMBDA_ZIP") ($ZIP_BYTES bytes)"
if [ "$ZIP_BYTES" -gt 52428800 ]; then
  log_err "the zip is over the 50 MB direct-upload limit — it would have to go via S3."
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. execution role — basic execution ONLY
# ---------------------------------------------------------------------------
# "AWSLambdaBasicExecutionRole" allows writing to CloudWatch Logs and nothing
# else. The handler receives a PDF in the request body and returns JSON; it does
# not read or write any AWS service. Cold-start logs are free within the
# CloudWatch always-free allowance (5 GB ingestion/month).
log_step "IAM role $LAMBDA_ROLE"
ROLE_JSON="$TMP_DIR/lambda-trust-policy.json"
mkdir -p "$TMP_DIR"
cat > "$ROLE_JSON" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LambdaAssumeRole",
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
JSON

if aws iam get-role --role-name "$LAMBDA_ROLE" --no-cli-pager >/dev/null 2>&1; then
  save_state LAMBDA_ROLE_ARN "$(aws iam get-role --role-name "$LAMBDA_ROLE" --query Role.Arn --output text --no-cli-pager)"
  aws iam update-assume-role-policy --role-name "$LAMBDA_ROLE" \
    --policy-document "$(awsfile "$ROLE_JSON")" --no-cli-pager >/dev/null
  log_ok "role exists — trust policy re-applied"
else
  LAMBDA_ROLE_ARN="$(aws iam create-role --role-name "$LAMBDA_ROLE" \
      --description "Execution role for the LoadLens /api Lambda (basic execution only)" \
      --assume-role-policy-document "$(awsfile "$ROLE_JSON")" \
      --tags Key=project,Value=loadlens \
      --query Role.Arn --output text --no-cli-pager)"
  save_state LAMBDA_ROLE_ARN "$LAMBDA_ROLE_ARN"
  log_ok "role created: $LAMBDA_ROLE_ARN"
  log_info "waiting ~10 s for IAM to propagate a brand-new role ..."
  sleep 10
fi
log_info "role arn: $LAMBDA_ROLE_ARN"

# Attaching the same managed policy twice is a no-op success.
aws iam attach-role-policy --role-name "$LAMBDA_ROLE" \
  --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" \
  --no-cli-pager
log_ok "AWSLambdaBasicExecutionRole attached (CloudWatch Logs only)"

# ---------------------------------------------------------------------------
# 2. the function
# ---------------------------------------------------------------------------
# 1024 MB / 30 s, and why:
#   * pdf.js parses in memory. A 25 MB drawing (the app's per-file limit) plus
#     pdf.js's own object graph peaks well over 512 MB; 1024 MB keeps the worst
#     realistic drawing away from an OutOfMemory kill.
#   * CPU scales with memory, so 1024 MB finishes a big PDF in roughly half the
#     time of 512 MB — and Lambda bills GB-seconds, so 2x memory for <1/2 the
#     time is no more expensive, just quicker for the user.
#   * 30 s covers a multi-page drawing with room to spare. Lambda's synchronous
#     limit is 900 s, but a request that long would be a bad user experience and
#     wastes free-tier GB-s.
#   * At 1024 MB, one 30 s request costs 30 GB-s of the 400,000 GB-s monthly
#     always-free allowance (~13,000 such requests/month).
log_step "Lambda function $LAMBDA_FUNCTION ($LAMBDA_RUNTIME, ${LAMBDA_MEMORY_MB} MB, ${LAMBDA_TIMEOUT_S} s, $LAMBDA_ARCH)"

ENV_JSON="$TMP_DIR/lambda-env.json"
# The handler needs no configuration and no AWS permissions. The single variable
# is only a marker so a log line can say where it is running.
cat > "$ENV_JSON" <<JSON
{ "Variables": { "LOADLENS_LAMBDA": "1" } }
JSON

if aws lambda get-function --function-name "$LAMBDA_FUNCTION" --no-cli-pager >/dev/null 2>&1; then
  log_ok "function exists — updating code and configuration"
  aws lambda update-function-code --function-name "$LAMBDA_FUNCTION" \
    --zip-file "$(awsbin "$LAMBDA_ZIP")" --no-cli-pager >/dev/null
  aws lambda wait function-updated --function-name "$LAMBDA_FUNCTION"
  # NOTE: --architectures is create-only — update-function-configuration rejects it, which is
  # fine because a function's architecture cannot change after creation anyway.
  aws lambda update-function-configuration --function-name "$LAMBDA_FUNCTION" \
    --runtime "$LAMBDA_RUNTIME" --handler "$LAMBDA_HANDLER" \
    --memory-size "$LAMBDA_MEMORY_MB" --timeout "$LAMBDA_TIMEOUT_S" \
    --environment "$(awsfile "$ENV_JSON")" \
    --no-cli-pager >/dev/null
  aws lambda wait function-updated --function-name "$LAMBDA_FUNCTION"
  log_ok "code + configuration updated"
else
  FUNCTION_ARN="$(aws lambda create-function --function-name "$LAMBDA_FUNCTION" \
      --description "LoadLens API: /api/health and /api/parse (PDF drawings -> rooms)" \
      --runtime "$LAMBDA_RUNTIME" --handler "$LAMBDA_HANDLER" \
      --role "$LAMBDA_ROLE_ARN" \
      --memory-size "$LAMBDA_MEMORY_MB" --timeout "$LAMBDA_TIMEOUT_S" \
      --architectures "$LAMBDA_ARCH" \
      --environment "$(awsfile "$ENV_JSON")" \
      --zip-file "$(awsbin "$LAMBDA_ZIP")" \
      --tags project=loadlens \
      --query FunctionArn --output text --no-cli-pager)"
  save_state FUNCTION_ARN "$FUNCTION_ARN"
  log_ok "function created: $FUNCTION_ARN"
  aws lambda wait function-active --function-name "$LAMBDA_FUNCTION"
fi

# ---------------------------------------------------------------------------
# 3. reserved concurrency — a cost ceiling you set on purpose
# ---------------------------------------------------------------------------
# Reserved concurrency is itself free, but it caps how much of the free tier (and
# therefore how much money) a flood of requests can consume: at most
# LAMBDA_RESERVED_CONCURRENCY requests run at once. 5 x 30 s x 1 GB = 150 GB-s in
# the worst possible burst. Visitors above the cap get a 429 and the browser
# falls back to parsing the PDF locally, which is exactly what the app already
# does on GitHub Pages.
if [ "$LAMBDA_RESERVED_CONCURRENCY" != "0" ]; then
  if aws lambda put-function-concurrency --function-name "$LAMBDA_FUNCTION" \
        --reserved-concurrent-executions "$LAMBDA_RESERVED_CONCURRENCY" --no-cli-pager >/dev/null 2>&1; then
    log_ok "reserved concurrency: $LAMBDA_RESERVED_CONCURRENCY (cost ceiling)"
  else
    log_warn "could not set reserved concurrency (setting it to 0 would un-reserve: LAMBDA_RESERVED_CONCURRENCY=0)"
  fi
fi

# ---------------------------------------------------------------------------
# 4. the Function URL
# ---------------------------------------------------------------------------
log_step "Function URL (auth type NONE — it is a public PDF parser, no secrets involved)"

LAMBDA_URL_PRE=""
if aws lambda get-function-url-config --function-name "$LAMBDA_FUNCTION" --no-cli-pager >/dev/null 2>&1; then
  LAMBDA_URL_PRE="$(aws lambda get-function-url-config --function-name "$LAMBDA_FUNCTION" --query FunctionUrl --output text --no-cli-pager)"
  log_ok "URL exists: $LAMBDA_URL_PRE"
fi
URL_ARGS=(--function-name "$LAMBDA_FUNCTION" --auth-type NONE --invoke-mode BUFFERED)

# CORS: the app on GitHub Pages (https://<owner>.github.io) calls this API
# cross-origin, so the function URL must answer the preflight. The allowed list
# is the CloudFront domain (same-origin traffic needs no CORS but it is harmless)
# plus the Pages host. Set ALLOWED_ORIGINS="*" to open it to any website.
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-}"
if [ -z "$ALLOWED_ORIGINS" ]; then
  _origins=()
  [ -n "${DISTRIBUTION_DOMAIN:-}" ] && _origins+=("https://$DISTRIBUTION_DOMAIN")
  _origins+=("https://$GITHUB_PAGES_HOST")
  if [ "${#_origins[@]}" -gt 0 ]; then
    ALLOWED_ORIGINS="$(json_string_array "${_origins[@]}")"
  else
    ALLOWED_ORIGINS='["*"]'
  fi
fi
CORS_JSON="$TMP_DIR/function-url-cors.json"
cat > "$CORS_JSON" <<JSON
{
  "AllowCredentials": false,
  "AllowHeaders": [ "content-type", "accept" ],
  "AllowMethods": [ "*" ],
  "AllowOrigins": ${ALLOWED_ORIGINS},
  "ExposeHeaders": [ "content-type" ],
  "MaxAge": 600
}
JSON
log_info "CORS allow-origins: $ALLOWED_ORIGINS"

if LOG_OUT="$(aws lambda create-function-url-config "${URL_ARGS[@]}" --cors "$(awsfile "$CORS_JSON")" \
      --query FunctionUrl --output text --no-cli-pager 2>&1)"; then
  LAMBDA_URL="$LOG_OUT"
else
  # already exists -> update instead, then read it back
  aws lambda update-function-url-config "${URL_ARGS[@]}" --cors "$(awsfile "$CORS_JSON")" --no-cli-pager >/dev/null \
    || die "could not create or update the Function URL: $LOG_OUT"
  LAMBDA_URL="$(aws lambda get-function-url-config --function-name "$LAMBDA_FUNCTION" \
      --query FunctionUrl --output text --no-cli-pager)"
fi

case "$LAMBDA_URL" in
  https://*) : ;;
  *) die "unexpected Function URL: '$LAMBDA_URL'" ;;
esac
LAMBDA_HOST_ORIGIN="$(printf '%s' "$LAMBDA_URL" | sed -e 's#^https://##' -e 's#/$##')"
save_state LAMBDA_URL "$LAMBDA_URL" LAMBDA_HOST_ORIGIN "$LAMBDA_HOST_ORIGIN"

# A public Function URL needs TWO resource-policy statements. Since October 2025 AWS requires both
# lambda:InvokeFunctionUrl AND lambda:InvokeFunction (see docs: lambda/latest/dg/urls-auth.html),
# and the statement is not reliably added for you — when it is missing, every request gets a bare
# 403 AccessDeniedException from the front door and never reaches the function.
ensure_invoke_permission() {
  local sid="$1" action="$2"; shift 2
  local policy
  policy="$(aws lambda get-policy --function-name "$LAMBDA_FUNCTION" --query Policy --output text --no-cli-pager 2>/dev/null || true)"
  if printf '%s' "$policy" | grep -q "\\\"$sid\\\""; then
    log_ok "permission $sid already present"
  else
    aws lambda add-permission --function-name "$LAMBDA_FUNCTION" --statement-id "$sid" \
      --action "$action" --principal "*" "$@" --no-cli-pager >/dev/null \
      || die "could not add the $sid permission"
    log_ok "added permission $sid ($action)"
  fi
}
ensure_invoke_permission FunctionURLAllowPublicAccess lambda:InvokeFunctionUrl --function-url-auth-type NONE
# --function-url-auth-type is rejected for lambda:InvokeFunction (the CLI says it is "only supported
# for lambda:InvokeFunctionUrl action"), so it is passed for the first statement only.
ensure_invoke_permission FunctionURLAllowPublicInvoke lambda:InvokeFunction

# ---------------------------------------------------------------------------
log_title "Done"
log_ok "Function URL: $LAMBDA_URL"
log_info "Nothing has been tested against AWS by this toolkit. Verify it yourself:"
log_info "    curl -sS ${LAMBDA_URL}api/health"
log_info "    curl -sS -F 'files=@tests/samples/sample-plan.pdf' ${LAMBDA_URL}api/parse"
log_info ""
log_info "Known limit: a synchronous Lambda request (through the Function URL *and*"
log_info "through CloudFront) carries at most 6 MB. Bigger PDFs must be parsed in the"
log_info "browser, which is the app's existing fallback."
log_info ""
log_info "Next: DISTRIBUTION_ID=... is not needed — 30-cloudfront.sh reads the Function"
log_info "URL from $STATE_FILE. Run:  bash infra/30-cloudfront.sh"
