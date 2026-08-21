export function installTwinLedgerBridge({
  sink = "preload",
  twinId = null,
} = {}) {
  if (window.__rappTwinLedgerBridge) return true;
  window.__rappTwinLedgerBridge = true;
  const nativeFetch = window.fetch.bind(window);

  function parseSseEvent(frame) {
    const data = String(frame)
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }

  }

  async function refreshAmbient() {
    if (sink !== "parent") {
      return window.rappTwinLedger?.refreshAmbient?.();
    }
    const requestId = window.crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", receive);
        reject(new Error("Ambient context refresh timed out."));
      }, 3000);
      function receive(event) {
        if (
          event.source !== window.top
          || event.data?.type !== "rapp-beta:twin-refresh-ambient-result"
          || event.data?.requestId !== requestId
        ) return;
        window.clearTimeout(timeout);
        window.removeEventListener("message", receive);
        if (event.data.ok) resolve(event.data.result);
        else reject(new Error(
          event.data.error || "Ambient context refresh failed.",
        ));
      }
      window.addEventListener("message", receive);
      window.top.postMessage({
        type: "rapp-beta:twin-refresh-ambient",
        requestId,
        twinId,
      }, "*");
    });
  }

  function deliver(request, result) {
    const response = String(
      result?.response || result?.assistant_response || result?.result || "",
    );
    const turn = response
      ? {
          agentLogs: result?.agent_logs || "",
          model: result?.model || null,
          requestId: request.requestId,
          response,
          sessionId: result?.session_id || request.body.session_id || null,
          userInput: request.body.user_input,
        }
      : {
          requestId: request.requestId,
          settledOnly: true,
        };
    if (sink === "parent") {
      window.top.postMessage({
        type: "rapp-beta:twin-ledger-turn",
        twinId,
        turn,
      }, "*");
      return;
    }
    const pending = window.rappTwinLedger?.recordCompletedTurn(turn);
    pending?.catch?.(() => {});
  }

  function createCapture(request) {
    const decoder = new TextDecoder();
    let buffer = "";
    let reported = false;
    let terminal = null;
    return {
      abort() {
        if (reported) return;
        reported = true;
        terminal = null;
        deliver(request, null);
      },
      finish() {
        if (reported) return;
        reported = true;
        deliver(request, terminal);
      },
      push(value) {
        if (reported || terminal || !value) return;
        buffer += decoder.decode(value, { stream: true });
        while (true) {
          const separator = /\r?\n\r?\n/.exec(buffer);
          if (!separator) return;
          const end = separator.index + separator[0].length;
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end);
          const event = parseSseEvent(frame);
          if (event?.type !== "done") continue;
          terminal = event;
          return;
        }
      },
    };
  }

  function instrument(response, request) {
    if (request.pathname === "/chat/stream" && response.body) {
      const capture = createCapture(request);
      const nativeGetReader = response.body.getReader.bind(response.body);
      response.body.getReader = function twinLedgerReader(...args) {
        const reader = nativeGetReader(...args);
        const nativeRead = reader.read.bind(reader);
        const nativeCancel = reader.cancel.bind(reader);
        reader.read = async function twinLedgerRead() {
          try {
            const result = await nativeRead();
            if (result.done) capture.finish();
            else capture.push(result.value);
            return result;
          } catch (cause) {
            capture.abort();
            throw cause;
          }
        };
        reader.cancel = function twinLedgerCancel(reason) {
          capture.abort();
          return nativeCancel(reason);
        };
        return reader;
      };
      return response;
    }
    let reported = false;
    const report = (result) => {
      if (reported) return;
      reported = true;
      deliver(request, result);
    };
    const nativeJson = response.json.bind(response);
    response.json = async function twinLedgerJson() {
      try {
        const result = await nativeJson();
        report(result);
        return result;
      } finally {
        if (!reported) report(null);
      }
    };
    const nativeText = response.text.bind(response);
    response.text = async function twinLedgerText() {
      try {
        const result = await nativeText();
        try {
          report(JSON.parse(result));
        } catch {
          report(null);
        }
        return result;
      } finally {
        if (!reported) report(null);
      }
    };
    return response;
  }

  window.fetch = async function twinLedgerFetch(resource, options = {}) {
    let target;
    try {
      const raw = resource instanceof Request ? resource.url : String(resource);
      target = new URL(raw, window.location.href);
    } catch {
      return nativeFetch(resource, options);
    }
    const method = String(
      options.method || (resource instanceof Request ? resource.method : "GET"),
    ).toUpperCase();
    const isChat = method === "POST"
      && (target.pathname === "/chat" || target.pathname === "/chat/stream");
    if (!isChat || typeof options.body !== "string") {
      return nativeFetch(resource, options);
    }
    let body;
    try {
      body = JSON.parse(options.body);
    } catch {
      return nativeFetch(resource, options);
    }
    if (typeof body.user_input !== "string") {
      return nativeFetch(resource, options);
    }
    try {
      await refreshAmbient();
    } catch {
      // Ambient context is additive; twin chat must remain fail-open.
    }
    const response = await nativeFetch(resource, options);
    try {
      return instrument(response, {
        body,
        pathname: target.pathname,
        requestId: window.crypto.randomUUID(),
      });
    } catch {
      return response;
    }
  };
  return true;
}

export function createTwinLedgerBridgeSource(options = {}) {
  const normalized = {
    sink: options.sink === "parent" ? "parent" : "preload",
    twinId: options.twinId ? String(options.twinId) : null,
  };
  return "/* Added by the RAPP Brainstem Frontier host: the twin ledger bridge, which"
    + " forwards this twin's tool and turn events to the ledger so the run leaves a"
    + " record. It reads events already emitted here and adds no capability. */\n"
    + `(${installTwinLedgerBridge.toString()})(${JSON.stringify(normalized)})`;
}
