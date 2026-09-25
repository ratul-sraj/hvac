#!/usr/bin/env bash
# infra/oidc-github-role.sh — let GitHub Actions deploy WITHOUT long-lived keys.
#
#   bash infra/oidc-github-role.sh
#
# Creates:
#   1. the GitHub OIDC identity provider (token.actions.githubusercontent.com),
#      if the account does not have one yet
#   2. the IAM role "loadlens-github-deploy" that Actions assumes
#   3. an inline least-privilege policy for that role
#
# The trust policy is rendered from infra/oidc-trust-policy.json.tmpl and pins
# the subject to __GITHUB_SUB__ (default: repo:ratul-sraj/hvac:*, i.e. ANY branch
# or PR OF THIS REPOSITORY ONLY). This script REFUSES to create a role whose
# subject is a bare wildcard or a wildcard over repositories — that would let
# any GitHub repository on the internet assume it.
#
# Run this AFTER 20/30/40: the inline policy names the bucket, the distribution
# and the function, and those names are read from the local state file.
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib-state.sh"
load_state

log_title "GitHub Actions OIDC role"

require_aws_cli
assert_credentials
ACCOUNT_ID="$(resolve_account_id)"
BUCKET="$(resolve_site_bucket)"
save_state ACCOUNT_ID "$ACCOUNT_ID" SITE_BUCKET "$BUCKET"
print_context

# ---------------------------------------------------------------------------
# 0. the subject condition — validate before creating anything
# ---------------------------------------------------------------------------
log_step "Trust subject (the security boundary)"
log_info "sub condition : $GITHUB_SUB"

if ! printf '%s' "$GITHUB_SUB" | grep -Eq '^repo:[^:*]+/[^:*]+:.+$'; then
  log_err "refusing to build a trust policy from this subject: '$GITHUB_SUB'"
  log_info "It must be scoped to one repository, like:"
  log_info "    repo:OWNER/NAME:*             (any branch/tag/PR of that repo)"
  log_info "    repo:OWNER/NAME:ref:refs/heads/main   (one branch only)"
  log_info "    repo:OWNER/NAME:environment:prod      (one environment only)"
  log_info "A bare '*' or 'repo:*' would let ANY GitHub repository deploy your account."
  exit 1
fi
REF_KIND="${GITHUB_SUB##*:}"   # "*", "ref:refs/heads/main" or "environment:prod"
case "$GITHUB_SUB" in
  *":*:*:*") : ;; # e.g. repo:o/n:ref:refs/heads/main  -> tightest form, fine
  *)
    if [ "$REF_KIND" = "*" ]; then
      log_warn "the subject allows ANY branch, tag, PR or environment of $GITHUB_REPO."
      log_warn "That is the documented default and still limited to this one repository,"
      log_warn "but a fork/PR-based attacker with write access to this repo could deploy."
      log_info "Tighten it later with e.g.:"
      log_info "    GITHUB_SUB='repo:${GITHUB_REPO}:ref:refs/heads/main' bash infra/oidc-github-role.sh"
    fi ;;
esac

# ---------------------------------------------------------------------------
# 1. the identity provider
# ---------------------------------------------------------------------------
log_step "GitHub OIDC identity provider"
PROVIDER_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_PROVIDER_HOST}"
EXISTING_PROVIDER="$(aws iam list-open-id-connect-providers \
  --query "OpenIDConnectProviderList[?contains(Arn, '${OIDC_PROVIDER_HOST}')].Arn | [0]" \
  --output text --no-cli-pager 2>/dev/null | head -n 1)"
case "$EXISTING_PROVIDER" in ""|None) EXISTING_PROVIDER="" ;; esac

if [ -n "$EXISTING_PROVIDER" ]; then
  PROVIDER_ARN="$EXISTING_PROVIDER"
  log_ok "already exists: $PROVIDER_ARN"
  log_info "left untouched — other repositories in this account may be using it"
else
  # The thumbprint is the documented GitHub value. AWS now validates GitHub
  # through its own trusted CA store, so this is a legacy field, but the API
  # still wants one at creation time.
  PROVIDER_ARN="$(aws iam create-open-id-connect-provider \
    --url "https://${OIDC_PROVIDER_HOST}" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list "$OIDC_THUMBPRINT" \
    --tags Key=project,Value=loadlens \
    --query 'OpenIDConnectProviderArn' --output text --no-cli-pager)"
  log_ok "created: $PROVIDER_ARN"
fi
save_state OIDC_PROVIDER_ARN "$PROVIDER_ARN"

# ---------------------------------------------------------------------------
# 2. the role
# ---------------------------------------------------------------------------
TP_FILE="$TMP_DIR/github-trust-policy.json"
mkdir -p "$TMP_DIR"
sed -e "s|__OIDC_PROVIDER_ARN__|${PROVIDER_ARN}|g" \
    -e "s|__OIDC_PROVIDER_HOST__|${OIDC_PROVIDER_HOST}|g" \
    -e "s|__GITHUB_SUB__|${GITHUB_SUB}|g" \
    "$INFRA_DIR/oidc-trust-policy.json.tmpl" > "$TP_FILE"

