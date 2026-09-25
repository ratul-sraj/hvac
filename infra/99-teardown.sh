#!/usr/bin/env bash
# infra/99-teardown.sh — remove everything this toolkit created.
#
#   bash infra/99-teardown.sh                     # interactive, asks before each extra
#   bash infra/99-teardown.sh --yes               # no prompt for the project's own resources
#   bash infra/99-teardown.sh --yes --all         # also remove the OIDC role/provider + budget
#
# Order matters: CloudFront first (it references the bucket and the function),
# then the bucket, then the Lambda and its role, then the optional extras.
#
# A disabled CloudFront distribution is not billed. Disabling, waiting for the
# edge network and deleting can take 10-20 minutes in total — that is normal.
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib-state.sh"
load_state

ASSUME_YES=0
WITH_OIDC_ROLE=0
WITH_OIDC_PROVIDER=0
WITH_BUDGET=0
CF_DELETE_WAIT="${CF_DELETE_WAIT:-900}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes|-y)             ASSUME_YES=1; shift ;;
    --with-oidc-role)     WITH_OIDC_ROLE=1; shift ;;
    --with-oidc-provider) WITH_OIDC_PROVIDER=1; WITH_OIDC_ROLE=1; shift ;;
    --with-budget)        WITH_BUDGET=1; shift ;;
    --all)                WITH_OIDC_ROLE=1; WITH_OIDC_PROVIDER=1; WITH_BUDGET=1; shift ;;
    -h|--help)            sed -n '2,18p' "$0"; exit 0 ;;
    *) die "unknown argument '$1' (try --help)" ;;
  esac
done

log_title "Teardown"

require_aws_cli
assert_credentials
ACCOUNT_ID="$(resolve_account_id)"
BUCKET="$(resolve_site_bucket)"
DIST_ID="$(resolve_distribution_id)"
print_context

if [ "$ASSUME_YES" != "1" ]; then
  log_warn "This DELETES the CloudFront distribution, the S3 site, the Lambda function,"
  log_warn "its IAM role and the local state file. The GitHub Pages site is untouched."
  printf 'Type the bucket name (%s) to continue: ' "$BUCKET"
  read -r TYPED || TYPED=""
  [ "$TYPED" = "$BUCKET" ] || die "not confirmed — nothing was deleted"
fi

# ---------------------------------------------------------------------------
# 1. CloudFront
# ---------------------------------------------------------------------------
if [ -z "$DIST_ID" ]; then
  log_info "no CloudFront distribution found — skipping"
else
  log_step "Disabling distribution $DIST_ID"
  mkdir -p "$TMP_DIR"
  GET_FILE="$TMP_DIR/cf-get.json"
  DIS_FILE="$TMP_DIR/cf-disabled.json"
  aws cloudfront get-distribution-config --id "$DIST_ID" --no-cli-pager > "$GET_FILE"
  node -e '
    const fs=require("fs");
    const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    j.DistributionConfig.Enabled=false;
    fs.writeFileSync(process.argv[2],JSON.stringify(j.DistributionConfig));
  ' "$GET_FILE" "$DIS_FILE"

  ETAG="$(node -e 'const f=require("fs");process.stdout.write(JSON.parse(f.readFileSync(process.argv[1],"utf8")).ETag)' "$GET_FILE")"
  aws cloudfront update-distribution --id "$DIST_ID" --if-match "$ETAG" \
    --distribution-config "$(awsfile "$DIS_FILE")" --no-cli-pager >/dev/null
  log_ok "disable accepted — waiting for the edge network"

  WAITED=0
  while : ; do
    STATUS="$(aws cloudfront get-distribution --id "$DIST_ID" --query 'Distribution.Status' --output text --no-cli-pager)"
    [ "$STATUS" = "Deployed" ] && break
    if [ "$WAITED" -ge "$CF_DELETE_WAIT" ]; then
      log_warn "still '$STATUS' after ${WAITED}s."
      log_info "Re-run this script later; a disabled distribution is not billed."
      log_info "Continuing with the rest of the teardown."
      break
    fi
    sleep 20
    WAITED=$((WAITED + 20))
  done

  if [ "$STATUS" = "Deployed" ]; then
    ETAG2="$(aws cloudfront get-distribution-config --id "$DIST_ID" --query ETag --output text --no-cli-pager)"
    if aws cloudfront delete-distribution --id "$DIST_ID" --if-match "$ETAG2" --no-cli-pager >/dev/null 2>&1; then
      log_ok "distribution deleted"
      DIST_DELETED=1
    else
      log_warn "could not delete the distribution yet — run this script again in a few minutes"
      DIST_DELETED=0
    fi
  else
    log_warn "leaving the distribution disabled but in place"
    DIST_DELETED=0
  fi
