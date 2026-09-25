#!/usr/bin/env bash
# infra/10-budget-alarm.sh — the money guard. RUN THIS FIRST.
#
#   bash infra/10-budget-alarm.sh you@example.com
#   # or: BUDGET_EMAIL=you@example.com bash infra/10-budget-alarm.sh
#
# Creates one MONTHLY COST budget of USD 1 (override with BUDGET_LIMIT_USD) with
# an email alert at 80% (and optionally at 100%). The first two budgets in an
# account are free; email subscribers to a budget are free.
#
# Idempotent: re-running updates the budget and re-uses existing notifications.
# A budget never stops your resources — it only emails you. Nothing here can
# make the bill larger.
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib-state.sh"
load_state

# ---------------------------------------------------------------------------
# who gets the alert
# ---------------------------------------------------------------------------
BUDGET_EMAIL="${BUDGET_EMAIL:-${1:-}}"
BUDGET_ALERT_AT_100="${BUDGET_ALERT_AT_100:-1}"

log_title "Budget guard — USD ${BUDGET_LIMIT_USD}/month"

if [ -z "$BUDGET_EMAIL" ]; then
  log_err "no email address given."
  log_info "Usage: bash infra/10-budget-alarm.sh you@example.com"
  log_info "   or: BUDGET_EMAIL=you@example.com bash infra/10-budget-alarm.sh"
  exit 1
fi
case "$BUDGET_EMAIL" in
  *@*.*) : ;;
  *) die "'$BUDGET_EMAIL' does not look like an email address" ;;
esac

require_aws_cli
assert_credentials
ACCOUNT_ID="$(resolve_account_id)"
save_state ACCOUNT_ID "$ACCOUNT_ID"
print_context

# AWS Budgets is a global service fronted by the us-east-1 endpoint. The CLI can
# be told explicitly so that a non-us-east-1 default region never breaks it.
BUDGETS_REGION="${BUDGETS_REGION:-us-east-1}"

mkdir -p "$TMP_DIR"
BUDGET_JSON="$TMP_DIR/budget.json"
cat > "$BUDGET_JSON" <<JSON
{
  "AccountId": "${ACCOUNT_ID}",
  "Budget": {
    "BudgetName": "${BUDGET_NAME}",
    "BudgetLimit": { "Amount": "${BUDGET_LIMIT_USD}", "Unit": "USD" },
    "TimeUnit": "MONTHLY",
    "BudgetType": "COST"
  }
}
JSON

NOTIF_JSON="$TMP_DIR/budget-notifications.json"
cat > "$NOTIF_JSON" <<JSON
[
  {
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 80,
      "ThresholdType": "PERCENTAGE"
    },
    "Subscribers": [ { "SubscriptionType": "EMAIL", "Address": "${BUDGET_EMAIL}" } ]
  },
  {
    "Notification": {
      "NotificationType": "FORECASTED",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 100,
      "ThresholdType": "PERCENTAGE"
    },
    "Subscribers": [ { "SubscriptionType": "EMAIL", "Address": "${BUDGET_EMAIL}" } ]
  }
]
JSON

# ---------------------------------------------------------------------------
# create or update
# ---------------------------------------------------------------------------
log_step "Checking for an existing budget named '${BUDGET_NAME}'"
if aws budgets describe-budget --account-id "$ACCOUNT_ID" --budget-name "$BUDGET_NAME" \
      --region "$BUDGETS_REGION" --no-cli-pager >/dev/null 2>&1; then
  log_ok "found — updating it"

  UPD_JSON="$TMP_DIR/budget-update.json"
  cat > "$UPD_JSON" <<JSON
{
  "BudgetName": "${BUDGET_NAME}",
  "BudgetLimit": { "Amount": "${BUDGET_LIMIT_USD}", "Unit": "USD" },
  "TimeUnit": "MONTHLY",
  "BudgetType": "COST"
}
JSON
  aws budgets update-budget --account-id "$ACCOUNT_ID" --new-budget "$(awsfile "$UPD_JSON")" \
    --region "$BUDGETS_REGION" --no-cli-pager >/dev/null
  log_ok "budget limit is now USD ${BUDGET_LIMIT_USD}/month"
else
  log_info "not found — creating it"
  aws budgets create-budget --cli-input-json "$(awsfile "$BUDGET_JSON")" \
    --region "$BUDGETS_REGION" --no-cli-pager >/dev/null
  log_ok "budget created"
fi

# ---------------------------------------------------------------------------
# notifications (email alerts)
# ---------------------------------------------------------------------------
# create-notification is not an update: adding the same notification twice
# returns a duplicate error, which is harmless here.
add_notification() { # add_notification <threshold> <type> <operator>
  _n="$TMP_DIR/notif.json"
  cat > "$_n" <<JSON
{
  "NotificationType": "$2",
  "ComparisonOperator": "$3",
  "Threshold": $1,
  "ThresholdType": "PERCENTAGE"
}
JSON
  SUBS_JSON="$(aws budgets describe-subscribers-for-notification \
      --account-id "$ACCOUNT_ID" --budget-name "$BUDGET_NAME" \
      --notification "$(awsfile "$_n")" --region "$BUDGETS_REGION" \
      --query 'Subscribers[].Address' --output text --no-cli-pager 2>/dev/null | tr '\t' '\n' || true)"

  if printf '%s\n' "$SUBS_JSON" | grep -qx "$BUDGET_EMAIL"; then
    log_ok "alert already present: $2 ${1}% -> $BUDGET_EMAIL"
    return 0
  fi

  if _out="$(aws budgets create-notification \
        --account-id "$ACCOUNT_ID" --budget-name "$BUDGET_NAME" \
        --notification "$(awsfile "$_n")" \
        --subscribers "[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$BUDGET_EMAIL\"}]" \
        --region "$BUDGETS_REGION" --no-cli-pager 2>&1)"; then
    log_ok "alert created: $2 ${1}% -> $BUDGET_EMAIL"
  else
    case "$_out" in
      *DuplicateRecord*|*AlreadyExists*) log_ok "alert already present: $2 ${1}% -> $BUDGET_EMAIL" ;;
      *) log_err "$_out"; return 1 ;;
    esac
  fi
}

log_step "Email alerts"
add_notification 80 ACTUAL GREATER_THAN
if [ "$BUDGET_ALERT_AT_100" = "1" ]; then
  add_notification 100 FORECASTED GREATER_THAN
fi

# ---------------------------------------------------------------------------
log_title "Done"
log_ok "USD ${BUDGET_LIMIT_USD}/month budget '${BUDGET_NAME}' with alerts to ${BUDGET_EMAIL}"
log_info "Check it:  aws budgets describe-budget --account-id $ACCOUNT_ID \\"
log_info "             --budget-name $BUDGET_NAME --region $BUDGETS_REGION"
log_info ""
log_info "Note: a budget only WARNS. It does not stop anything."
log_info "Next: bash infra/20-site-bucket.sh"
