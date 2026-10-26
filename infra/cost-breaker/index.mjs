/* loadlens-cost-breaker — the hard ceiling.
 *
 * Runs every 6 hours. Reads the month-to-date spend from the LoadLens budget (budgets:DescribeBudget
 * is a FREE API — Cost Explorer would have cost $0.01 per call, i.e. the guardrail would have been one
 * of the bills it guards against). Past the limit it takes the site down deliberately rather than
 * waiting for a human:
 *
 *   CloudFront distribution  -> Enabled: false   (the site stops serving; nothing is deleted)
 *   loadlens-api concurrency -> 0                (the API stops accepting work)
 *   SNS + email                                  (so you know it happened and why)
 *
 * Nothing is destroyed. Both switches are one command away from being turned back on, and the response
 * says exactly which commands those are. A guardrail that quietly deletes the site would be worse than
 * the bill.
 *
 * dryRun:true reports what it WOULD do and changes nothing — the only safe way to test a thing whose
 * job is to switch off a live site.
 */
import { CloudFrontClient, GetDistributionConfigCommand, UpdateDistributionCommand } from "@aws-sdk/client-cloudfront";
import { LambdaClient, PutFunctionConcurrencyCommand, DeleteFunctionConcurrencyCommand } from "@aws-sdk/client-lambda";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { BudgetsClient, DescribeBudgetCommand } from "@aws-sdk/client-budgets";

const LIMIT = Number(process.env.LIMIT_USD || 10);
const WARN_AT = Number(process.env.WARN_PCT || 80);
const BUDGET_NAME = process.env.BUDGET_NAME || "LoadLens hard ceiling (10 USD)";
const TOPIC_ARN = process.env.TOPIC_ARN;
const DIST_ID = process.env.DISTRIBUTION_ID || "EJNXG9UBKL2OD";
const API_FN = process.env.API_FUNCTION || "loadlens-api";
const REGION = process.env.REGION || "ap-south-1";

const accountOf = (arn) => String(arn || "").split(":")[4] || "";

async function publish(subject, message) {
  if (!TOPIC_ARN) return;
  try {
    await new SNSClient({ region: REGION }).send(new PublishCommand({ TopicArn: TOPIC_ARN, Subject: subject.slice(0, 99), Message: message }));
  } catch (e) {
    console.error("SNS publish failed:", e && e.message);
  }
}

export const handler = async (event = {}, context = {}) => {
  const dryRun = !!(event && event.dryRun);
  const account = process.env.ACCOUNT_ID || accountOf(context.invokedFunctionArn);
  const out = { dryRun, limit: LIMIT, budget: BUDGET_NAME, actions: [], spend: null, pct: null };

  // ---- 1. what have we spent? the budget API, not Cost Explorer: it is free ---------------------
  if (!account) throw new Error("no account id available (context.invokedFunctionArn was empty)");
  const b = await new BudgetsClient({ region: "us-east-1" }).send(
    new DescribeBudgetCommand({ AccountId: account, BudgetName: BUDGET_NAME }));
  const spend = Number(b?.Budget?.CalculatedSpend?.ActualSpend?.Amount ?? NaN);
  if (!Number.isFinite(spend)) throw new Error(`could not read ActualSpend from budget "${BUDGET_NAME}"`);
  const pct = (spend / LIMIT) * 100;
  out.spend = spend;
  out.pct = Number(pct.toFixed(2));
  out.forecast = Number(b?.Budget?.CalculatedSpend?.ForecastedSpend?.Amount ?? NaN) || null;
  console.log(`month-to-date $${spend.toFixed(4)} of $${LIMIT} (${pct.toFixed(1)}%)`);

  if (spend < LIMIT) {
    if (pct >= WARN_AT) {
      out.actions.push("warned");
      if (!dryRun) await publish("LoadLens AWS spend passed " + WARN_AT + "%",
        `Month-to-date spend is $${spend.toFixed(2)} of the $${LIMIT} ceiling (${pct.toFixed(1)}%).\n` +
        `At $${LIMIT} the breaker switches the site off automatically.\nNothing to do yet.`);
    } else {
      out.actions.push("nothing-to-do");
    }
    return out;
  }

  // ---- 2. past the ceiling: take the site down on purpose --------------------------------------
  out.actions.push("TRIPPED");
  const cf = new CloudFrontClient({ region: "us-east-1" });
  const lambda = new LambdaClient({ region: REGION });

  if (dryRun) {
    out.actions.push("would-disable-cloudfront", "would-zero-api-concurrency", "would-notify");
    return out;
  }

  try {
    const cfg = await cf.send(new GetDistributionConfigCommand({ Id: DIST_ID }));
    if (cfg?.DistributionConfig?.Enabled !== false) {
      const next = { ...cfg.DistributionConfig, Enabled: false };
      await cf.send(new UpdateDistributionCommand({ Id: DIST_ID, DistributionConfig: next, IfMatch: cfg.ETag }));
      out.actions.push("cloudfront-disabled");
    } else {
      out.actions.push("cloudfront-already-disabled");
    }
  } catch (e) {
    out.actions.push("cloudfront-failed: " + (e && e.message));
  }

  try {
    await lambda.send(new PutFunctionConcurrencyCommand({ FunctionName: API_FN, ReservedConcurrentExecutions: 0 }));
    out.actions.push("api-concurrency-0");
  } catch (e) {
    out.actions.push("lambda-failed: " + (e && e.message));
  }

  await publish("LoadLens AWS ceiling reached - the site has been switched OFF",
    `Month-to-date spend reached $${spend.toFixed(2)}, the $${LIMIT} ceiling. The breaker has:\n` +
    `  - disabled CloudFront distribution ${DIST_ID} (nothing is deleted)\n` +
    `  - set reserved concurrency on ${API_FN} to 0\n\n` +
    `To bring it back after checking the bill:\n` +
    `  aws lambda delete-function-concurrency --function-name ${API_FN} --region ${REGION}\n` +
    `  aws cloudfront get-distribution-config --id ${DIST_ID} > cfg.json   # set Enabled true, keep the ETag\n` +
    `  aws cloudfront update-distribution --id ${DIST_ID} --distribution-config file://cfg.json --if-match <ETag>\n\n` +
    `Spend data lags reality by hours, so check the bill before re-enabling.`);

  console.log("broken:", JSON.stringify(out));
  return out;
};
