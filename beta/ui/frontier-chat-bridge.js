(function installFrontierChatBridge(global) {
  "use strict";

  if (
    global.parent === global
    || new URL(global.location.href).searchParams.get("frontierHost") !== "1"
  ) {
    return;
  }

  const nativeFetch = global.fetch.bind(global);
  const pending = new Map();
  let sequence = 0;

  global.addEventListener("message", (event) => {
    if (event.source !== global.parent) return;
    const message = event.data;
    if (message?.type !== "openrappter-frontier:api-result") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    waiter.resolve(message);
  });

  async function bridgedFetch(input, init = {}) {
    const raw = typeof input === "string" ? input : input?.url;
    let url;
    try {
      url = new URL(raw, "http://127.0.0.1");
    } catch {
      return nativeFetch(input, init);
    }
    const supported = new Set([
      "/health",
      "/chat",
      "/chat/stream",
      "/models",
      "/models/set",
      "/agents",
      "/voice",
    ]);
    if (!supported.has(url.pathname)) return nativeFetch(input, init);
    const id = `frontier-api-${++sequence}`;
    const request = {
      type: "openrappter-frontier:api",
      id,
      path: url.pathname,
      method: String(init.method || "GET").toUpperCase(),
      body: typeof init.body === "string" ? init.body : null,
    };
    const result = await new Promise((resolve, reject) => {
      const abort = () => {
        pending.delete(id);
        reject(new DOMException("Request aborted", "AbortError"));
      };
      if (init.signal?.aborted) {
        abort();
        return;
      }
      init.signal?.addEventListener("abort", abort, { once: true });
      pending.set(id, {
        resolve: (value) => {
          init.signal?.removeEventListener("abort", abort);
          resolve(value);
        },
      });
      global.parent.postMessage(request, "*");
    });
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  global.fetch = bridgedFetch;
})(window);
