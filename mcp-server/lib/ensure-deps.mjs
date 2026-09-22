import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function installed(name) {
  return existsSync(join(serverRoot, "node_modules", name, "package.json"));
}

export function dependenciesInstalled() {
  return installed("@modelcontextprotocol/sdk") && installed("zod") && installed("fast-xml-parser");
}

/**
 * Install from the lockfile when node_modules is absent.
 * npm output is kept off stdout so it cannot corrupt the MCP stdio stream.
 */
export function ensureDependencies() {
  if (dependenciesInstalled()) return { ok: true };

  process.stderr.write("Namecheap MCP dependencies are missing. Running npm ci in mcp-server.\n");
  const result = spawnSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: serverRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
  }
  if (result.status !== 0 || !dependenciesInstalled()) {
    return {
      ok: false,
      message: "Could not install Namecheap MCP dependencies. Run `npm ci` inside mcp-server, then start the server again.",
    };
  }
  return { ok: true };
}
