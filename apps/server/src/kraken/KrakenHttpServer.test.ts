// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Tests the raw loopback boundary consumed by NZXT CAM.
import * as NodeHttp from "node:http";

import type { KrakenDisplayState } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  createKrakenStateHub,
  KRAKEN_DASHBOARD_HTML,
  startKrakenHttpServer,
  type KrakenHttpServerHandle,
} from "./KrakenHttpServer.ts";

const READY: KrakenDisplayState = {
  version: 1,
  phase: "ready",
  providerTitle: null,
  taskTitle: null,
  activeCount: 0,
  threadId: null,
  turnId: null,
  updatedAt: "2026-07-25T20:00:00.000Z",
};

describe("KrakenHttpServer", () => {
  let handle: KrakenHttpServerHandle | null = null;

  afterEach(async () => {
    await handle?.close();
    handle = null;
  });

  it("serves the dashboard and read-only status on IPv4 loopback", async () => {
    const hub = createKrakenStateHub(READY);
    const started = await startKrakenHttpServer({ port: 0, hub });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    handle = started.handle;

    expect(handle.host).toBe("127.0.0.1");
    const root = await fetch(`http://127.0.0.1:${handle.port}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("<title>T3 Agent Status</title>");

    const status = await fetch(`http://127.0.0.1:${handle.port}/status`);
    expect(await status.json()).toEqual({
      ok: true,
      integration: "nzxt-kraken",
      state: READY,
    });
  });

  it("streams updates and gives reconnecting clients the latest state", async () => {
    const hub = createKrakenStateHub(READY);
    const started = await startKrakenHttpServer({ port: 0, hub });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    handle = started.handle;

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${handle.port}/events`, {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    expect(initial).toContain("event: status");
    expect(initial).toContain('"phase":"ready"');

    hub.publish({ ...READY, phase: "working", providerTitle: "Codex", taskTitle: "Test" });
    const update = new TextDecoder().decode((await reader.read()).value);
    expect(update).toContain('"phase":"working"');
    controller.abort();

    const reconnect = new AbortController();
    const reconnectResponse = await fetch(`http://127.0.0.1:${handle.port}/events`, {
      signal: reconnect.signal,
    });
    const reconnectReader = reconnectResponse.body!.getReader();
    const snapshot = new TextDecoder().decode((await reconnectReader.read()).value);
    expect(snapshot).toContain("retry: 1000");
    expect(snapshot).toContain('"phase":"working"');
    reconnect.abort();
  });

  it("keeps idle CAM event streams alive", async () => {
    const hub = createKrakenStateHub(READY);
    const started = await startKrakenHttpServer({ port: 0, hub, keepaliveIntervalMs: 5 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    handle = started.handle;

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${handle.port}/events`, {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();
    const keepalive = new TextDecoder().decode((await reader.read()).value);
    expect(keepalive).toContain(": keepalive");
    controller.abort();
  });

  it("returns a nonfatal result when the configured port is occupied", async () => {
    const blocker = NodeHttp.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const started = await startKrakenHttpServer({
      port,
      hub: createKrakenStateHub(READY),
    });
    expect(started.ok).toBe(false);
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });

  it("keeps the display self-contained and sized for the 240px Kraken panel", () => {
    expect(KRAKEN_DASHBOARD_HTML).toContain("width: 240px; height: 240px");
    expect(KRAKEN_DASHBOARD_HTML).not.toMatch(/https?:\/\//);
  });
});
