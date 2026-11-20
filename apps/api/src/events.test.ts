import { describe, expect, it } from "vitest";

import { createEventLog, safeFields } from "./events.js";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const emit = createEventLog(
    (line) => {
      expect(line.endsWith("\n")).toBe(true);
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
    () => 1_000,
  );
  return { emit, lines };
}

describe("lifecycle events", () => {
  it("writes one pino-shaped JSON line per event", () => {
    const { emit, lines } = capture();
    emit("snapshot_saved", { seq: 12, session: 3 });
    expect(lines).toEqual([
      {
        level: 30,
        time: 1_000,
        event: "snapshot_saved",
        msg: "snapshot_saved",
        seq: 12,
        session: 3,
      },
    ]);
  });

  it("uses each event's level unless told otherwise", () => {
    const { emit, lines } = capture();
    emit("persistence_failed", { error: "boom" });
    emit("shutdown_deadline_exceeded");
    emit("lock_waiting");
    emit("shutdown_completed", {}, { level: "warn", message: "done, with a skip" });
    expect(lines.map((l) => [l.level, l.msg])).toEqual([
      [50, "persistence_failed"],
      [50, "shutdown_deadline_exceeded"],
      [40, "lock_waiting"],
      [40, "done, with a skip"],
    ]);
  });

  it("never logs tokens or client addresses", () => {
    expect(
      safeFields({
        token: "t",
        accessToken: "t",
        authorization: "Bearer t",
        ip: "203.0.113.9",
        clientIp: "203.0.113.9",
        client_ip: "203.0.113.9",
        remoteAddress: "203.0.113.9",
        xForwardedFor: "203.0.113.9",
        cookie: "c",
        skip: true,
        seq: 4,
      }),
    ).toEqual({ skip: true, seq: 4 });

    const { emit, lines } = capture();
    emit("engine_ready", { token: "secret", seq: 1 });
    expect(JSON.stringify(lines)).not.toContain("secret");
  });

  it("cannot have its level, time or event name overwritten by a field", () => {
    const { emit, lines } = capture();
    emit("engine_ready", { level: 10, time: 0, event: "other", msg: "x" });
    expect(lines[0]).toMatchObject({
      level: 30,
      time: 1_000,
      event: "engine_ready",
      msg: "engine_ready",
    });
  });
});
