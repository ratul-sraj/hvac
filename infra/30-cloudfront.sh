#!/usr/bin/env bash
# infra/30-cloudfront.sh — CloudFront in front of S3 (static site) and the
# Lambda Function URL (the /api/* paths).
#
#   bash infra/30-cloudfront.sh                    # reads the Function URL from .state
#   bash infra/30-cloudfront.sh --lambda-url https://xxxx.lambda-url.ap-south-1.on.aws/
#   CF_WAIT_SECONDS=0 bash infra/30-cloudfront.sh  # do not wait for "Deployed"
#
# Creates / updates ONE distribution:
#   * origin 1 = the private S3 bucket, read through an Origin Access Control
#     (OAC). The bucket policy that lets only THIS distribution read it is
#     applied at the end of this script.
#   * origin 2 = the Lambda Function URL, used by the /api/* cache behaviour
#     with caching DISABLED and every header/querystring/cookie forwarded.
#   * default_root_object = index.html
#   * 403 and 404 from the origin are rendered as /index.html (SPA-ish routes)
#   * CloudFront's DEFAULT certificate (*.cloudfront.net): no ACM, no Route 53,
#     no custom domain, nothing to pay for.
#
# Idempotent: an existing distribution is updated, never duplicated.
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib-state.sh"
load_state

# ---------------------------------------------------------------------------
# arguments
# ---------------------------------------------------------------------------
CF_WAIT_SECONDS="${CF_WAIT_SECONDS:-420}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --lambda-url) LAMBDA_URL="${2:-}"; shift 2 ;;
    --wait)       CF_WAIT_SECONDS="${2:-420}"; shift 2 ;;
    --no-wait)    CF_WAIT_SECONDS=0; shift ;;
    -h|--help)    sed -n '2,25p' "$0"; exit 0 ;;
    *) die "unknown argument '$1' (try --help)" ;;
  esac
done

log_title "CloudFront distribution"

require_aws_cli
assert_credentials
ACCOUNT_ID="$(resolve_account_id)"
BUCKET="$(resolve_site_bucket)"
save_state ACCOUNT_ID "$ACCOUNT_ID" SITE_BUCKET "$BUCKET"

if [ -z "${LAMBDA_URL:-}" ]; then
  log_err "no Lambda Function URL known yet."
  log_info "Run the Lambda script first (it saves the URL for this one):"
  log_info "    bash infra/40-lambda.sh"
  log_info "or pass it explicitly:"
  log_info "    bash infra/30-cloudfront.sh --lambda-url https://xxxx.lambda-url.${AWS_REGION}.on.aws/"
  exit 1
fi
case "$LAMBDA_URL" in
  https://*) : ;;
  *) die "the Function URL must start with https:// (got '$LAMBDA_URL')" ;;
esac
LAMBDA_HOST_ORIGIN="$(printf '%s' "$LAMBDA_URL" | sed -e 's#^https://##' -e 's#/$##')"
[ -n "$LAMBDA_HOST_ORIGIN" ] || die "could not extract the host from '$LAMBDA_URL'"
save_state LAMBDA_URL "$LAMBDA_URL" LAMBDA_HOST_ORIGIN "$LAMBDA_HOST_ORIGIN"
print_context

# ---------------------------------------------------------------------------
# 0. the AWS managed cache policies must be reachable before we reference them
# ---------------------------------------------------------------------------
log_step "Checking the AWS managed cache/origin-request policies"
check_policy() { # check_policy <get-cache-policy|get-origin-request-policy> <id> <label>
  if aws cloudfront "$1" --id "$2" --no-cli-pager >/dev/null 2>&1; then
    log_ok "$3 ($2)"
  else
    die "AWS managed policy $2 ($3) was not found in this partition/account. \
Override CF_POLICY_* in $STATE_FILE or export the correct id."
  fi
}
check_policy get-cache-policy          "$CF_POLICY_CACHING_OPTIMIZED"  "CachingOptimized (static files)"
check_policy get-cache-policy          "$CF_POLICY_CACHING_DISABLED"   "CachingDisabled (API)"
check_policy get-origin-request-policy "$CF_POLICY_ALL_VIEWER_EXCEPT_HOST" "AllViewerExceptHostHeader (API)"

# ---------------------------------------------------------------------------
# 1. Origin Access Control
# ---------------------------------------------------------------------------
# OAC is the current way to let CloudFront read a private bucket. It is free.
log_step "Origin Access Control '$OAC_NAME'"
OAC_ID="${OAC_ID:-}"
if [ -z "$OAC_ID" ]; then
  OAC_ID="$(aws cloudfront list-origin-access-controls \
      --query "OriginAccessControlList.Items[?Name=='$OAC_NAME'].Id | [0]" \
      --output text --no-cli-pager 2>/dev/null | head -n 1)"
