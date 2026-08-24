(function installOpenRappterFrontierHost(global) {
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
    return `frontier-${sequence}`;
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
              id: "frontier-primary-hosted",
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
  global.OpenRappterFrontierHost = host;

  if (!global.brainstemBeta) {
    const stateSubscribers = new Set();
    const surgeonSubscribers = new Set();
    const surgeonSessions = new Map();
    const chatUrl = new URL("frontier-chat/index.html", location.href);
    chatUrl.searchParams.set("frontierHost", "1");
    let chatLook = "messages";

    async function frontierState() {
      try {
        const [healthState, backend] = await Promise.all([
          health(),
          rpc("backend.status"),
        ]);
        const modelReady = backend?.ready === true || backend?.status === "ready";
        return {
          url: chatUrl.href,
          brainstem: {
            phase: ["ok", "degraded"].includes(healthState?.status)
              ? "ready"
              : "error",
            message: `Gateway ${healthState?.status || "unhealthy"}`,
          },
          surgeon: {
            phase: modelReady ? "ready" : "error",
            message: modelReady
              ? `Copilot ${backend.model || "model"} ready`
              : "Copilot model is not ready.",
          },
          chatLook,
          chatTypingEnabled: false,
          viewMode: {
            mode: "herd",
            surface: "herd",
            layout: "ring",
            customLayoutPath: null,
          },
          neighborhood: {
            app_name: "OpenRappter",
            instance: "personal",
            neighborhood_id: "openrappter-personal",
          },
          estate: { neighborhood_count: 1 },
          update: {
            phase: "idle",
            message: "Use Release rings in OpenRappter features.",
          },
        };
      } catch (cause) {
        return {
          url: chatUrl.href,
          brainstem: {
            phase: "error",
            message: String(cause?.message || cause),
          },
          surgeon: {
            phase: "error",
            message: "Copilot readiness is unavailable.",
          },
          chatLook,
          chatTypingEnabled: false,
          viewMode: {
            mode: "herd",
            surface: "herd",
            layout: "ring",
            customLayoutPath: null,
          },
        };
      }
    }

    function emitSurgeon(event) {
      for (const subscriber of surgeonSubscribers) subscriber(event);
    }

    async function handleFrontierApi(path, method, rawBody) {
      let body = {};
      if (rawBody) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          return { status: 400, body: { error: "Request body must be JSON." } };
        }
      }
      try {
        if (path === "/health") {
          return { status: 200, body: await health() };
        }
        if (path === "/chat/stream") {
          return {
            status: 404,
            body: { error: "Streaming falls back to the authenticated chat adapter." },
          };
        }
        if (path === "/chat" && method === "POST") {
          const result = await rpc("agent", {
            message: body.user_input,
            sessionId: body.session_id,
            conversationHistory: body.conversation_history,
          });
          return {
            status: 200,
            body: {
              response: result?.content || "",
              agent_logs: result?.agentLogs || null,
              session_id: result?.sessionId || body.session_id || null,
              voice_response: result?.voiceResponse || null,
              model: result?.model || null,
            },
          };
        }
        if (path === "/models" && method === "GET") {
          const result = await rpc("models.available");
          return {
            status: 200,
            body: {
              current: result?.current || null,
              models: (result?.models || []).map((model) => ({
                id: model.id,
                name: model.id,
              })),
            },
          };
        }
        if (path === "/models/set" && method === "POST") {
          return { status: 200, body: await rpc("models.set", body) };
        }
        if (path === "/agents" && method === "GET") {
          const result = await rpc("agents.files.list");
          return {
            status: 200,
            body: {
              files: (result?.files || []).map((file) => ({
                filename: file.name,
                agents: [file.name.replace(/\.(?:js|ts|py)$/, "")],
              })),
            },
          };
        }
        if (path === "/voice" && method === "GET") {
          const [status, providers] = await Promise.all([
            rpc("voice.mode.status"),
            rpc("tts.providers"),
          ]);
          return { status: 200, body: { ...status, providers } };
        }
        return {
          status: 503,
          body: { error: `${method} ${path} has no approved Frontier adapter.` },
        };
      } catch (cause) {
        return {
          status: /auth|sign.?in|401/i.test(String(cause?.message || cause))
            ? 401
            : 503,
          body: { error: String(cause?.message || cause) },
        };
      }
    }

    global.addEventListener("message", (event) => {
      const frame = document.getElementById("brainstem");
      if (event.source !== frame?.contentWindow) return;
      const message = event.data;
      if (
        message?.type !== "openrappter-frontier:api"
        || typeof message.id !== "string"
        || typeof message.path !== "string"
      ) {
        return;
      }
      void handleFrontierApi(
        message.path,
        String(message.method || "GET"),
        message.body,
      ).then((result) => {
        event.source.postMessage({
          type: "openrappter-frontier:api-result",
          id: message.id,
          ...result,
        }, "*");
      });
    });

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
      get chatLook() { return chatLook; },
      chatStreamMode: "smooth",
      chatTypingEnabled: false,
      getState: frontierState,
      onState(subscriber) {
        stateSubscribers.add(subscriber);
        void frontierState().then(subscriber);
        return () => stateSubscribers.delete(subscriber);
      },
      onSurgeonEvent(subscriber) {
        surgeonSubscribers.add(subscriber);
        return () => surgeonSubscribers.delete(subscriber);
      },
      onTwinFocus: () => () => {},
      onTwinEvent: () => () => {},
      onOpenUpdate: () => () => {},
      async surgeonSend(sessionId, message) {
        emitSurgeon({ type: "response-start", sessionId });
        try {
          const result = await rpc("agent", {
            message,
            sessionId: surgeonSessions.get(sessionId),
          });
          if (result?.sessionId) surgeonSessions.set(sessionId, result.sessionId);
          emitSurgeon({
            type: "done",
            sessionId,
            content: result?.content || "",
          });
          return result;
        } catch (cause) {
          emitSurgeon({
            type: "error",
            sessionId,
            message: String(cause?.message || cause),
          });
          throw cause;
        }
      },
      async surgeonReset(sessionId) {
        surgeonSessions.delete(sessionId);
        emitSurgeon({ type: "reset", sessionId });
        return { reset: true };
      },
      async surgeonClose(sessionId) {
        surgeonSessions.delete(sessionId);
        return { closed: true };
      },
      async setChatLook(value) {
        chatLook = ["messages", "business"].includes(value)
          ? value
          : "messages";
        const state = await frontierState();
        for (const subscriber of stateSubscribers) subscriber(state);
        return { chatLook };
      },
      installFrameBridge: async () => ({
        installed: false,
        reason: "The packaged Frontier chat uses the authenticated host bridge.",
      }),
      recordBrainstemTurn: async () => ({
        recorded: false,
        reason: "Gateway chat history is already authoritative.",
      }),
      listAgentFiles: async () => rpc("agents.files.list"),
      readAgentFile: async (name) => rpc("agents.files.get", { name }),
    }, {
      get(target, property) {
        if (property in target) return target[property];
        if (subscriptions.has(property)) return () => () => {};
        return async () => {
          throw new Error(`${String(property)} is unavailable in hosted Frontier.`);
        };
      },
    });
  }
})(window);
