(function installOpenRappterGrailHost(global) {
  "use strict";

  const desktop = global.openrappterDesktop || null;
  const gatewayUrl = desktop?.gatewayUrl
    || `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
  const gatewayToken = desktop?.gatewayToken || null;
  let socket = null;
  let ready = null;
  let sequence = 0;
  const pending = new Map();

  function requestId() {
    sequence += 1;
    return `grail-${sequence}`;
  }

  function connect() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      socket = new WebSocket(gatewayUrl);
      const timeout = setTimeout(() => {
        reject(new Error("Gateway connection timed out."));
      }, 10000);
      socket.addEventListener("open", () => {
        const id = requestId();
        pending.set(id, {
          resolve: () => {
            clearTimeout(timeout);
            resolve();
          },
          reject,
        });
        socket.send(JSON.stringify({
          type: "req",
          id,
          method: "connect",
          params: {
            client: {
              id: "frontier-grail-hosted",
              version: "1",
              platform: navigator.platform || "browser",
              mode: "web",
            },
            ...(gatewayToken ? { auth: { token: gatewayToken } } : {}),
          },
        }));
      }, { once: true });
      socket.addEventListener("message", (event) => {
        let frame;
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (frame.type !== "res" || !frame.id) return;
        const waiter = pending.get(frame.id);
        if (!waiter) return;
        pending.delete(frame.id);
        if (frame.ok) waiter.resolve(frame.payload);
        else waiter.reject(new Error(frame.error?.message || "Gateway request failed."));
      });
      socket.addEventListener("error", () => {
        reject(new Error("Gateway is offline."));
      }, { once: true });
      socket.addEventListener("close", () => {
        ready = null;
        socket = null;
        for (const waiter of pending.values()) {
          waiter.reject(new Error("Gateway connection closed."));
        }
        pending.clear();
      });
    });
    return ready;
  }

  async function rpc(method, params = {}) {
    await connect();
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Gateway is offline.");
    }
    const id = requestId();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({
        type: "req",
        id,
        method,
        params,
      }));
    });
  }

  async function health() {
    const base = gatewayUrl
      .replace(/^wss:/, "https:")
      .replace(/^ws:/, "http:")
      .replace(/\/+$/, "");
    const response = await fetch(`${base}/health`, {
      headers: gatewayToken
        ? { Authorization: `Bearer ${gatewayToken}` }
        : {},
    });
    if (!response.ok) {
      throw new Error(`Patient transport /health returned HTTP ${response.status}.`);
    }
    return response.json();
  }

  const host = Object.freeze({
    mode: desktop ? "electron" : "hosted",
    health,
    rpc,
    async showAndTell(request) {
      if (!desktop?.showAndTell) {
        throw new Error("Show & Tell is unavailable outside the approved desktop bridge.");
      }
      return desktop.showAndTell(request);
    },
    legacyUrl: "./legacy/index.html",
  });
  global.OpenRappterGrailHost = host;

  if (!global.brainstemBeta) {
    const subscriptions = new Set([
      "onState",
      "onTwinFocus",
      "onTwinEvent",
      "onSurgeonEvent",
      "onOpenUpdate",
    ]);
    global.brainstemBeta = new Proxy({
      viewMode: {
        mode: "herd",
        surface: "herd",
        layout: "ring",
        customLayoutPath: null,
      },
      chatLook: "messages",
      chatStreamMode: "smooth",
      chatTypingEnabled: false,
      getState: async () => {
        throw new Error(
          "Brainstem habitat is unavailable in hosted mode; use native Grail surfaces.",
        );
      },
    }, {
      get(target, property) {
        if (property in target) return target[property];
        if (subscriptions.has(property)) return () => () => {};
        return async () => {
          throw new Error(`${String(property)} is unavailable in hosted Grail.`);
        };
      },
    });
  }
})(window);