fi
case "$OAC_ID" in ""|None) OAC_ID="" ;; esac

if [ -z "$OAC_ID" ]; then
  OAC_JSON="$TMP_DIR/oac.json"
  mkdir -p "$TMP_DIR"
  cat > "$OAC_JSON" <<JSON
{
  "Name": "${OAC_NAME}",
  "Description": "LoadLens site bucket signer (managed by infra/30-cloudfront.sh)",
  "SigningProtocol": "sigv4",
  "SigningBehavior": "always",
  "OriginAccessControlOriginType": "s3"
}
JSON
  OAC_ID="$(aws cloudfront create-origin-access-control \
      --origin-access-control-config "$(awsfile "$OAC_JSON")" \
      --query OriginAccessControl.Id --output text --no-cli-pager)"
  log_ok "created OAC: $OAC_ID"
else
  log_ok "existing OAC: $OAC_ID"
fi
save_state OAC_ID "$OAC_ID"

# ---------------------------------------------------------------------------
# A SECOND origin access control, of type `lambda`, for the API origin. Without it CloudFront sends
# UNSIGNED requests to the Function URL, which means the URL's auth type has to be NONE — a public,
# unthrottled entry point that bypasses this distribution entirely (audit H1). With the OAC below the
# URL is AWS_IAM and only this distribution can invoke it. Type matters: an `s3` OAC on a Lambda origin
# is rejected by the API.
# ---------------------------------------------------------------------------
log_step "Lambda origin access control '$LAMBDA_OAC_NAME'"
OAC_LAMBDA_ID="${OAC_LAMBDA_ID:-}"
if [ -z "$OAC_LAMBDA_ID" ]; then
  OAC_LAMBDA_ID="$(aws cloudfront list-origin-access-controls \
      --query "OriginAccessControlList.Items[?Name=='$LAMBDA_OAC_NAME'].Id | [0]" \
      --output text --no-cli-pager 2>/dev/null | head -n 1)"
fi
case "$OAC_LAMBDA_ID" in ""|None) OAC_LAMBDA_ID="" ;; esac
if [ -z "$OAC_LAMBDA_ID" ]; then
  OAC_LAMBDA_JSON="$TMP_DIR/oac-lambda.json"
  mkdir -p "$TMP_DIR"
  cat > "$OAC_LAMBDA_JSON" <<JSON
{
  "Name": "${LAMBDA_OAC_NAME}",
  "Description": "LoadLens Function URL signer (managed by infra/30-cloudfront.sh)",
  "SigningProtocol": "sigv4",
  "SigningBehavior": "always",
  "OriginAccessControlOriginType": "lambda"
}
JSON
  OAC_LAMBDA_ID="$(aws cloudfront create-origin-access-control \
      --origin-access-control-config "$(awsfile "$OAC_LAMBDA_JSON")" \
      --query OriginAccessControl.Id --output text --no-cli-pager)"
  log_ok "created lambda OAC: $OAC_LAMBDA_ID"
else
  log_ok "existing lambda OAC: $OAC_LAMBDA_ID"
fi
save_state OAC_LAMBDA_ID "$OAC_LAMBDA_ID"

# ---------------------------------------------------------------------------
# Security headers (audit M3). CloudFront sets them at the edge, so no page markup changes. No CSP yet:
# the app uses inline handlers and a wasm worker, so a Content-Security-Policy needs its own tested pass
# before it can be enforced (a wrong one silently breaks the calculator).
# ---------------------------------------------------------------------------
log_step "Response headers policy '$RHP_NAME'"
RHP_ID="${RHP_ID:-}"
if [ -z "$RHP_ID" ]; then
  RHP_ID="$(aws cloudfront list-response-headers-policies \
      --query "ResponseHeadersPolicyList.Items[?ResponseHeadersPolicy.Name=='$RHP_NAME'].ResponseHeadersPolicy.Id | [0]" \
      --output text --no-cli-pager 2>/dev/null | head -n 1)"
