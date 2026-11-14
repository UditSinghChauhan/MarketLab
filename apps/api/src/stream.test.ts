import type { StreamMessage } from "@marketlab/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type { EngineHost } from "./host.js";
import { INSTRUMENTS } from "./instruments.js";
import { MemoryLog } from "./log/memory.js";
import { StreamHub } from "./stream.js";
import { buy, clock, startHost, testConfig } from "./test/fixtures.js";

let app: FastifyInstance;
let host: EngineHost;
let hub: StreamHub;
let base: string;

beforeAll(async () => {
  host = await startHost(new MemoryLog(), clock().now);
  host.tick();
  hub = new StreamHub(host, INSTRUMENTS, { bookIntervalMs: 20, marketsIntervalMs: 50 });
  hub.start();
  app = await buildApp({
    config: testConfig(),
    host,
    hub,
    instruments: INSTRUMENTS,
    persistence: "memory",
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  base = `http://127.0.0.1:${String(typeof address === "object" && address ? address.port : 0)}`;
});
afterAll(async () => {
  hub.stop();
  await app.close();
});

/** Reads server-sent events until `until` returns true or time runs out. */
async function collect(
  url: string,
  until: (messages: StreamMessage[]) => boolean,
  act?: () => Promise<void>,
): Promise<StreamMessage[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 3_000);
  const res = await fetch(url, { signal: controller.signal });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = (res.body as ReadableStream<Uint8Array> | null)?.getReader();
  const decoder = new TextDecoder();
  const messages: StreamMessage[] = [];
  let buffer = "";
  let acted = false;
  try {
    while (reader && !until(messages)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (part.startsWith("data: ")) messages.push(JSON.parse(part.slice(6)) as StreamMessage);
      }
      if (!acted && act && messages.some((m) => m.type === "hello")) {
        acted = true;
        await act();
      }
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  return messages;
}

describe("event stream", () => {
  it("sends a snapshot on connect, then live trades and books", async () => {
    const messages = await collect(
      `${base}/api/stream?symbol=SOLR`,
      (m) => m.filter((x) => x.type === "trades").length >= 2 && m.some((x) => x.type === "candle"),
      async () => {
        for (let i = 0; i < 10; i++) host.tick();
        await new Promise((r) => setTimeout(r, 60));
      },
    );
    const types = messages.map((m) => m.type);
    expect(types.slice(0, 3)).toEqual(["hello", "markets", "book"]);
    expect(types).toContain("candle");
    const book = messages.find((m) => m.type === "book");
    expect(book?.type === "book" && book.book.symbol).toBe("SOLR");
  });

  it("pushes the caller's own order events and account, but not to others", async () => {
    const session = await app.inject({ method: "POST", url: "/api/session" });
    const { token, accountId } = session.json<{ token: string; accountId: string }>();

    const messages = await collect(
      `${base}/api/stream?symbol=ORBT&token=${token}`,
      (m) => m.some((x) => x.type === "orders"),
      async () => {
        await host.submit(buy(accountId, "ORBT", 2));
      },
    );
    const orders = messages.find((m) => m.type === "orders");
    expect(orders?.type === "orders" && orders.events.map((e) => e.type)).toContain("order.filled");
    expect(messages.some((m) => m.type === "account")).toBe(true);
  });

  it("rejects an invalid token", async () => {
    const res = await fetch(`${base}/api/stream?symbol=ORBT&token=nope`);
    expect(res.status).toBe(401);
  });
});
