/* loadlens-alert-push — turns an AWS alert into something that actually rings a phone.
 *
 * Subscribed to the loadlens-cost-alerts SNS topic, which is where both alert paths converge:
 *   - the LoadLens budget (80% / 100% actual spend)
 *   - the cost breaker (about to warn, or after it has switched the site off)
 * It forwards whatever arrives to ntfy, which delivers a push notification to the phone.
 *
 * Why ntfy: it needs no account, no API key, no monthly fee, and no phone number, so nothing here can
 * fail because a credential expired. It is a public-relay model - the topic name IS the secret, which
 * is why it is a long random string held only in this function's environment, never in the repository.
 *
 * Why not SMS: AWS SNS SMS to Indian numbers needs TRAI/DLT sender registration, and it bills per
 * message. Why not email alone: the user asked for a phone that rings, because email gets missed.
 */
const SERVER = process.env.NTFY_SERVER || "https://ntfy.sh";
const TOPIC = process.env.NTFY_TOPIC;

export const handler = async (event = {}) => {
  if (!TOPIC) throw new Error("NTFY_TOPIC is not set - the alert would have gone nowhere");
  const rec = event?.Records?.[0]?.Sns || {};
  const subject = rec.Subject || "LoadLens AWS alert";
  const message = rec.Message || JSON.stringify(event);

  // a trip is the only case worth waking someone up for; warnings should not train him to ignore it
  const tripped = /switched OFF|ceiling reached/i.test(`${subject} ${message}`);
  const body = {
    topic: TOPIC,
    title: subject.slice(0, 120),
    message: String(message).slice(0, 1400),
    priority: tripped ? 5 : 4,          // 5 = max: rings and bypasses silent/DND on Android
    tags: tripped ? ["rotating_light", "moneybag"] : ["warning"],
  };

  const res = await fetch(SERVER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`ntfy ${res.status} priority=${body.priority} tripped=${tripped} :: ${text.slice(0, 200)}`);
  if (!res.ok) throw new Error(`ntfy rejected the push: ${res.status} ${text.slice(0, 200)}`);
  return { status: res.status, priority: body.priority, tripped };
};
