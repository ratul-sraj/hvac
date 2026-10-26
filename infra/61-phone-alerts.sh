#!/usr/bin/env bash
# infra/61-phone-alerts.sh — make the AWS bill alert ring a phone.
#
# Hangs a notifier on the loadlens-cost-alerts SNS topic. Both alert paths already publish there
# (the budget at 80/100% of the $10 ceiling, and the cost breaker when it warns or trips), so one
# notifier covers everything without touching either of them.
#
# The ntfy topic name is generated here and stored ONLY in the Lambda's environment: it is the secret
# that keeps the alert channel private, so it must not land in the repository. Re-running this script
# reuses the existing topic rather than silently switching you to a new one.
set -euo pipefail

ACCOUNT="395298786586"
REGION="ap-south-1"
TOPIC_ARN="arn:aws:sns:${REGION}:${ACCOUNT}:loadlens-cost-alerts"
FN="loadlens-alert-push"
ROLE="loadlens-alert-push"
WORK="$(cd "$(dirname "$0")/.." && pwd)"
WORK_NATIVE="$(cd "$WORK" && pwd -W 2>/dev/null || echo "$WORK")"   # native tools cannot read /d/...
SRC="$WORK_NATIVE/infra/cost-breaker"

log() { printf '  %s\n' "$*"; }
die() { printf '! %s\n' "$*" >&2; exit 1; }

# ---- the topic name: reuse it if the function already has one, otherwise mint a new secret -------
NTFY_TOPIC="$(aws lambda get-function-configuration --function-name "$FN" --region "$REGION" \
  --query 'Environment.Variables.NTFY_TOPIC' --output text 2>/dev/null || true)"
if [ -z "$NTFY_TOPIC" ] || [ "$NTFY_TOPIC" = "None" ]; then
  NTFY_TOPIC="loadlens-bill-$(python -c "import secrets;print(secrets.token_hex(10))")"
  log "minted a new ntfy topic (stored only in the Lambda environment)"
else
  log "reusing the existing ntfy topic"
fi

# ---- package notify.mjs as index.mjs so the handler name is the boring one ----------------------
rm -f "$SRC/notify.zip"
python -c "
import zipfile, os
z = zipfile.ZipFile(os.path.join(r'$SRC', 'notify.zip'), 'w', zipfile.ZIP_DEFLATED)
z.write(os.path.join(r'$SRC', 'notify.mjs'), 'index.mjs'); z.close()
print('  packaged %d bytes' % os.path.getsize(os.path.join(r'$SRC', 'notify.zip')))
" || die "could not build the notifier archive"

# ---- role, function, and the SNS subscription ---------------------------------------------------
ROLE_ARN=$(aws iam get-role --role-name "$ROLE" --query 'Role.Arn' --output text 2>/dev/null || true)
if [ -z "$ROLE_ARN" ] || [ "$ROLE_ARN" = "None" ]; then
  ROLE_ARN=$(aws iam create-role --role-name "$ROLE" --assume-role-policy-document '{
    "Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    --query 'Role.Arn' --output text)
  aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  log "role created: $ROLE"
  sleep 12
else
  log "role exists"
fi

if aws lambda get-function --function-name "$FN" --region "$REGION" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FN" --zip-file "fileb://$SRC/notify.zip" --region "$REGION" >/dev/null
  aws lambda update-function-configuration --function-name "$FN" --region "$REGION" \
    --environment "Variables={NTFY_TOPIC=$NTFY_TOPIC,NTFY_SERVER=https://ntfy.sh}" >/dev/null
  log "notifier updated"
else
  aws lambda create-function --function-name "$FN" --runtime nodejs22.x --handler index.handler \
    --role "$ROLE_ARN" --zip-file "fileb://$SRC/notify.zip" --timeout 30 --memory-size 128 --region "$REGION" \
    --environment "Variables={NTFY_TOPIC=$NTFY_TOPIC,NTFY_SERVER=https://ntfy.sh}" >/dev/null
  log "notifier created"
fi

# SNS must be allowed to invoke it, and must actually know to
aws lambda add-permission --function-name "$FN" --statement-id "sns-cost-alerts" --action lambda:InvokeFunction \
  --principal sns.amazonaws.com --source-arn "$TOPIC_ARN" --region "$REGION" >/dev/null 2>&1 || true
SUB_ARN=$(aws sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" --region "$REGION" \
  --query "Subscriptions[?contains(Endpoint,'$FN')].SubscriptionArn" --output text 2>/dev/null || true)
if [ -z "$SUB_ARN" ] || [ "$SUB_ARN" = "None" ]; then
  aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol lambda --notification-endpoint "arn:aws:lambda:${REGION}:${ACCOUNT}:function:${FN}" --region "$REGION" >/dev/null
  log "subscribed the notifier to the alerts topic"
else
  log "notifier already subscribed"
fi

log ""
log "YOUR PHONE:  install the free ntfy app, then subscribe to this topic --------------"
log "    topic:  $NTFY_TOPIC"
log "    link:   https://ntfy.sh/$NTFY_TOPIC"
log "  (Android/iOS app, or just watch that URL. The topic name is the secret - it is not in git.)"
log ""
log "testing it now - your phone should buzz in a few seconds"
aws sns publish --topic-arn "$TOPIC_ARN" --subject "LoadLens test alert" \
  --message "If you can read this on your phone, the 10 dollar alert path works. Nothing is wrong - this is the test." \
  --region "$REGION" >/dev/null
sleep 8
if ! aws logs filter-log-events --log-group-name "/aws/lambda/$FN" --region "$REGION" \
     --start-time $(( ($(date +%s) - 300) * 1000 )) --query 'events[].message' --output text 2>/dev/null | tail -3; then
  log "(no logs yet - give it a few seconds and check the function in the console)"
fi
log "done"
