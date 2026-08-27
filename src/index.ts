import { startSidecars, stopSidecars } from "./sidecar.js";
import { createServer } from "./server.js";
import { getDefaultLang } from "./config.js";

const PORT = Number(Bun.env.PORT ?? 3001);

console.log("=".repeat(50));
console.log(`  PocketTTS Server (German 24l + English, ungated models)`);
console.log(`  Default language: ${getDefaultLang()}`);
console.log("=".repeat(50));

try {
  await startSidecars();
} catch (error) {
  console.error(`[fatal] Failed to start sidecars: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const server = await createServer();

console.log(`[server] Listening on http://localhost:${PORT}`);
console.log(`[server] Demo page:  http://localhost:${PORT}/`);
console.log(`[server] API docs:   http://localhost:${PORT}/docs (Swagger UI, /openapi.json)`);
console.log("=".repeat(50));

function shutdown() {
  console.log("\n[server] Shutting down...");

  server.stop(true);

  stopSidecars();

  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