fi

# ---------------------------------------------------------------------------
# 2. the OAC (free, but it is ours)
# ---------------------------------------------------------------------------
OAC_ID="${OAC_ID:-}"
if [ -n "$OAC_ID" ]; then
  if aws cloudfront delete-origin-access-control --id "$OAC_ID" --no-cli-pager >/dev/null 2>&1; then
    log_ok "origin access control $OAC_ID deleted"
  else
    log_info "OAC $OAC_ID could not be deleted yet (an origin may still reference it)"
  fi
fi

# ---------------------------------------------------------------------------
# 3. the site bucket
# ---------------------------------------------------------------------------
if aws s3api head-bucket --bucket "$BUCKET" --no-cli-pager >/dev/null 2>&1; then
  if [ -n "${DIST_DELETED:-}" ] && [ "$DIST_DELETED" = "0" ] && [ "$ASSUME_YES" != "1" ]; then
    log_warn "the CloudFront distribution still exists and reads this bucket."
    confirm "Delete the bucket anyway?" || { log_info "bucket kept"; SKIP_BUCKET=1; }
  fi
  if [ "${SKIP_BUCKET:-0}" != "1" ]; then
    log_step "Emptying s3://$BUCKET"
    aws s3 rm "s3://$BUCKET" --recursive --only-show-errors >/dev/null
    log_ok "emptied"
    if aws s3api delete-bucket --bucket "$BUCKET" --no-cli-pager >/dev/null 2>&1; then
      log_ok "bucket deleted"
    else
      log_warn "could not delete the bucket (still not empty?)"
    fi
  fi
else
  log_info "bucket s3://$BUCKET does not exist — skipping"
fi

# ---------------------------------------------------------------------------
# 4. the Lambda function, URL and role
# ---------------------------------------------------------------------------
if aws lambda get-function --function-name "$LAMBDA_FUNCTION" --no-cli-pager >/dev/null 2>&1; then
  log_step "Deleting Lambda function $LAMBDA_FUNCTION"
  aws lambda delete-function-url-config --function-name "$LAMBDA_FUNCTION" --no-cli-pager >/dev/null 2>&1 || true
  aws lambda delete-function --function-name "$LAMBDA_FUNCTION" --no-cli-pager >/dev/null
  log_ok "function deleted (the Function URL goes with it)"
  log_info "its CloudWatch log group /aws/lambda/$LAMBDA_FUNCTION is left behind on purpose"
  log_info "(it is free up to 5 GB, and it is your only record of the invocations)."
  log_info "Delete it with: aws logs delete-log-group --log-group-name /aws/lambda/$LAMBDA_FUNCTION"
else
  log_info "no Lambda function named $LAMBDA_FUNCTION — skipping"
fi

if aws iam get-role --role-name "$LAMBDA_ROLE" --no-cli-pager >/dev/null 2>&1; then
  log_step "Deleting IAM role $LAMBDA_ROLE"
  aws iam detach-role-policy --role-name "$LAMBDA_ROLE" \
    --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" \
    --no-cli-pager >/dev/null 2>&1 || true
  for p in $(aws iam list-role-policies --role-name "$LAMBDA_ROLE" --query 'PolicyNames[]' --output text --no-cli-pager 2>/dev/null); do
    aws iam delete-role-policy --role-name "$LAMBDA_ROLE" --policy-name "$p" --no-cli-pager >/dev/null 2>&1 || true
  done
  for p in $(aws iam list-attached-role-policies --role-name "$LAMBDA_ROLE" --query 'AttachedPolicies[].PolicyArn' --output text --no-cli-pager 2>/dev/null); do
    aws iam detach-role-policy --role-name "$LAMBDA_ROLE" --policy-arn "$p" --no-cli-pager >/dev/null 2>&1 || true
  done
  if aws iam delete-role --role-name "$LAMBDA_ROLE" --no-cli-pager >/dev/null 2>&1; then
    log_ok "role deleted"
  else
    log_warn "could not delete the role — check that no policy is still attached"
  fi
