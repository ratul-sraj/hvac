#!/usr/bin/env bash
# infra/60-cost-breaker.sh — a hard ceiling on the LoadLens AWS bill.
#
# Installs three things:
#   1. a $10/month budget with email alerts, read by the breaker (the DescribeBudget API is FREE,
#      unlike Cost Explorer's $0.01 per call — so the guardrail costs nothing to run);
#   2. a breaker Lambda on a 6-hourly schedule: if month-to-date spend reaches the limit it takes the
#      site down deliberately (CloudFront disabled, API concurrency 0) and says so by email;
#   3. cheap hygiene that stops quiet growth: 14-day log retention, and a reserved-concurrency cap on
#      the API so a hammering cannot spend in parallel.
#
# Honest limitation: AWS cost data is not real-time (it lands a few times a day). This cannot promise
# "never a cent over $10" — it promises the app stops itself shortly after crossing, and that you hear
# about it. The architecture's real protection is that nothing here bills beyond pennies at this size.
set -euo pipefail

ACCOUNT="395298786586"
REGION="ap-south-1"
EMAIL="${LOADLENS_ALERT_EMAIL:-ratul.sraj@gmail.com}"
LIMIT="${LOADLENS_MONTHLY_LIMIT:-10}"
BUDGET_NAME="LoadLens hard ceiling (${LIMIT} USD)"
TOPIC="loadlens-cost-alerts"
DIST="EJNXG9UBKL2OD"
FN="loadlens-api"
BREAKER="loadlens-cost-breaker"
WORK="$(cd "$(dirname "$0")/.." && pwd)"
# aws.exe and python.exe are NATIVE programs: they cannot read an MSYS path like /d/webhvac/...,
# so every path handed to them is converted once, here.
WORK_NATIVE="$(cd "$WORK" && pwd -W 2>/dev/null || echo "$WORK")"

