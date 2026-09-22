#!/usr/bin/env node
import { ensureDependencies } from "./lib/ensure-deps.mjs";

const ready = ensureDependencies();
if (!ready.ok) {
  process.stderr.write(`${ready.message}\n`);
  process.exit(1);
}

const { startServer } = await import("./lib/server.mjs");
await startServer();
