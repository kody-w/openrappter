(function registerStreamPacing(root) {
  function splitTextPieces(value) {
    const text = String(value ?? "");
    if (!text) return [];
    const pieces = text.match(/\s*\S+(?:\s+|$)|\s+/gu) || [];
    return pieces.join("") === text ? pieces : [text];
  }

  function createTextSplitter() {
    let pending = "";

    function trailingFencePrefixLength(text) {
      const match = String(text).match(/([`~]{1,2})$/u);
      if (!match) return 0;
      const marker = match[1];
      return [...marker].every((character) => character === marker[0])
        ? marker.length
        : 0;
    }

    function push(value) {
      const text = pending + String(value ?? "");
      const heldLength = trailingFencePrefixLength(text);
      const released = heldLength ? text.slice(0, -heldLength) : text;
      pending = heldLength ? text.slice(-heldLength) : "";
      return splitTextPieces(released);
    }

    function finish() {
      const released = pending;
      pending = "";
      return splitTextPieces(released);
    }

    function reset() {
      pending = "";
    }

    return Object.freeze({
      finish,
      push,
      reset,
    });
  }

  function createStreamPacer({
    onText = () => {},
    onEvent = () => {},
    cadenceMs = 32,
    maxLagMs = 1000,
    now = () => Date.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (timer) => clearTimeout(timer),
  } = {}) {
    const cadence = Math.max(1, Number(cadenceMs) || 32);
    const lagLimit = Math.max(cadence, Number(maxLagMs) || 1000);
    const splitter = createTextSplitter();
    const queue = [];
    let active = true;
    let timer = null;
    let emissionCount = 0;
    let firstEmitAt = null;
    let lastEmitAt = null;
    let maxObservedLagMs = 0;

    function updateMetrics(items) {
      const emittedAt = now();
      if (firstEmitAt === null) firstEmitAt = emittedAt;
      lastEmitAt = emittedAt;
      emissionCount += 1;
      for (const item of items) {
        maxObservedLagMs = Math.max(
          maxObservedLagMs,
          emittedAt - item.enqueuedAt,
        );
      }
    }

    function enqueueText(pieces) {
      const enqueuedAt = now();
      for (const piece of pieces) {
        if (piece) queue.push({ kind: "text", value: piece, enqueuedAt });
      }
    }

    function emitEventsAtHead() {
      while (queue[0]?.kind === "event") {
        const item = queue.shift();
        onEvent(item.value);
      }
    }

    function leadingTextCount() {
      let count = 0;
      while (queue[count]?.kind === "text") count += 1;
      return count;
    }

    function emitTextBatch(count) {
      const items = queue.splice(0, count);
      updateMetrics(items);
      onText(items.map((item) => item.value).join(""));
    }

    function schedule() {
      if (!active || timer !== null || !queue.length) return;
      timer = setTimer(drainOne, cadence);
    }

    function drainOne() {
      timer = null;
      if (!active) return;
      emitEventsAtHead();
      const textCount = leadingTextCount();
      if (textCount) {
        const oldestLag = Math.max(0, now() - queue[0].enqueuedAt);
        const remainingBudget = Math.max(0, lagLimit - oldestLag);
        const maximumEmissions = Math.floor(remainingBudget / cadence) + 1;
        const batchSize = Math.max(
          1,
          Math.ceil(textCount / maximumEmissions),
        );
        emitTextBatch(batchSize);
        emitEventsAtHead();
      }
      schedule();
    }

    function startIfIdle(wasIdle) {
      if (!active || !queue.length) return;
      if (wasIdle) drainOne();
      else schedule();
    }

    function push(value) {
      if (!active) return false;
      const wasIdle = queue.length === 0 && timer === null;
      enqueueText(splitter.push(value));
      startIfIdle(wasIdle);
      return true;
    }

    function event(value, { terminal = false } = {}) {
      if (!active) return false;
      const wasIdle = queue.length === 0 && timer === null;
      enqueueText(splitter.finish());
      queue.push({
        kind: "event",
        value,
        enqueuedAt: now(),
      });
      if (terminal) flush();
      else startIfIdle(wasIdle);
      return true;
    }

    function flush() {
      if (!active) return false;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      enqueueText(splitter.finish());
      while (queue.length) {
        emitEventsAtHead();
        const textCount = leadingTextCount();
        if (textCount) emitTextBatch(textCount);
      }
      return true;
    }

    function finish() {
      if (!active) return false;
      flush();
      active = false;
      return true;
    }

    function abort() {
      if (!active) return false;
      active = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
      queue.length = 0;
      splitter.reset();
      return true;
    }

    function metrics() {
      const durationMs = firstEmitAt === null || lastEmitAt === null
        ? 0
        : lastEmitAt - firstEmitAt;
      return Object.freeze({
        cadenceMs: cadence,
        durationMs,
        emissionCount,
        maxLagMs: maxObservedLagMs,
        piecesPerSecond: durationMs > 0
          ? emissionCount * 1000 / durationMs
          : emissionCount ? 1000 / cadence : 0,
        pendingItems: queue.length,
      });
    }

    return Object.freeze({
      abort,
      event,
      finish,
      flush,
      metrics,
      push,
    });
  }

  function setStreamArriving(element, active) {
    element?.classList?.toggle("stream-arriving", Boolean(active));
    return element;
  }

  root.RappStreamPacing = Object.freeze({
    createStreamPacer,
    createTextSplitter,
    setStreamArriving,
    splitTextPieces,
  });
})(globalThis);