fi
case "$RHP_ID" in ""|None) RHP_ID="" ;; esac
if [ -z "$RHP_ID" ]; then
  RHP_JSON="$TMP_DIR/rhp.json"
  mkdir -p "$TMP_DIR"
  cat > "$RHP_JSON" <<JSON
{
  "Name": "${RHP_NAME}",
  "Comment": "LoadLens baseline security headers (audit M3)",
  "SecurityHeadersConfig": {
    "XSSProtection": { "Override": true, "Protection": true, "ModeBlock": true },
    "FrameOptions": { "Override": true, "FrameOption": "DENY" },
    "ReferrerPolicy": { "Override": true, "ReferrerPolicy": "strict-origin-when-cross-origin" },
    "ContentTypeOptions": { "Override": true },
    "StrictTransportSecurity": { "Override": true, "IncludeSubdomains": true, "Preload": true, "AccessControlMaxAgeSec": 31536000 }
  },
  "CustomHeadersConfig": {
    "Quantity": 1,
    "Items": [
      { "Header": "Permissions-Policy", "Value": "geolocation=(), microphone=(), camera=(), payment=()", "Override": true }
    ]
  }
}
JSON
  RHP_ID="$(aws cloudfront create-response-headers-policy \
      --response-headers-policy-config "$(awsfile "$RHP_JSON")" \
      --query ResponseHeadersPolicy.Id --output text --no-cli-pager)"
  log_ok "created response headers policy: $RHP_ID"
else
  log_ok "existing response headers policy: $RHP_ID"
fi
save_state RHP_ID "$RHP_ID"

# The origin gate (audit H1). The Function URL must stay public (a CloudFront OAC cannot carry a POST
# body to a Lambda URL), so CloudFront proves where a request came from by adding a shared-secret header
# on the origin request. lambda/index.mjs refuses anything that arrives without it, which is every call
# to the raw *.lambda-url host. The value lives in infra/.state and in the function's environment only.
ORIGIN_SECRET="${ORIGIN_SECRET:-}"
if [ -n "$ORIGIN_SECRET" ]; then
  # The CloudFront API names these HeaderName / HeaderValue (NOT Header/Value/Override — the CLI
  # rejects those with a ParamValidation error, and a muted error here silently leaves the origin
  # headerless, which looks exactly like "the gate is broken").
  ORIGIN_HEADERS_JSON="{ \"Quantity\": 1, \"Items\": [ { \"HeaderName\": \"x-origin-auth\", \"HeaderValue\": \"${ORIGIN_SECRET}\" } ] }"
  log_ok "origin gate header attached to the API origin"
else
  ORIGIN_HEADERS_JSON='{ "Quantity": 0 }'
  log_warn "no ORIGIN_SECRET in state — the API origin carries NO gate (run infra/40-lambda.sh first)"
fi

# ---------------------------------------------------------------------------
# 2. create or update: pick the id FIRST so the config can be built correctly
# ---------------------------------------------------------------------------
DIST_ID="${DISTRIBUTION_ID:-}"
if [ -n "$DIST_ID" ] && ! aws cloudfront get-distribution --id "$DIST_ID" --no-cli-pager >/dev/null 2>&1; then
  log_warn "the remembered distribution $DIST_ID no longer exists — looking for one by comment"
  DIST_ID=""
fi
[ -z "$DIST_ID" ] && DIST_ID="$(resolve_distribution_id)"

CFG_FILE="$TMP_DIR/cloudfront-config.json"
mkdir -p "$TMP_DIR"

CALLER_REFERENCE="loadlens-${ACCOUNT_ID}-$(date -u +%Y%m%d%H%M%S)"
if [ -n "$DIST_ID" ]; then
  # CloudFront requires the ORIGINAL CallerReference back on every update.
  CALLER_REFERENCE="$(aws cloudfront get-distribution-config --id "$DIST_ID" \
      --query 'DistributionConfig.CallerReference' --output text --no-cli-pager)"
fi

