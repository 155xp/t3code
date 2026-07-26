// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - NZXT CAM consumes a raw loopback HTTP/SSE boundary.
import type { KrakenDisplayState } from "@t3tools/contracts";
import * as NodeHttp from "node:http";

export const KRAKEN_DEFAULT_PORT = 3783;
export const KRAKEN_LOOPBACK_HOST = "127.0.0.1";

export interface KrakenStateHub {
  readonly getState: () => KrakenDisplayState;
  readonly publish: (state: KrakenDisplayState) => void;
  readonly subscribe: (listener: (state: KrakenDisplayState) => void) => () => void;
}

export interface KrakenHttpServerHandle {
  readonly host: typeof KRAKEN_LOOPBACK_HOST;
  readonly port: number;
  readonly close: () => Promise<void>;
}

export type KrakenHttpServerStartResult =
  | { readonly ok: true; readonly handle: KrakenHttpServerHandle }
  | { readonly ok: false; readonly error: unknown };

export function createKrakenStateHub(initialState: KrakenDisplayState): KrakenStateHub {
  let state = initialState;
  const listeners = new Set<(state: KrakenDisplayState) => void>();
  return {
    getState: () => state,
    publish: (nextState) => {
      state = nextState;
      for (const listener of listeners) {
        listener(nextState);
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export async function startKrakenHttpServer(input: {
  readonly port: number;
  readonly hub: KrakenStateHub;
  readonly keepaliveIntervalMs?: number;
}): Promise<KrakenHttpServerStartResult> {
  const server = NodeHttp.createServer((request, response) => {
    if (request.method !== "GET") {
      writeText(response, 405, "Method Not Allowed");
      return;
    }

    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    switch (path) {
      case "/":
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
          "Content-Type": "text/html; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(KRAKEN_DASHBOARD_HTML);
        return;
      case "/status":
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "application/json; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(
          JSON.stringify({
            ok: true,
            integration: "nzxt-kraken",
            state: input.hub.getState(),
          }),
        );
        return;
      case "/events": {
        response.writeHead(200, {
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream; charset=utf-8",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        });
        response.flushHeaders();
        response.write("retry: 1000\n");
        writeSseState(response, input.hub.getState());
        const unsubscribe = input.hub.subscribe((state) => writeSseState(response, state));
        const keepalive = setInterval(
          () => response.write(": keepalive\n\n"),
          input.keepaliveIntervalMs ?? 15_000,
        );
        request.once("close", () => {
          clearInterval(keepalive);
          unsubscribe();
        });
        return;
      }
      default:
        writeText(response, 404, "Not Found");
    }
  });

  const started = await new Promise<
    { readonly ok: true; readonly port: number } | { readonly ok: false; readonly error: unknown }
  >((resolve) => {
    const onError = (error: unknown) => resolve({ ok: false, error });
    server.once("error", onError);
    server.listen(input.port, KRAKEN_LOOPBACK_HOST, () => {
      server.off("error", onError);
      const address = server.address();
      resolve({
        ok: true,
        port: typeof address === "object" && address !== null ? address.port : input.port,
      });
    });
  });

  if (!started.ok) {
    server.close();
    return started;
  }

  return {
    ok: true,
    handle: {
      host: KRAKEN_LOOPBACK_HOST,
      port: started.port,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    },
  };
}

function writeText(response: NodeHttp.ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function writeSseState(response: NodeHttp.ServerResponse, state: KrakenDisplayState): void {
  if (response.destroyed) {
    return;
  }
  response.write(`event: status\ndata: ${JSON.stringify(state)}\n\n`);
}

export const KRAKEN_DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
  <title>T3 Agent Status</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #070908; }
    body { display: grid; place-items: center; }
    .card {
      --accent: #a7ff4f;
      position: relative; width: 240px; height: 240px; padding: 20px 18px 16px;
      display: flex; flex-direction: column; align-items: center; justify-content: space-between;
      color: #f4f5ef; background:
        radial-gradient(circle at 50% 28%, color-mix(in srgb, var(--accent) 18%, transparent), transparent 43%),
        linear-gradient(145deg, #101410, #050605 72%);
      border: 1px solid color-mix(in srgb, var(--accent) 42%, #1c211d);
    }
    .card::after {
      content: ""; position: absolute; inset: 8px; pointer-events: none;
      border: 1px solid color-mix(in srgb, var(--accent) 20%, transparent);
    }
    .phase-ready { --accent: #a7ff4f; }
    .phase-starting, .phase-working { --accent: #54d7ff; }
    .phase-approval, .phase-input { --accent: #ffbd4a; }
    .phase-done { --accent: #8aff80; }
    .phase-failed, .phase-stopped { --accent: #ff5f57; }
    .provider {
      max-width: 190px; color: var(--accent); font-size: 12px; font-weight: 800;
      letter-spacing: .15em; line-height: 1; overflow: hidden; text-overflow: ellipsis;
      text-transform: uppercase; white-space: nowrap;
    }
    .mark { position: relative; width: 82px; height: 82px; display: grid; place-items: center; }
    .ring {
      position: absolute; inset: 7px; border: 3px solid color-mix(in srgb, var(--accent) 20%, #202620);
      border-top-color: var(--accent); border-radius: 50%;
    }
    .phase-working .ring, .phase-starting .ring { animation: spin 1.2s linear infinite; }
    .glyph { color: var(--accent); font-size: 45px; font-weight: 500; line-height: 1; }
    .label { font-size: 23px; font-weight: 900; letter-spacing: .08em; line-height: 1; text-transform: uppercase; }
    .task {
      width: 196px; min-height: 31px; color: #cbd0c8; display: -webkit-box; overflow: hidden;
      font-size: 13px; font-weight: 650; line-height: 1.2; text-align: center;
      -webkit-box-orient: vertical; -webkit-line-clamp: 2;
    }
    .count { min-height: 12px; color: #747c74; font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <main id="card" class="card phase-ready">
    <div id="provider" class="provider">T3 CODE</div>
    <div class="mark"><div class="ring"></div><div id="glyph" class="glyph">⌁</div></div>
    <div id="label" class="label">Ready</div>
    <div id="task" class="task">Waiting for an agent</div>
    <div id="count" class="count"></div>
  </main>
  <script>
    const view = {
      card: document.getElementById("card"), provider: document.getElementById("provider"),
      glyph: document.getElementById("glyph"), label: document.getElementById("label"),
      task: document.getElementById("task"), count: document.getElementById("count")
    };
    const meta = {
      ready: ["⌁", "READY"], starting: ["·", "STARTING"], working: ["·", "WORKING"],
      approval: ["!", "APPROVAL"], input: ["?", "INPUT"], done: ["✓", "DONE"],
      failed: ["×", "FAILED"], stopped: ["■", "STOPPED"]
    };
    function render(state) {
      const [glyph, label] = meta[state.phase] || meta.ready;
      view.card.className = "card phase-" + state.phase;
      view.provider.textContent = state.providerTitle || "T3 CODE";
      view.glyph.textContent = glyph;
      view.label.textContent = label;
      view.task.textContent = state.taskTitle || "Waiting for an agent";
      view.count.textContent = state.activeCount > 0
        ? state.activeCount + (state.activeCount === 1 ? " agent active" : " agents active")
        : "";
    }
    const events = new EventSource("/events");
    events.addEventListener("status", event => {
      try { render(JSON.parse(event.data)); } catch {}
    });
  </script>
</body>
</html>`;
