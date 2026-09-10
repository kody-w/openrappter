(() => {
  const api = window.brainstemBeta;
  const dialog = document.getElementById("teams-dialog");
  const form = document.getElementById("teams-form");
  const open = document.getElementById("teams-open");
  const join = document.getElementById("teams-join");
  const stop = document.getElementById("teams-stop");
  const show = document.getElementById("teams-show");
  const say = document.getElementById("teams-say");
  const error = document.getElementById("teams-error");
  const url = document.getElementById("teams-url");
  const identity = document.getElementById("teams-identity");
  const flags = ["camera", "vision", "listen", "speak", "autonomous", "headless", "remember"];
  let state = { phase: "idle" };
  let pendingCommands = 0;
  let localError = "";
  const active = () => !["idle", "error"].includes(state.phase);
  const flagValues = () => Object.fromEntries(flags.map((name) => [
    name, document.getElementById(`teams-${name}`).checked,
  ]));

  function showError(cause) {
    localError = String(cause?.message || cause);
    error.textContent = localError;
    error.hidden = false;
  }

  function render(value) {
    if (!value) return;
    state = value;
    const connected = state.phase === "joined";
    const busy = pendingCommands > 0;
    open.textContent = active() ? `Teams: ${state.phase}` : "Meet now in Teams";
    document.getElementById("teams-status").textContent = state.message || state.phase;
    document.getElementById("teams-speech-health").textContent =
      state.speech?.phase || (state.speech?.ready ? "ready" : "Not prepared");
    document.getElementById("teams-media-health").textContent =
      `${state.receivedAudioSegments || 0} speech segments; ${state.receivedVideoFrames || 0} video frames`;
    document.getElementById("teams-transcript").textContent = state.lastTranscript || "None";
    document.getElementById("teams-reply").textContent = state.lastReply || "None";
    if (state.error || localError) {
      error.textContent = state.error || localError;
      error.hidden = false;
    }
    else { error.textContent = ""; error.hidden = true; }
    join.disabled = busy || active();
    stop.disabled = !active();
    show.disabled = busy || ["idle", "error", "preparing"].includes(state.phase);
    say.disabled = busy || state.speaking || !connected || !state.options?.speak;
    url.readOnly = active();
    identity.readOnly = active();
    if (active() && state.options?.identity) identity.value = state.options.identity;
    for (const name of flags) {
      const input = document.getElementById(`teams-${name}`);
      const canMute = name === "speak" && connected && state.options?.speak;
      input.disabled = (!canMute && busy) || (active() && (!connected || ["headless", "remember"].includes(name)));
      if (active() && typeof state.options?.[name] === "boolean") input.checked = state.options[name];
    }
  }

  async function run(command) {
    pendingCommands += 1;
    localError = "";
    render(state);
    try {
      const result = await api.teamsCommand(command);
      if (result?.phase) render(result);
      return result;
    } finally {
      pendingCommands -= 1;
      render(state);
    }
  }

  async function openPanel(autoJoin) {
    if (!dialog.open) dialog.showModal();
    if (active()) return;
    try {
      const preferences = await api.teamsPreferences();
      url.value = preferences.url || "";
      identity.value = preferences.identity;
      for (const name of flags) document.getElementById(`teams-${name}`).checked = preferences[name] === true;
      if (autoJoin && preferences.url) {
        await run({ action: "join", options: { ...preferences, speak: false } });
      } else {
        url.focus();
      }
    } catch (cause) {
      showError(cause);
    }
  }
  open.addEventListener("click", () => void openPanel(true));
  document.getElementById("teams-settings-open").addEventListener("click", () => void openPanel(false));
  document.getElementById("teams-close").addEventListener("click", () => dialog.close());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await run({
        action: "join",
        options: { url: url.value, identity: identity.value, ...flagValues() },
      });
    } catch (cause) {
      showError(cause);
    }
  });
  for (const name of ["camera", "vision", "listen", "speak", "autonomous"]) {
    document.getElementById(`teams-${name}`).addEventListener("change", async () => {
      if (state.phase !== "joined") return;
      try { await run({ action: "configure", options: flagValues() }); } catch (cause) { showError(cause); }
    });
  }
  stop.addEventListener("click", async () => {
    try { await run({ action: "stop" }); } catch (cause) { showError(cause); }
  });
  show.addEventListener("click", async () => {
    try { await run({ action: "show" }); } catch (cause) { showError(cause); }
  });
  document.getElementById("teams-forget").addEventListener("click", async () => {
    try {
      await run({ action: "forget" });
      document.getElementById("teams-remember").checked = false;
      if (!active()) url.value = "";
    } catch (cause) { showError(cause); }
  });
  say.addEventListener("click", async () => {
    try {
      await run({ action: "speak", text: document.getElementById("teams-speech-text").value });
    } catch (cause) { showError(cause); }
  });
  const unsubscribe = api.onState((next) => render(next.teams));
  window.addEventListener("pagehide", unsubscribe, { once: true });
  api.getState().then((next) => render(next.teams)).catch(showError);
})();