cat > "$CFG_FILE" <<JSON
{
  "CallerReference": "${CALLER_REFERENCE}",
  "Comment": "${DIST_COMMENT}",
  "Enabled": true,
  "DefaultRootObject": "index.html",
  "PriceClass": "PriceClass_All",
  "HttpVersion": "http2and3",
  "IsIPV6Enabled": true,
  "Aliases": { "Quantity": 0 },
  "ViewerCertificate": { "CloudFrontDefaultCertificate": true },
  "Restrictions": { "GeoRestriction": { "RestrictionType": "none", "Quantity": 0 } },
  "Origins": {
    "Quantity": 2,
    "Items": [
      {
        "Id": "s3-loadlens-site",
        "DomainName": "${BUCKET}.s3.${AWS_REGION}.amazonaws.com",
        "OriginPath": "",
        "CustomHeaders": { "Quantity": 0 },
        "S3OriginConfig": { "OriginAccessIdentity": "" },
        "OriginAccessControlId": "${OAC_ID}",
        "ConnectionAttempts": 3,
        "ConnectionTimeout": 10
      },
      {
        "Id": "lambda-loadlens-api",
        "DomainName": "${LAMBDA_HOST_ORIGIN}",
        "OriginPath": "",
        "CustomHeaders": ${ORIGIN_HEADERS_JSON},
        "CustomOriginConfig": {
          "HTTPPort": 80,
          "HTTPSPort": 443,
          "OriginProtocolPolicy": "https-only",
          "OriginSslProtocols": { "Quantity": 1, "Items": ["TLSv1.2"] },
          "OriginReadTimeout": ${LAMBDA_TIMEOUT_S},
          "OriginKeepaliveTimeout": 5,
          "IpAddressType": "ipv4"
        },
        "ConnectionAttempts": 3,
        "ConnectionTimeout": 10
      }
    ]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "s3-loadlens-site",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {
      "Quantity": 3,
      "Items": ["GET", "HEAD", "OPTIONS"],
      "CachedMethods": { "Quantity": 3, "Items": ["GET", "HEAD", "OPTIONS"] }
    },
    "Compress": true,
    "SmoothStreaming": false,
    "FieldLevelEncryptionId": "",
    "CachePolicyId": "${CF_POLICY_CACHING_OPTIMIZED}",
    "ResponseHeadersPolicyId": "${RHP_ID}",
    "TrustedSigners": { "Enabled": false, "Quantity": 0 },
    "LambdaFunctionAssociations": { "Quantity": 0 },
    "FunctionAssociations": { "Quantity": 0 }
  },
  "CacheBehaviors": {
    "Quantity": 1,
    "Items": [
      {
        "PathPattern": "/api/*",
        "TargetOriginId": "lambda-loadlens-api",
        "ViewerProtocolPolicy": "https-only",
        "AllowedMethods": {
          "Quantity": 7,
          "Items": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
          "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] }
        },
        "Compress": false,
        "SmoothStreaming": false,
        "FieldLevelEncryptionId": "",
        "CachePolicyId": "${CF_POLICY_CACHING_DISABLED}",
        "OriginRequestPolicyId": "${CF_POLICY_ALL_VIEWER_EXCEPT_HOST}",
        "TrustedSigners": { "Enabled": false, "Quantity": 0 },
        "LambdaFunctionAssociations": { "Quantity": 0 },
        "FunctionAssociations": { "Quantity": 0 }
      }
    ]
  },
  "CustomErrorResponses": {
    "Quantity": 2,
    "Items": [
      {
        "ErrorCode": 403,
        "ResponsePagePath": "/index.html",
        "ResponseCode": "200",
        "ErrorCachingMinTTL": 10
      },
      {
        "ErrorCode": 404,
        "ResponsePagePath": "/index.html",
        "ResponseCode": "200",
        "ErrorCachingMinTTL": 10
      }
    ]
  }
}
JSON

log_step "Validating the generated config JSON"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log("     config parses as JSON")' "$(nativepath "$CFG_FILE")" \
  || die "the generated CloudFront config is not valid JSON — this is a bug in infra/30-cloudfront.sh"

# ---------------------------------------------------------------------------
# 2b. /mcp must reach the Lambda origin too (the remote MCP server)
# ---------------------------------------------------------------------------
# The behaviours above only route /api/* to the API. The MCP server answers at POST /mcp — a top-level
# path, so without its own behaviour CloudFront serves it from S3 and the SPA fallback (403/404 ->
# /index.html, status 200) hands an agent an HTML page that looks like a valid 200 response. Cloned
# from the /api/* behaviour rather than written out again, so the two can never drift: same origin,
# same CachingDisabled policy, same AllViewer origin-request policy, POST allowed.
CFG_FILE="$(node - "$(nativepath "$CFG_FILE")" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
const items = (cfg.CacheBehaviors && cfg.CacheBehaviors.Items) || [];
const api = items.find((b) => b.PathPattern === "/api/*");
if (!api) { console.error("no /api/* behaviour to clone"); process.exit(1); }
if (!items.some((b) => b.PathPattern === "/mcp")) {
  const mcp = JSON.parse(JSON.stringify(api));
  mcp.PathPattern = "/mcp";
  items.unshift(mcp);
  cfg.CacheBehaviors.Items = items;
  cfg.CacheBehaviors.Quantity = items.length;
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}
console.log(file);
NODE
)" || die "/mcp behaviour could not be added to the distribution config"
log_ok "mcp behaviour present: $(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(c.CacheBehaviors.Items.map(b=>b.PathPattern).join(" "))' "$(nativepath "$CFG_FILE")")"


