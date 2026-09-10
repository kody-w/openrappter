async function runTeamsPageCommand(command) {
  if (location.protocol !== "https:"
      || !["teams.microsoft.com", "teams.live.com"].includes(location.hostname)) {
    throw new Error("The meeting page is outside its allowed Teams origin.");
  }
  const visible = (element) => element && element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== "hidden"
    && !element.closest('[aria-hidden="true"],[inert]');
  const label = (element) => {
    const labelledBy = element.getAttribute("aria-labelledby");
    const associated = labelledBy
      ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ")
      : "";
    return (element.getAttribute("aria-label")
      || associated
      || element.getAttribute("title")
      || [...(element.labels || [])].map((item) => item.textContent).join(" ")
      || element.textContent || "").trim();
  };
  const buttons = () => [...document.querySelectorAll('button,[role="button"]')].filter(visible);
  const button = (pattern) => buttons().find((element) => pattern.test(label(element)));
  const editor = () => [...document.querySelectorAll('[role="textbox"][contenteditable="true"]')].find(visible);
  const checked = (element) => element.checked === true || element.getAttribute("aria-checked") === "true";
  const normalize = (text) => text.replace(/\s+/gu, " ").trim();
  const media = () => window.__rappTeamsMedia?.status() || null;
  const describe = () => {
    const labels = buttons().map(label);
    if (labels.some((name) => /^leave\b/i.test(name))
        && labels.some((name) => /\b(chat|people|participants|reactions|raise hand)\b/i.test(name))) {
      const messages = [...document.querySelectorAll('[data-tid="chat-pane-message"][data-mid]')]
        .filter(visible).slice(-24).map((element) => {
          const id = element.getAttribute("data-mid");
          return {
            id,
            author: document.getElementById(`author-${id}`)?.textContent.trim() || "",
            text: element.innerText.trim().slice(0, 2000),
          };
        });
      return { stage: "joined", media: media(), messages, chatOpen: Boolean(editor()) };
    }
    const text = document.body?.innerText || "";
    const blocked = text.match(/(?:this|the) meeting (?:has ended|is locked)[^\n]*|you (?:were|have been)[^\n]*removed[^\n]*|you(?:'|\u2019)ve been removed[^\n]*|no one responded[^\n]*|you left the meeting[^\n]*/i);
    if (blocked) return { stage: "ended", notice: blocked[0].slice(0, 300) };
    const lobby = text.match(/someone (?:in the meeting )?(?:will|should)[^\n]*let you in[^\n]*|you(?:'|\u2019)re in the lobby[^\n]*|we(?:'|\u2019)ve let[^\n]*waiting[^\n]*/i);
    if (lobby) return { stage: "lobby", notice: lobby[0].slice(0, 300), media: media() };
    if (/verify (?:your )?identity|prove you(?:'|\u2019)re|sign in to join this meeting|browser (?:is )?not supported/i.test(text)) {
      return { stage: "attention", notice: "Teams requires sign-in, browser support, or human verification." };
    }
    if (button(/^Join meeting from this browser$/i)) return { stage: "launcher" };
    if (button(/^Continue without audio or video$/i)) return { stage: "media-denied", media: media() };
    if ([...document.querySelectorAll('input[placeholder="Type your name"]')].some(visible)) {
      return { stage: "prejoin", media: media() };
    }
    return { stage: "loading", media: media() };
  };

  if (command.action === "snapshot") return describe();
  if (command.action === "open-chat") {
    if (describe().stage !== "joined") throw new Error("The meeting is not joined.");
    if (!editor()) {
      const chat = button(/^Chat\b/i);
      if (!chat) throw new Error("The meeting chat control is unavailable.");
      chat.click();
    }
    const deadline = Date.now() + 10000;
    while (!editor() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!editor()) throw new Error("The meeting chat composer did not become available.");
    return describe();
  }
  if (command.action === "advance") {
    const state = describe();
    if (state.stage === "launcher") {
      button(/^Join meeting from this browser$/i).click();
      return { stage: "loading", action: "browser-selected" };
    }
    if (state.stage === "media-denied") {
      throw new Error("Teams rejected the virtual media devices. Physical capture remains blocked.");
    }
    if (state.stage !== "prejoin") return state;
    if (window.__rappMeetingJoinRequested) return { stage: "joining", media: media() };
    if (!window.__rappTeamsMedia) {
      throw new Error("The virtual media adapter did not load; joining is blocked.");
    }
    const name = [...document.querySelectorAll('input[placeholder="Type your name"]')].find(visible);
    if (name.value !== command.displayName) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(name, command.displayName);
      name.dispatchEvent(new Event("input", { bubbles: true }));
      name.dispatchEvent(new Event("change", { bubbles: true }));
      return { ...state, action: "name-entered" };
    }
    const computerAudio = [...document.querySelectorAll('input[type="radio"],[role="radio"]')]
      .find((element) => visible(element) && /^Computer audio$/i.test(label(element)));
    if (!computerAudio) throw new Error("The computer-audio option is unavailable.");
    if (!checked(computerAudio)) {
      computerAudio.click();
      return { ...state, action: "virtual-audio-selected" };
    }
    const switches = [...document.querySelectorAll('[role="switch"],input[type="checkbox"]')].filter(visible);
    const camera = switches.find((element) => /camera/i.test(label(element)));
    if (!camera) throw new Error("The virtual camera control is unavailable.");
    if (camera.disabled) throw new Error("Teams disabled the virtual camera.");
    if (checked(camera) !== command.camera) {
      camera.click();
      return { ...state, action: "camera-configured" };
    }
    const microphone = switches.find((element) => /\b(mic|microphone)\b/i.test(label(element)));
    if (microphone && checked(microphone) !== command.speak) {
      microphone.click();
      return { ...state, action: "microphone-configured" };
    }
    const join = button(/^Join now$/i);
    if (!join || join.disabled || join.getAttribute("aria-disabled") === "true") {
      const alerts = [...document.querySelectorAll('[role="alert"]')].filter(visible)
        .map((element) => element.textContent.trim()).filter(Boolean);
      if (alerts.length) throw new Error(`Teams blocked prejoin: ${alerts.join(" ").slice(0, 300)}`);
      return state;
    }
    window.__rappMeetingJoinRequested = true;
    join.click();
    return { stage: "joining", action: "join-requested", media: media() };
  }
  if (command.action === "set-controls") {
    if (describe().stage !== "joined") throw new Error("The meeting is not joined.");
    const controls = () => [...document.querySelectorAll('button,[role="button"],[role="switch"],input[type="checkbox"]')].filter(visible);
    async function setToggle(kind, desired, turnOn, turnOff) {
      const target = () => controls().find((element) => (desired ? turnOn : turnOff).test(label(element)));
      const inverse = () => controls().find((element) => (desired ? turnOff : turnOn).test(label(element)));
      let toggle = target();
      if (!toggle && inverse()) return;
      if (!toggle) {
        toggle = controls().find((element) => kind.test(label(element))
          && (element.getAttribute("role") === "switch" || element.hasAttribute("aria-pressed")));
        if (!toggle) throw new Error("The meeting's camera or microphone state could not be verified.");
        const current = toggle.getAttribute("aria-pressed") === "true" || checked(toggle);
        if (current === desired) return;
      }
      if (toggle.disabled || toggle.getAttribute("aria-disabled") === "true") {
        throw new Error("Teams disabled a requested virtual-media control.");
      }
      toggle.click();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (inverse()) return;
        const current = controls().find((element) => kind.test(label(element))
          && (element.getAttribute("role") === "switch" || element.hasAttribute("aria-pressed")));
        if (current && (current.getAttribute("aria-pressed") === "true" || checked(current)) === desired) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Teams did not confirm the requested virtual-media state.");
    }
    await setToggle(
      /\b(mic|microphone)\b/i,
      command.speak,
      /^(?:Unmute(?: (?:your|the))? (?:mic|microphone)|Turn on(?: (?:your|the))? (?:mic|microphone)|Turn(?: (?:your|the))? (?:mic|microphone) on)\b/i,
      /^(?:Mute(?: (?:your|the))? (?:mic|microphone)|Turn off(?: (?:your|the))? (?:mic|microphone)|Turn(?: (?:your|the))? (?:mic|microphone) off)\b/i,
    );
    await setToggle(
      /\b(camera|video)\b/i,
      command.camera,
      /^(?:Turn on(?: (?:your|the))? (?:camera|video)|Turn(?: (?:your|the))? (?:camera|video) on|Enable(?: (?:your|the))? (?:camera|video))\b/i,
      /^(?:Turn off(?: (?:your|the))? (?:camera|video)|Turn(?: (?:your|the))? (?:camera|video) off|Disable(?: (?:your|the))? (?:camera|video))\b/i,
    );
    return describe();
  }
  if (command.action === "send-chat") {
    if (describe().stage !== "joined") throw new Error("The meeting is not joined.");
    window.__rappMeetingReceipts ||= new Map();
    const prior = window.__rappMeetingReceipts.get(command.key);
    if (prior) {
      if (prior.status !== "sent") throw new Error("The previous send has an uncertain outcome; do not repeat it.");
      return prior;
    }
    const composer = editor();
    if (!composer) throw new Error("Open the meeting chat before sending.");
    if (composer.innerText.trim()) throw new Error("Refusing to overwrite an existing chat draft.");
    composer.focus();
    if (!document.execCommand("insertText", false, command.text)) {
      throw new Error("Teams did not accept text in the chat composer.");
    }
    const send = button(/^Send(?:\s|\(|$)/i);
    if (!send || send.disabled) throw new Error("The meeting Send button is unavailable.");
    window.__rappMeetingReceipts.set(command.key, { status: "unconfirmed" });
    send.click();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const message = [...document.querySelectorAll('[data-tid="chat-pane-message"][data-mid]')]
        .find((element) => visible(element) && normalize(element.innerText) === normalize(command.text));
      if (message && !composer.innerText.trim()) {
        const receipt = { status: "sent", messageId: message.getAttribute("data-mid") };
        window.__rappMeetingReceipts.set(command.key, receipt);
        if (window.__rappMeetingReceipts.size > 200) {
          window.__rappMeetingReceipts.delete(window.__rappMeetingReceipts.keys().next().value);
        }
        return receipt;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Chat delivery is unconfirmed. Read the meeting chat before attempting another send.");
  }
  throw new Error("Unsupported meeting-page operation.");
}

export function createTeamsPageControlSource(command) {
  if (!command || !["snapshot", "open-chat", "advance", "set-controls", "send-chat"].includes(command.action)) {
    throw new Error("A bounded meeting-page operation is required.");
  }
  if (command.action === "send-chat"
      && (typeof command.text !== "string" || !command.text.trim()
        || Buffer.byteLength(command.text, "utf8") > 2000
        || !/^[A-Za-z0-9_-]{1,100}$/.test(command.key || ""))) {
    throw new Error("Meeting chat requires bounded text and an idempotency key.");
  }
  if (command.action === "advance"
      && (typeof command.displayName !== "string" || command.displayName.length > 50
        || typeof command.camera !== "boolean" || typeof command.speak !== "boolean")) {
    throw new Error("Prejoin requires a bounded name and explicit virtual-media settings.");
  }
  if (command.action === "set-controls"
      && (typeof command.camera !== "boolean" || typeof command.speak !== "boolean")) {
    throw new Error("Explicit camera and microphone states are required.");
  }
  return `(${runTeamsPageCommand.toString()})(${JSON.stringify(command)})`;
}