else
  log_info "no IAM role named $LAMBDA_ROLE — skipping"
fi

# ---------------------------------------------------------------------------
# 5. optional: the GitHub Actions role
# ---------------------------------------------------------------------------
if [ "$WITH_OIDC_ROLE" != "1" ] && [ "${OIDC_ROLE_ARN:-}" != "" ]; then
  log_info "the GitHub role $OIDC_ROLE is kept (use --with-oidc-role to remove it)"
fi
if [ "$WITH_OIDC_ROLE" = "1" ]; then
  if aws iam get-role --role-name "$OIDC_ROLE" --no-cli-pager >/dev/null 2>&1; then
    log_step "Deleting GitHub Actions role $OIDC_ROLE"
    aws iam delete-role-policy --role-name "$OIDC_ROLE" --policy-name "loadlens-deploy" --no-cli-pager >/dev/null 2>&1 || true
    aws iam delete-role --role-name "$OIDC_ROLE" --no-cli-pager >/dev/null 2>&1 \
      && log_ok "role deleted" || log_warn "could not delete the role"
    log_warn "remember to remove AWS_DEPLOY_ROLE_ARN from the GitHub repository variables"
  else
    log_info "no GitHub Actions role — skipping"
  fi
fi

# ---------------------------------------------------------------------------
# 6. optional: the OIDC provider (shared by every repo in the account!)
# ---------------------------------------------------------------------------
if [ "$WITH_OIDC_PROVIDER" = "1" ]; then
  P_ARN="${OIDC_PROVIDER_ARN:-arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_PROVIDER_HOST}}"
  log_warn "the OIDC provider is shared: any OTHER repository in this account using"
  log_warn "keyless deploys will stop working if you delete it."
  if aws iam delete-open-id-connect-provider --open-id-connect-provider-arn "$P_ARN" --no-cli-pager >/dev/null 2>&1; then
    log_ok "identity provider deleted"
  else
    log_info "identity provider not found or still in use — skipping"
  fi
fi

# ---------------------------------------------------------------------------
# 7. optional: the budget
# ---------------------------------------------------------------------------
if [ "$WITH_BUDGET" = "1" ]; then
  log_step "Deleting the budget $BUDGET_NAME"
  aws budgets delete-budget --account-id "$ACCOUNT_ID" --budget-name "$BUDGET_NAME" \
    --region "${BUDGETS_REGION:-us-east-1}" --no-cli-pager >/dev/null 2>&1 \
    && log_ok "budget deleted" \
    || log_warn "could not delete the budget (you may want to keep it anyway)"
elif [ "${BUDGET_NAME:-}" != "" ]; then
  log_info "the budget '$BUDGET_NAME' is kept — it is your only warning system."
  log_info "Keep it even after teardown: an idle account can still accrue charges."
fi

# ---------------------------------------------------------------------------
# 8. local state
# ---------------------------------------------------------------------------
if [ -f "$STATE_FILE" ]; then
  if [ "$ASSUME_YES" = "1" ] || confirm "Remove the local state file $STATE_FILE?"; then
    rm -f "$STATE_FILE" "$STATE_FILE".*
    log_ok "state file removed — a fresh infra/ run will start from scratch"
  fi
fi

# ---------------------------------------------------------------------------
log_title "Teardown finished"
log_info "Check what is left:"
log_info "    aws cloudfront list-distributions --query 'DistributionList.Items[].{id:Id,status:Status,enabled:Enabled}'"
log_info "    aws s3 ls | grep loadlens"
log_info "    aws lambda list-functions --query 'Functions[?starts_with(FunctionName,`loadlens`)].FunctionName'"
log_info "Remember: deleting resources does not delete the month's usage. The bill for"
log_info "the current month still settles at the start of next month."
