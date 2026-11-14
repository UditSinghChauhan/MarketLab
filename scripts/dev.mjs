/**
 * Starts the API and the web app together for local development.
 *
 *   npm run dev      in-memory command log
 *   npm run dev:pg   command log in the Postgres from docker-compose.yml
 *
 * A DATABASE_URL that is already set (in the shell or apps/api/.env) wins.
 */

import { spawn } from "node:child_process";

const env = { ...process.env };
if (process.argv.includes("--postgres")) {
  env.DATABASE_URL ??= "postgres://marketlab:marketlab@localhost:5432/marketlab";
}

const children = ["dev:api", "dev:web"].map((script) =>
  spawn("npm", ["run", script], { stdio: "inherit", env, shell: process.platform === "win32" }),
);

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
};
for (const child of children) child.on("exit", (code) => stop(code ?? 0));
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
