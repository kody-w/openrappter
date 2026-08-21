(function registerStreamFollow(root) {
  function createTailFollower({
    distanceFromBottom,
    pinToBottom,
    thresholdPx = 80,
  } = {}) {
    if (typeof distanceFromBottom !== "function") {
      throw new TypeError("distanceFromBottom must be a function.");
    }
    if (typeof pinToBottom !== "function") {
      throw new TypeError("pinToBottom must be a function.");
    }
    const threshold = Math.max(0, Number(thresholdPx) || 80);
    let active = false;
    let following = true;
    let completionPinned = false;

    function pin(reason) {
      pinToBottom(reason);
    }

    function start() {
      active = true;
      following = true;
      completionPinned = false;
      pin("start");
      return state();
    }

    function contentChanged() {
      if (active && following) pin("content");
      return state();
    }

    function handleScroll({ userInitiated = false } = {}) {
      if (!userInitiated) return state();
      following = Math.max(0, Number(distanceFromBottom()) || 0) <= threshold;
      if (active && following) pin("resume");
      return state();
    }

    function complete() {
      if (!completionPinned) {
        completionPinned = true;
        pin("complete");
      }
      active = false;
      return state();
    }

    function stop() {
      active = false;
      return state();
    }

    function state() {
      return Object.freeze({
        active,
        completionPinned,
        following,
        thresholdPx: threshold,
      });
    }

    return Object.freeze({
      complete,
      contentChanged,
      handleScroll,
      start,
      state,
      stop,
    });
  }

  root.RappStreamFollow = Object.freeze({ createTailFollower });
})(globalThis);