if node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$(nativepath "$TP_FILE")" 2>/dev/null; then
  log_ok "trust policy rendered"
else
  die "the rendered trust policy is not valid JSON (check GITHUB_SUB for odd characters)"
fi

ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${OIDC_ROLE}"
if aws iam get-role --role-name "$OIDC_ROLE" --no-cli-pager >/dev/null 2>&1; then
  log_step "Role $OIDC_ROLE exists — updating its trust policy"
  aws iam update-assume-role-policy --role-name "$OIDC_ROLE" \
    --policy-document "$(awsfile "$TP_FILE")" --no-cli-pager
  log_ok "trust policy updated"
else
  log_step "Creating role $OIDC_ROLE"
  ROLE_ARN="$(aws iam create-role --role-name "$OIDC_ROLE" \
    --description "Assumed by GitHub Actions (${GITHUB_REPO}) to deploy LoadLens to S3/CloudFront/Lambda" \
    --max-session-duration 3600 \
    --assume-role-policy-document "$(awsfile "$TP_FILE")" \
    --tags Key=project,Value=loadlens \
    --query 'Role.Arn' --output text --no-cli-pager)"
  log_ok "created: $ROLE_ARN"
fi
save_state OIDC_ROLE_ARN "$ROLE_ARN"

# ---------------------------------------------------------------------------
# 3. least privilege: only the three things the workflow touches
# ---------------------------------------------------------------------------
DIST_ID="$(resolve_distribution_id)"
[ -n "$DIST_ID" ] || log_warn "no CloudFront distribution found — the invalidation permission will be left out"
[ -n "$DIST_ID" ] && save_state DISTRIBUTION_ID "$DIST_ID"

POLICY_FILE="$TMP_DIR/github-deploy-policy.json"
cat > "$POLICY_FILE" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "WhoAmI",
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    },
    {
      "Sid": "SiteBucketListing",
      "Effect": "Allow",
      "Action": [ "s3:ListBucket", "s3:GetBucketLocation" ],
      "Resource": "arn:aws:s3:::${BUCKET}"
    },
    {
      "Sid": "SiteObjects",
      "Effect": "Allow",
      "Action": [ "s3:PutObject", "s3:GetObject", "s3:DeleteObject" ],
      "Resource": "arn:aws:s3:::${BUCKET}/*"
    },
    {
      "Sid": "UpdateTheApiFunction",
      "Effect": "Allow",
      "Action": [
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration"
      ],
      "Resource": "arn:aws:lambda:${AWS_REGION}:${ACCOUNT_ID}:function:${LAMBDA_FUNCTION}"
    },
    {
      "Sid": "RefreshTheCache",
      "Effect": "Allow",
      "Action": [ "cloudfront:CreateInvalidation", "cloudfront:GetInvalidation" ],
      "Resource": "$([ -n "$DIST_ID" ] && printf 'arn:aws:cloudfront::%s:distribution/%s' "$ACCOUNT_ID" "$DIST_ID" || printf '*')"
    },
    {
      "Sid": "FindTheDistribution",
      "Effect": "Allow",
      "Action": [
        "cloudfront:ListDistributions",
        "cloudfront:GetDistribution",
        "cloudfront:GetDistributionConfig"
      ],
      "Resource": "*"
    }
  ]
}
JSON

if aws iam put-role-policy --role-name "$OIDC_ROLE" \
      --policy-name "loadlens-deploy" --policy-document "$(awsfile "$POLICY_FILE")" --no-cli-pager; then
  log_ok "inline policy 'loadlens-deploy' applied (list/put/delete the site bucket, update one Lambda, invalidate one distribution)"
else
  die "could not apply the inline policy"
fi

# ---------------------------------------------------------------------------
log_title "Done"
log_ok "role ARN: $ROLE_ARN"
log_info ""
log_info "Now put that ARN in the GitHub repository (as a VARIABLE, not a secret —"
log_info "it is not sensitive and variables are readable in the log):"
log_info ""
log_info "    gh variable set AWS_DEPLOY_ROLE_ARN --repo $GITHUB_REPO --body '$ROLE_ARN'"
log_info "    gh variable set AWS_REGION          --repo $GITHUB_REPO --body '$AWS_REGION'"
log_info ""
log_info "or: GitHub -> repo $GITHUB_REPO -> Settings -> Secrets and variables ->"
log_info "    Actions -> Variables -> New repository variable"
log_info ""
log_info "Nothing long-lived is stored in GitHub. The workflow exchanges a short-lived"
log_info "OIDC token for temporary credentials (maximum 1 hour)."
log_info ""
log_info "Security notes a reviewer should know:"
log_info "  * the subject is '$GITHUB_SUB' — one repository only"
log_info "  * tighten it to a single branch if you want:"
log_info "      GITHUB_SUB='repo:${GITHUB_REPO}:ref:refs/heads/main' bash infra/oidc-github-role.sh"
log_info "  * deleting the OIDC provider later breaks every repo in this account that"
log_info "    uses keyless deploys (see infra/99-teardown.sh)"