log() { printf '  %s\n' "$*"; }
die() { printf '! %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 1. SNS topic + email subscription
TOPIC_ARN=$(aws sns create-topic --name "$TOPIC" --region "$REGION" --query TopicArn --output text)
log "topic: $TOPIC_ARN"
if ! aws sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" --region "$REGION" \
     --query "Subscriptions[?Endpoint=='$EMAIL'].SubscriptionArn" --output text | grep -q .; then
  aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol email --notification-endpoint "$EMAIL" --region "$REGION" >/dev/null
  log "subscribed $EMAIL - CHECK YOUR INBOX and click the confirmation link, or alerts reach nobody"
else
  log "$EMAIL already subscribed"
fi

# ---------------------------------------------------------------- 2. the budget the breaker reads
aws budgets create-budget --account-id "$ACCOUNT" \
  --budget "{\"BudgetName\":\"$BUDGET_NAME\",\"BudgetLimit\":{\"Amount\":\"$LIMIT\",\"Unit\":\"USD\"},\"TimeUnit\":\"MONTHLY\",\"BudgetType\":\"COST\"}" \
  --notifications-with-subscribers "[
    {\"Notification\":{\"NotificationType\":\"ACTUAL\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":50,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$EMAIL\"}]},
    {\"Notification\":{\"NotificationType\":\"ACTUAL\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":80,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$EMAIL\"},{\"SubscriptionType\":\"SNS\",\"Address\":\"$TOPIC_ARN\"}]},
    {\"Notification\":{\"NotificationType\":\"ACTUAL\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":100,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$EMAIL\"},{\"SubscriptionType\":\"SNS\",\"Address\":\"$TOPIC_ARN\"}]},
    {\"Notification\":{\"NotificationType\":\"FORECASTED\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":100,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$EMAIL\"}]}
  ]" 2>/dev/null || log "budget already exists (fine - notifications left as they were)"
log "budget: $BUDGET_NAME (alerts at 50 / 80 / 100% actual, 100% forecasted)"

# ---------------------------------------------------------------- 3. the breaker, its role and code
BREAKER_SRC="$WORK_NATIVE/infra/cost-breaker/index.mjs"
[ -f "$BREAKER_SRC" ] || die "missing $BREAKER_SRC"
ZIP="$WORK_NATIVE/infra/cost-breaker/breaker.zip"
# no zip CLI on this machine (git-bash does not ship one) - build the archive with Python
rm -f "$ZIP"
python -c "
import zipfile, sys, os
src = os.path.join(r'$WORK_NATIVE', 'infra', 'cost-breaker')
z = zipfile.ZipFile(os.path.join(src, 'breaker.zip'), 'w', zipfile.ZIP_DEFLATED)
z.write(os.path.join(src, 'index.mjs'), 'index.mjs'); z.close()
print('  zip written:', os.path.getsize(os.path.join(src, 'breaker.zip')), 'bytes')
" || die "could not build the deployment archive"

ROLE_ARN=$(aws iam get-role --role-name "$BREAKER" --query 'Role.Arn' --output text 2>/dev/null || true)
if [ -z "$ROLE_ARN" ] || [ "$ROLE_ARN" = "None" ]; then
  ROLE_ARN=$(aws iam create-role --role-name "$BREAKER" --assume-role-policy-document '{
    "Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    --query 'Role.Arn' --output text)
  aws iam attach-role-policy --role-name "$BREAKER" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  aws iam put-role-policy --role-name "$BREAKER" --policy-name "$BREAKER-inline" --policy-document "{
    \"Version\":\"2012-10-17\",\"Statement\":[
      {\"Effect\":\"Allow\",\"Action\":[\"budgets:ViewBudget\",\"budgets:DescribeBudget\"],\"Resource\":\"*\"},
      {\"Effect\":\"Allow\",\"Action\":[\"cloudfront:GetDistribution\",\"cloudfront:GetDistributionConfig\",\"cloudfront:UpdateDistribution\"],\"Resource\":\"arn:aws:cloudfront::${ACCOUNT}:distribution/${DIST}\"},
      {\"Effect\":\"Allow\",\"Action\":[\"lambda:PutFunctionConcurrency\",\"lambda:DeleteFunctionConcurrency\"],\"Resource\":\"arn:aws:lambda:${REGION}:${ACCOUNT}:function:${FN}\"},
      {\"Effect\":\"Allow\",\"Action\":[\"sns:Publish\"],\"Resource\":\"${TOPIC_ARN}\"}
    ]}"
  log "role created: $BREAKER"
  sleep 12   # IAM propagation, or the create-function call fails on an unknown role
else
  log "role exists: $ROLE_ARN"
fi

if aws lambda get-function --function-name "$BREAKER" --region "$REGION" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$BREAKER" --zip-file "fileb://$ZIP" --region "$REGION" >/dev/null
  aws lambda update-function-configuration --function-name "$BREAKER" --region "$REGION" \
    --environment "Variables={LIMIT_USD=$LIMIT,BUDGET_NAME=$BUDGET_NAME,TOPIC_ARN=$TOPIC_ARN,DISTRIBUTION_ID=$DIST,API_FUNCTION=$FN,REGION=$REGION}" >/dev/null
  log "breaker updated"
else
  aws lambda create-function --function-name "$BREAKER" --runtime nodejs22.x --handler index.handler \
    --role "$ROLE_ARN" --zip-file "fileb://$ZIP" --timeout 60 --memory-size 128 --region "$REGION" \
    --environment "Variables={LIMIT_USD=$LIMIT,BUDGET_NAME=$BUDGET_NAME,TOPIC_ARN=$TOPIC_ARN,DISTRIBUTION_ID=$DIST,API_FUNCTION=$FN,REGION=$REGION}" >/dev/null
  log "breaker created"
fi
aws lambda tag-resource --resource "arn:aws:lambda:${REGION}:${ACCOUNT}:function:${BREAKER}" --tags Project=loadlens,Purpose=cost-guardrail >/dev/null 2>&1 || true

# a monthly break-even: the schedule costs nothing and there is no CloudWatch alarm to maintain
RULE="loadlens-cost-check-6h"
aws events put-rule --name "$RULE" --schedule-expression "rate(6 hours)" --state ENABLED --region "$REGION" >/dev/null
aws lambda add-permission --function-name "$BREAKER" --statement-id "events-$RULE" --action lambda:InvokeFunction \
  --principal events.amazonaws.com --source-arn "arn:aws:events:${REGION}:${ACCOUNT}:rule/${RULE}" --region "$REGION" >/dev/null 2>&1 || true
aws events put-targets --rule "$RULE" --targets "Id=1,Arn=arn:aws:lambda:${REGION}:${ACCOUNT}:function:${BREAKER}" --region "$REGION" >/dev/null
log "schedule: rate(6 hours) -> $BREAKER"

# ---------------------------------------------------------------- 4. hygiene that stops quiet growth
aws logs put-retention-policy --log-group-name "/aws/lambda/$FN" --retention-in-days 14 --region "$REGION" && \
  log "log retention: 14 days (was never-expire)"
aws lambda put-function-concurrency --function-name "$FN" --reserved-concurrent-executions 5 --region "$REGION" >/dev/null && \
  log "reserved concurrency on $FN: 5 (account limit is 10) - a hammering cannot spend in parallel"

log "done. Test with: aws lambda invoke --function-name $BREAKER --payload '{\"dryRun\":true}' --cli-binary-format raw-in-base64-out /dev/stdout --region $REGION"
