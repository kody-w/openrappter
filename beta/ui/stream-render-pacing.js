(function registerStreamRenderPacing(root) {
  function splitRenderPieces(value) {
    const text = String(value ?? "");
    if (!text) return [];
    const pieces = text.match(/\s*\S+(?:\s+|$)|\s+/gu) || [];
    return pieces.join("") === text ? pieces : [text];
  }

  function createAdaptiveRenderPacer({
    onRender = () => {},
    frameIntervalMs = 24,
    maxLagMs = 1000,
    terminalDrainMs = 300,
    emaAlpha = 0.3,
    now = () => performance.now(),
    requestFrame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (frame) => cancelAnimationFrame(frame),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (timer) => clearTimeout(timer),
  } = {}) {
    const frameInterval = Math.max(1, Number(frameIntervalMs) || 24);
    const lagLimit = Math.max(frameInterval, Number(maxLagMs) || 1000);
    const terminalLimit = Math.max(
      frameInterval,
      Number(terminalDrainMs) || 300,
    );
    const alpha = Math.min(1, Math.max(0.01, Number(emaAlpha) || 0.3));
    const queue = [];
    let active = true;
    let displayedText = "";
    let frame = null;
    let firstArrivalAt = null;
    let lastArrivalAt = null;
    let emaArrivalMs = lagLimit;
    let terminalDeadline = null;
    let renderCount = 0;
    let firstRenderAt = null;
    let lastRenderAt = null;
    let maxObservedLagMs = 0;
    let drainPromise = null;
    let resolveDrain = null;
    let terminalTimer = null;

    function updateArrival(arrivedAt) {
      if (firstArrivalAt === null) firstArrivalAt = arrivedAt;
      if (lastArrivalAt !== null) {
        const interval = Math.max(frameInterval, arrivedAt - lastArrivalAt);
        emaArrivalMs = (alpha * interval) + ((1 - alpha) * emaArrivalMs);
      }
      lastArrivalAt = arrivedAt;
    }

    function enqueue(value, arrivedAt) {
      for (const piece of splitRenderPieces(value)) {
        if (piece) queue.push({ arrivedAt, value: piece });
      }
    }

    function renderBatch(count, reason) {
      if (!count) return;
      const renderedAt = now();
      const items = queue.splice(0, count);
      displayedText += items.map((item) => item.value).join("");
      for (const item of items) {
        maxObservedLagMs = Math.max(
          maxObservedLagMs,
          renderedAt - item.arrivedAt,
        );
      }
      if (firstRenderAt === null) firstRenderAt = renderedAt;
      lastRenderAt = renderedAt;
      renderCount += 1;
      onRender(displayedText, Object.freeze({
        pendingPieces: queue.length,
        reason,
        renderCount,
        renderedAt,
      }));
    }

    function completeDrain() {
      if (!terminalDeadline || queue.length) return;
      terminalDeadline = null;
      if (terminalTimer !== null) clearTimer(terminalTimer);
      terminalTimer = null;
      const resolve = resolveDrain;
      resolveDrain = null;
      drainPromise = null;
      resolve?.(displayedText);
    }

    function batchSize() {
      if (!queue.length) return 0;
      const currentTime = now();
      const oldestAge = Math.max(0, currentTime - queue[0].arrivedAt);
      const availableWindow = terminalDeadline === null
        ? Math.min(
          Math.max(frameInterval, emaArrivalMs),
          Math.max(frameInterval, lagLimit - oldestAge),
        )
        : Math.max(frameInterval, terminalDeadline - currentTime);
      const frames = Math.max(1, Math.floor(availableWindow / frameInterval));
      return Math.max(1, Math.ceil(queue.length / frames));
    }

    function schedule() {
      if (!active || frame !== null || !queue.length) {
        completeDrain();
        return;
      }
      frame = requestFrame(tick);
    }

    function tick() {
      frame = null;
      if (!active) return;
      renderBatch(
        batchSize(),
        terminalDeadline === null ? "paced" : "terminal-drain",
      );
      if (queue.length) schedule();
      else completeDrain();
    }

    function push(value) {
      if (!active) return false;
      const arrivedAt = now();
      updateArrival(arrivedAt);
      const wasEmpty = queue.length === 0 && frame === null;
      enqueue(value, arrivedAt);
      if (wasEmpty && renderCount === 0 && queue.length) {
        renderBatch(1, "immediate");
      }
      schedule();
      return true;
    }

    function finish() {
      if (!active) return Promise.resolve(displayedText);
      if (!queue.length) return Promise.resolve(displayedText);
      if (!drainPromise) {
        terminalDeadline = now() + terminalLimit;
        drainPromise = new Promise((resolve) => {
          resolveDrain = resolve;
        });
        terminalTimer = setTimer(() => {
          terminalTimer = null;
          if (!active) return;
          if (frame !== null) cancelFrame(frame);
          frame = null;
          renderBatch(queue.length, "terminal-timeout");
          completeDrain();
        }, terminalLimit);
      }
      schedule();
      return drainPromise;
    }

    function abort() {
      if (!active) return false;
      active = false;
      if (frame !== null) cancelFrame(frame);
      frame = null;
      if (terminalTimer !== null) clearTimer(terminalTimer);
      terminalTimer = null;
      queue.length = 0;
      terminalDeadline = null;
      const resolve = resolveDrain;
      resolveDrain = null;
      drainPromise = null;
      resolve?.(displayedText);
      return true;
    }

    function metrics() {
      const durationMs = firstRenderAt === null || lastRenderAt === null
        ? 0
        : lastRenderAt - firstRenderAt;
      return Object.freeze({
        displayedLength: displayedText.length,
        durationMs,
        emaArrivalMs,
        maxLagMs: maxObservedLagMs,
        pendingPieces: queue.length,
        renderCount,
        rendersPerSecond: durationMs > 0
          ? renderCount * 1000 / durationMs
          : renderCount ? 1000 / frameInterval : 0,
      });
    }

    return Object.freeze({
      abort,
      finish,
      metrics,
      push,
      text: () => displayedText,
    });
  }

  root.RappStreamRenderPacing = Object.freeze({
    createAdaptiveRenderPacer,
    splitRenderPieces,
  });
})(globalThis);
