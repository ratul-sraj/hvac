// Server configuration, read once from the environment.
// Everything is overridable so the API test can run on a random port with a
// tiny upload limit (MAX_UPLOAD_MB=1) without touching real settings.

const intFromEnv = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const config = {
  // PORT=0 lets the OS pick a free port (useful for tests / containers).
  port: intFromEnv("PORT", 3000),
  host: process.env.HOST || undefined,
  maxUploadMb: Math.max(1, intFromEnv("MAX_UPLOAD_MB", 25)),
  maxFiles: 10,
  // one line per request on stdout; set LOG_REQUESTS=0 for quiet test runs
  logRequests: process.env.LOG_REQUESTS !== "0",
  // kill safety net for "no state that breaks repeated runs"
  nodeVersion: process.version,
};

export const APP_NAME = "WebHVAC";
export const APP_VERSION = "1.0.0-server";
