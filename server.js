// WebHVAC server: serves the static UI and reads PDF drawings on the server.
//   npm start                 -> http://localhost:3000/
//   PORT=8080 npm start       -> custom port
//   MAX_UPLOAD_MB=50 npm start-> bigger uploads (default 25 MB per file)
//   LOG_REQUESTS=0 npm start  -> no per-request log lines
import { pathToFileURL } from "node:url";
import { buildApp, ROOT } from "./lib/app.js";
import { config } from "./lib/config.js";

export function startServer({ port = config.port, host = config.host } = {}) {
  const app = buildApp();
  const server = app.listen(port, host);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      console.log(
        `WebHVAC listening on http://localhost:${actual} ` +
          `(root ${ROOT}, max ${config.maxUploadMb} MB per file, ${config.maxFiles} files)`
      );
      resolve({ server, app, port: actual });
    });
  });
}

export function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
  });
}

// start only when run directly (importing this file must not open a port)
const isDirect =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirect) {
  const { server } = await startServer();

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`\nWebHVAC: ${signal} received, closing server ...`);
    const force = setTimeout(() => process.exit(0), 5000);
    force.unref?.();
    await closeServer(server);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (err) => {
    console.error("WebHVAC: unhandled rejection:", err);
  });
}