# ---------------------------------------------------------------------------
# 3. hand it to CloudFront
# ---------------------------------------------------------------------------
if [ -n "$DIST_ID" ]; then
  log_step "Updating the existing distribution $DIST_ID"
  ETAG="$(aws cloudfront get-distribution-config --id "$DIST_ID" --query ETag --output text --no-cli-pager)"
  read -r _ID DIST_DOMAIN <<< "$(aws cloudfront update-distribution --id "$DIST_ID" --if-match "$ETAG" \
      --distribution-config "$(awsfile "$CFG_FILE")" \
      --query 'Distribution.[Id,DomainName]' --output text --no-cli-pager)"
  log_ok "update accepted"
else
  log_step "Creating the distribution"
  read -r DIST_ID DIST_DOMAIN <<< "$(aws cloudfront create-distribution \
      --distribution-config "$(awsfile "$CFG_FILE")" \
      --query 'Distribution.[Id,DomainName]' --output text --no-cli-pager)"
  log_ok "created distribution $DIST_ID"
fi
[ -n "$DIST_ID" ] || die "no distribution id returned"
save_state DISTRIBUTION_ID "$DIST_ID" CALLER_REFERENCE "$CALLER_REFERENCE"

# ---------------------------------------------------------------------------
# 4. the bucket policy: this distribution, and nobody else
# ---------------------------------------------------------------------------
log_step "Bucket policy for s3://$BUCKET (CloudFront OAC only)"
DIST_ARN="arn:aws:cloudfront::${ACCOUNT_ID}:distribution/${DIST_ID}"
POLICY_FILE="$TMP_DIR/bucket-policy.json"
cat > "$POLICY_FILE" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontOACReadOnly",
      "Effect": "Allow",
      "Principal": { "Service": "cloudfront.amazonaws.com" },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::${BUCKET}/*",
      "Condition": {
        "StringEquals": { "AWS:SourceArn": "${DIST_ARN}" }
      }
    }
  ]
}
JSON
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$(awsfile "$POLICY_FILE")" --no-cli-pager
log_ok "only $DIST_ARN may read the bucket (read-only, no list, no write)"

# ---------------------------------------------------------------------------
# 5. wait for the edge network to finish deploying
# ---------------------------------------------------------------------------
DIST_DOMAIN="${DIST_DOMAIN:-}"
if [ -z "$DIST_DOMAIN" ]; then
  DIST_DOMAIN="$(aws cloudfront get-distribution --id "$DIST_ID" \
      --query 'Distribution.DomainName' --output text --no-cli-pager)"
fi
save_state DISTRIBUTION_DOMAIN "$DIST_DOMAIN"

if [ "$CF_WAIT_SECONDS" -gt 0 ]; then
  log_step "Waiting up to ${CF_WAIT_SECONDS}s for status Deployed (first deploy is usually 3-8 min)"
  WAITED=0
  STATUS=""
  while : ; do
    STATUS="$(aws cloudfront get-distribution --id "$DIST_ID" --query 'Distribution.Status' --output text --no-cli-pager)"
    if [ "$STATUS" = "Deployed" ]; then log_ok "Deployed"; break; fi
    if [ "$WAITED" -ge "$CF_WAIT_SECONDS" ]; then
      log_warn "still '$STATUS' after ${WAITED}s — normal on a first deploy."
      log_info "Check later with:  aws cloudfront get-distribution --id $DIST_ID --query 'Distribution.Status'"
      break
    fi
    sleep 15
    WAITED=$((WAITED + 15))
  done
else
  log_info "not waiting (CF_WAIT_SECONDS=0)"
fi

# ---------------------------------------------------------------------------
log_title "Done"
log_ok "site        : https://$DIST_DOMAIN/"
log_ok "api         : https://$DIST_DOMAIN/api/health"
log_info "html paths  : cached with the CachingOptimized policy"
log_info "api paths   : caching disabled, all headers + body forwarded to Lambda"
log_info "certificate : CloudFront default (*.cloudfront.net) — no ACM, no Route 53"
log_info ""
log_info "Honest side effects of the 403/404 -> /index.html mapping:"
log_info "  * a mistyped /api/... path shows the app page instead of JSON"
log_info "  * a mistyped static asset also shows the app page"
log_info "  Use the raw Function URL to see real API errors while debugging."
log_info ""
log_info "Verify it yourself (nothing in this toolkit has been run against AWS):"
log_info "    curl -sS https://$DIST_DOMAIN/api/health"
log_info "    curl -sSI https://$DIST_DOMAIN/"
log_info ""
log_info "Next: bash infra/50-deploy-site.sh      # upload the files"
log_info "Then: bash infra/oidc-github-role.sh    # let GitHub Actions deploy"
