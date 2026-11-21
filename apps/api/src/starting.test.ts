import { afterEach, describe, expect, it } from "vitest";

import { closeServer, createStartingServer, listen, type StartingServer } from "./starting.js";

let started: StartingServer | undefined;
afterEach(async () => {
  if (started) await closeServer(started.server);
  started = undefined;
});

async function serve() {
  started = createStartingServer();
  const port = await listen(started.server, "127.0.0.1", 0);
  return { starting: started, base: `http://127.0.0.1:${String(port)}` };
}

describe("the server before the engine is ready", () => {
  it("says it is starting, and why, on /api/health", async () => {
    const { starting, base } = await serve();
    let res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: "starting",
      reason: "waiting for the previous instance",
    });

    starting.setReason("replaying the command log");
    res = await fetch(`${base}/api/health?probe=1`);
    expect(await res.json()).toEqual({ status: "starting", reason: "replaying the command log" });
  });

  it("answers every other request with 503", async () => {
    const { base } = await serve();
    for (const [method, path] of [
      ["GET", "/"],
      ["GET", "/api/markets"],
      ["POST", "/api/session"],
      ["GET", "/api/stream?symbol=ORBT"],
    ] as const) {
      const res = await fetch(`${base}${path}`, { method });
      expect(res.status, path).toBe(503);
      expect(res.headers.get("retry-after")).toBe("5");
      expect(await res.json()).toEqual({
        error: { code: "unavailable", message: "The exchange is starting" },
      });
    }
  });

  it("hands the same port over to the app", async () => {
    const { starting, base } = await serve();
    expect((await fetch(`${base}/api/health`)).status).toBe(503);
    starting.handOver((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("app");
    });
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("app");
  });
});
