(function registerTypingDelivery(root) {
  function createDelivery({
    onTyping = () => {},
    onDeliver = () => {},
    onError = () => {},
  } = {}) {
    let state = "open";
    let buffer = "";
    let typingStarted = false;

    function push(delta) {
      if (state !== "open") return false;
      buffer += String(delta ?? "");
      if (!typingStarted) {
        typingStarted = true;
        onTyping();
      }
      return true;
    }

    function tool(_event) {
      return state === "open";
    }

    function finish(finalText) {
      if (state !== "open") return false;
      state = "finished";
      const fullText = finalText === undefined || finalText === null
        ? buffer
        : String(finalText);
      buffer = "";
      onDeliver(fullText);
      return true;
    }

    function fail(error) {
      if (state !== "open") return false;
      state = "failed";
      buffer = "";
      onError(error);
      return true;
    }

    function abort() {
      if (state !== "open") return false;
      state = "aborted";
      buffer = "";
      return true;
    }

    return Object.freeze({
      push,
      tool,
      finish,
      fail,
      abort,
    });
  }

  root.RappTypingDelivery = Object.freeze({ createDelivery });
})(globalThis);
