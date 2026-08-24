(function installFrontierGrail(global) {
  "use strict";

  /** @typedef {'unknown'|'checking'|'ready'|'needs-sign-in'|'no-entitlement'|'offline'|'error'} AuthState */
  /** @typedef {'unknown'|'checking'|'ready'|'offline'|'error'} TransportState */
  /** @typedef {'idle'|'too-large'|'unsupported'|'ingesting'|'ready'|'error'} MediaState */

  const {
    LivingCompanyWeek,
    classifyMedia,
    createSemanticController,
    reviewImmutablePayload,
    truthfulUnavailable,
  } = global.OpenRappterGrailCore;
  const host = global.OpenRappterGrailHost;
  const nav = document.getElementById("grail-nav");
  const panel = document.getElementById("grail-surface-panel");
  const panelContent = document.getElementById("grail-surface-content");
  const panelClose = document.getElementById("grail-surface-close");
  const onboarding = document.getElementById("grail-onboarding");
  const onboardingContinue = document.getElementById("grail-onboarding-continue");
  const legacyButtons = document.querySelectorAll("[data-grail-legacy]");
  const mediaInput = document.getElementById("grail-media-input");
  const mediaStatus = document.getElementById("grail-media-status");
  const preferencesKey = "openrappter.grail.preferences.v1";
  const healthPath = "/health";
  let activeSurface = null;
  let restoreFocus = null;
  let transportState = { state: "unknown", message: "Patient transport has not been checked." };
  let authState = { state: "unknown", message: "Copilot auth has not been checked." };
  let modelState = { state: "unknown", message: "Copilot model has not been checked." };
  let ringState = { state: "unknown", message: "Release ring adapter is not installed." };
  let detectorState = { state: "unknown", message: "Clever Girl v3 adapter is not installed." };
  let adaptiveTwinState = { state: "unknown", message: "Adaptive twin adapter is not installed." };
  let skillsState = { state: "unknown", message: "Skills have not been discovered." };
  let channelsState = { state: "unknown", message: "Optional channels have not been checked." };
  let mediaIngestState = { state: "idle", message: "No media selected." };
  let releasePreview = null;

  const SURFACES = Object.freeze({
    "operating-room": { title: "Operating Room", description: "Whole-organism patient, model, transport, and dependency state." },
    "quantum-rappids": { title: "Quantum RAPPIDs", description: "The real Frontier herd, arena, twins, versions, and rollback habitat." },
    chat: { title: "Chat", description: "Authenticated OpenRappter chat over the existing gateway RPC." },
    "show-and-tell": { title: "Show & Tell", description: "Consent-gated workflow recording through the existing desktop service." },
    channels: { title: "Channels", description: "Configured messaging channels from the gateway." },
    sessions: { title: "Sessions", description: "Existing local conversation sessions." },
    agents: { title: "Agents", description: "Registered first-party OpenRappter agents." },
    skills: { title: "Skills", description: "Installed local and ClawHub skills." },
    cron: { title: "Cron", description: "Scheduled jobs and receipts." },
    showcase: { title: "Showcase", description: "Deterministic first-party orchestration showcases." },
    zen: { title: "Zen", description: "Quiet-focus sessions." },
    accounts: { title: "Accounts", description: "Copilot readiness and account adapter status." },
    config: { title: "Config", description: "Immutable review status for current configuration." },
    devices: { title: "Devices", description: "Authenticated gateway device connections." },
    health: { title: "Health", description: "Real /health patient transport." },
    logs: { title: "Logs", description: "Redacted gateway log evidence." },
    "living-company": { title: "Living Company", description: "Local, draft-only company operations and deterministic fixture week." },
  });

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function stateBadge(label, value) {
    return `<div class="grail-card grail-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value.state)}</strong>
      <p>${escapeHtml(value.message)}</p>
    </div>`;
  }

  function updateStatusRail() {
    const states = [
      ["patient-transport-status", transportState],
      ["copilot-auth-status", authState],
      ["copilot-model-status", modelState],
      ["release-ring-status", ringState],
      ["detector-v3-status", detectorState],
      ["adaptive-twin-status", adaptiveTwinState],
    ];
    for (const [id, value] of states) {
      const element = document.getElementById(id);
      if (!element) continue;
      element.dataset.state = value.state;
      const output = element.querySelector("strong");
      if (output) output.textContent = value.state;
      element.title = value.message;
    }
  }

  async function rpc(method, params = {}) {
    if (!host?.rpc) throw new Error(`RPC ${method} is unavailable without a gateway adapter.`);
    return host.rpc(method, params);
  }

  async function refreshPatientTransport() {
    transportState = { state: "checking", message: `Checking ${healthPath}…` };
    updateStatusRail();
    try {
      const health = await host.health();
      if (!health || !["ok", "degraded"].includes(health.status)) {
        throw new Error("Patient transport returned an unhealthy response.");
      }
      transportState = {
        state: "ready",
        message: `Patient ${health.status}; version ${health.version || "unknown"}.`,
        health,
      };
    } catch (cause) {
      transportState = {
        state: /offline|network|fetch|connect/i.test(String(cause?.message || cause))
          ? "offline"
          : "error",
        message: String(cause?.message || cause),
      };
    }
    updateStatusRail();
    updateOnboarding();
    return transportState;
  }

  async function refreshCopilotState() {
    authState = { state: "checking", message: "Checking Copilot auth…" };
    modelState = { state: "checking", message: "Checking Copilot model…" };
    updateStatusRail();
    try {
      const auth = await rpc("auth.status");
      authState = {
        state: auth?.status || "error",
        message: auth?.message || "Auth service returned no message.",
        code: auth?.code,
      };
    } catch (cause) {
      authState = truthfulUnavailable("Copilot auth", cause);
      authState.state = "unknown";
    }
    try {
      const backend = await rpc("backend.status");
      modelState = backend?.ready === true || backend?.status === "ready"
        ? { state: "ready", message: backend.model || "Copilot model ready." }
        : truthfulUnavailable("Copilot model", "Backend did not report a verified ready model.");
    } catch (cause) {
      modelState = truthfulUnavailable("Copilot model", cause);
    }
    updateStatusRail();
    updateOnboarding();
  }

  async function refreshDependencies() {
    const checks = [
      ["rings.get", (value) => {
        ringState = value?.selectedRing && value?.resolved
          ? {
              state: "ready",
              message:
                `Ring ${value.selectedRing}; ${value.resolved.status}; `
                + `version ${value.resolved.version || "unavailable"}.`,
              value,
            }
          : truthfulUnavailable("Release ring", "No closed ring state returned.");
      }, (error) => { ringState = truthfulUnavailable("Release ring", error); }],
      ["clever-girl.status", (value) => {
        detectorState = value?.version
          ? { state: "ready", message: `Clever Girl ${value.version} packaged CLI ready.` }
          : truthfulUnavailable("Clever Girl v3", "Packaged CLI status unavailable.");
      }, (error) => { detectorState = truthfulUnavailable("Clever Girl v3", error); }],
      ["twin.versions", (value) => {
        adaptiveTwinState = Array.isArray(value?.versions)
          ? { state: "ready", message: `${value.versions.length} adaptive twin versions; rollback adapter ready.` }
          : truthfulUnavailable("Adaptive twin", "Version/rollback response unavailable.");
      }, (error) => { adaptiveTwinState = truthfulUnavailable("Adaptive twin", error); }],
    ];
    for (const [method, success, failure] of checks) {
      try {
        success(await rpc(method));
      } catch (cause) {
        failure(cause);
      }
      try {
        const skills = await rpc("skills.list");
        skillsState = Array.isArray(skills)
          ? { state: "ready", message: `${skills.length} local skills discovered.` }
          : truthfulUnavailable("Skills", "Gateway returned no skills list.");
      } catch (cause) {
        skillsState = truthfulUnavailable("Skills", cause);
      }
      try {
        const channels = await rpc("channels.list");
        channelsState = Array.isArray(channels)
          ? { state: "ready", message: `${channels.length} optional channels configured.` }
          : truthfulUnavailable("Channels", "Gateway returned no channel list.");
      } catch (cause) {
        channelsState = truthfulUnavailable("Channels", cause);
      }
    }
    updateStatusRail();
    updateOnboarding();
  }

  const companyWeek = new LivingCompanyWeek();

  async function loadRpcSurface(method, params = {}) {
    try {
      return { status: "ready", value: await rpc(method, params) };
    } catch (cause) {
      return truthfulUnavailable(method, cause?.message || cause);
    }
  }

  function renderResult(result) {
    const body = result.status === "ready"
      ? JSON.stringify(result.value, null, 2)
      : `${result.name}: ${result.reason}`;
    return `<div class="grail-card ${result.status === "ready" ? "" : "grail-callout error"}">
      <pre>${escapeHtml(body)}</pre>
    </div>`;
  }

  async function renderSurface(id) {
    const spec = SURFACES[id];
    if (!spec) return;
    activeSurface = id;
    const url = new URL(location.href);
    url.searchParams.set("view", id);
    history.replaceState(null, "", url);
    for (const button of nav.querySelectorAll("button[data-surface]")) {
      button.setAttribute(
        "aria-current",
        button.dataset.surface === id ? "page" : "false",
      );
    }
    panel.classList.add("open");
    panelContent.innerHTML = `<section class="grail-surface">
      <header>
        <div><h1>${escapeHtml(spec.title)}</h1><p>${escapeHtml(spec.description)}</p></div>
      </header>
      <div id="grail-surface-body" class="grail-grid">
        <div class="grail-card">Loading real state…</div>
      </div>
    </section>`;
    const body = panelContent.querySelector("#grail-surface-body");

    if (id === "operating-room") {
      body.innerHTML = [
        stateBadge("Patient transport", transportState),
        stateBadge("Copilot auth", authState),
        stateBadge("Copilot model", modelState),
        stateBadge("Release ring", ringState),
        stateBadge("Clever Girl v3", detectorState),
        stateBadge("Adaptive twins", adaptiveTwinState),
        `<div id="grail-about-boundary" class="grail-card">
          <h2>OpenRappter Personal / RapterOS boundary</h2>
          <p>OpenRappter is the Apache-2.0 personal organism. Hosted licensed
          RapterOS tenancy and training are separate; no private control-plane
          implementation is bundled here.</p>
        </div>`,
      ].join("");
      return;
    }

    if (id === "chat") {
      body.innerHTML = `<div class="grail-card" style="grid-column:1/-1">
        <h2>OpenRappter Chat</h2>
        <div id="grail-chat-log" role="log" aria-live="polite"></div>
        <textarea id="grail-chat-input" rows="4" placeholder="Message OpenRappter"></textarea>
        <div class="grail-actions"><button id="grail-chat-send">Send</button></div>
      </div>`;
      const send = body.querySelector("#grail-chat-send");
      const input = body.querySelector("#grail-chat-input");
      const log = body.querySelector("#grail-chat-log");
      const blocked = authState.state !== "ready" || modelState.state !== "ready";
      input.disabled = blocked;
      send.disabled = blocked;
      if (blocked) {
        log.textContent = `Copilot unavailable: ${authState.message} ${modelState.message}`;
      }
      send.addEventListener("click", async () => {
        const message = input.value.trim();
        if (!message || blocked) return;
        send.disabled = true;
        try {
          const result = await rpc("agent", { message });
          log.textContent = result?.content || JSON.stringify(result);
        } catch (cause) {
          log.textContent = `Chat failed: ${String(cause?.message || cause)}`;
        } finally {
          send.disabled = blocked;
        }
      });
      return;
    }

    if (id === "living-company") {
      const state = companyWeek.snapshot();
      body.innerHTML = `<div class="grail-card" style="grid-column:1/-1">
        <h2>Living Company Week</h2>
        <p>Status: ${escapeHtml(state.status)} · external side effects:
          <strong>${state.externalSideEffects}</strong></p>
        <div class="grail-actions">
          <button id="company-week-step">Advance fixture day</button>
          <button id="company-week-run">Run fixture week</button>
          <button id="company-week-reset">Reset</button>
        </div>
        <pre id="company-week-ledger">${escapeHtml(JSON.stringify(state, null, 2))}</pre>
      </div>`;
      const update = () => {
        body.querySelector("#company-week-ledger").textContent =
          JSON.stringify(companyWeek.snapshot(), null, 2);
      };
      body.querySelector("#company-week-step").addEventListener("click", () => {
        companyWeek.step();
        update();
      });
      body.querySelector("#company-week-run").addEventListener("click", () => {
        companyWeek.run();
        update();
      });
      body.querySelector("#company-week-reset").addEventListener("click", () => {
        companyWeek.reset();
        update();
      });
      return;
    }

    if (id === "show-and-tell") {
      try {
        const value = await host.showAndTell({ action: "status" });
        body.innerHTML = renderResult({ status: "ready", value });
      } catch (cause) {
        body.innerHTML = renderResult(truthfulUnavailable("Show & Tell", cause));
      }
      return;
    }

    if (id === "quantum-rappids") {
      try {
        const value = global.brainstemBeta?.tilesList
          ? await global.brainstemBeta.tilesList()
          : null;
        body.innerHTML = (value
          ? renderResult({ status: "ready", value })
          : renderResult(truthfulUnavailable("Quantum RAPPIDs", "Habitat adapter unavailable.")))
          + `<div class="grail-card">
              <h2>Whole-organism egg</h2>
              <div class="grail-actions">
                <button id="grail-egg-export">Export egg</button>
                <button id="grail-egg-import">Import approved egg</button>
              </div>
              <p id="whole-organism-egg-status" role="status">
                Awaiting the first-party egg adapter.
              </p>
            </div>`;
        const eggStatus = body.querySelector("#whole-organism-egg-status");
        body.querySelector("#grail-egg-export").addEventListener("click", async () => {
          try {
            const result = await global.brainstemBeta.openrappterTileExport();
            eggStatus.textContent = result?.message || "Egg export completed.";
          } catch (cause) {
            eggStatus.textContent =
              `Egg export unavailable: ${String(cause?.message || cause)}`;
          }
        });
        body.querySelector("#grail-egg-import").addEventListener("click", async () => {
          try {
            const result = await global.brainstemBeta.openrappterTileImport();
            eggStatus.textContent = result?.message
              || "Approved egg import completed through the native adapter.";
          } catch (cause) {
            eggStatus.textContent =
              `Egg import unavailable: ${String(cause?.message || cause)}`;
          }
        });
      } catch (cause) {
        body.innerHTML = renderResult(truthfulUnavailable("Quantum RAPPIDs", cause));
      }
      return;
    }

    const rpcBySurface = {
      channels: "channels.list",
      sessions: "chat.list",
      agents: "agents.list",
      skills: "skills.list",
      cron: "cron.list",
      showcase: "showcase.list",
      zen: "zen.sessions",
      accounts: "auth.status",
      devices: "connections.list",
      health: "health",
      logs: "logs.get",
      config: "config.get",
    };
    const method = rpcBySurface[id];
    if (!method) {
      body.innerHTML = renderResult(truthfulUnavailable(id, "No first-party adapter is registered."));
      return;
    }
    if (id === "health") {
      body.innerHTML = renderResult(
        transportState.state === "ready"
          ? { status: "ready", value: transportState.health }
          : truthfulUnavailable("Patient /health", transportState.message),
      );
      return;
    }
    const result = await loadRpcSurface(method);
    if (id === "config" && result.status === "ready") {
      const reviewed = await reviewImmutablePayload(
        "config.set",
        { raw: result.value?.raw || "", format: result.value?.format || "yaml" },
        result.value?.hash || "",
      );
      body.innerHTML = `<div class="grail-card">
        <h2>Immutable review only</h2>
        <p>payloadHash: ${escapeHtml(reviewed.payloadHash)}</p>
        <p>baseHash: ${escapeHtml(reviewed.baseHash)}</p>
        <p>Applying configuration requires the first-party approval service.</p>
      </div>`;
      return;
    }
    body.innerHTML = renderResult(result);
  }

  function closeSurface() {
    panel.classList.remove("open");
    activeSurface = null;
    restoreFocus?.focus?.();
    restoreFocus = null;
  }

  async function openLegacy() {
    const url = host?.legacyUrl || "./legacy/index.html";
    try {
      const response = await fetch(url, { method: "HEAD" });
      if (!response.ok) throw new Error(`Legacy returned HTTP ${response.status}.`);
      location.href = url;
    } catch (cause) {
      const status = document.getElementById("grail-onboarding-status");
      status.textContent =
        `Legacy OpenRappter is unavailable in this build: ${String(cause?.message || cause)}`;
    }
  }

  function onboardingComplete() {
    return (
      transportState.state === "ready"
      && authState.state === "ready"
      && modelState.state === "ready"
      && ringState.state === "ready"
      && skillsState.state === "ready"
    );
  }

  function updateOnboarding() {
    const status = document.getElementById("grail-onboarding-status");
    const complete = onboardingComplete();
    onboardingContinue.disabled = !complete;
    status.textContent = complete
      ? "Gateway, Copilot, model, and stable ring are verified."
      : `Not ready: transport=${transportState.state}, auth=${authState.state}, model=${modelState.state}, ring=${ringState.state}, skills=${skillsState.state}. Optional channels=${channelsState.state}.`;
  }

  function openOnboarding() {
    restoreFocus = document.activeElement;
    for (const element of document.querySelectorAll(
      "body > :not(#grail-onboarding):not(script)",
    )) {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }
    onboarding.classList.add("open");
    onboarding.removeAttribute("inert");
    onboarding.focus();
    updateOnboarding();
  }

  function closeOnboarding() {
    if (!onboardingComplete()) return;
    onboarding.classList.remove("open");
    onboarding.setAttribute("inert", "");
    for (const element of document.querySelectorAll(
      "body > [aria-hidden='true']",
    )) {
      element.inert = false;
      element.removeAttribute("aria-hidden");
    }
    try {
      localStorage.setItem(preferencesKey, JSON.stringify({
        version: 1,
        onboardingComplete: true,
        shell: "grail",
        ring: "stable",
      }));
      localStorage.setItem("rapp-brainstem-beta-intro-v1", "seen");
    } catch {
      // Preference persistence failure does not fabricate readiness.
    }
    document.getElementById("intro")?.classList.add("hidden");
    restoreFocus?.focus?.();
    restoreFocus = null;
  }

  function handleMedia(file) {
    if (!file) return;
    mediaIngestState = classifyMedia(file);
    if (mediaIngestState.state === "ingesting") {
      mediaIngestState = truthfulUnavailable(
        "Large media ingest",
        "The large-media dependency has not merged; no bytes were uploaded.",
      );
      mediaIngestState.state = "unsupported";
    }
    mediaStatus.dataset.state = mediaIngestState.state;
    mediaStatus.textContent = `${mediaIngestState.state}: ${mediaIngestState.message}`;
  }

  function applyContrast(value) {
    const allowed = ["dark", "light", "high-contrast"];
    if (!allowed.includes(value)) return;
    document.documentElement.dataset.contrast = value;
  }

  function semanticSnapshot() {
    return Object.freeze({
      schema: "openrappter-grail-semantic/1.0",
      shell: "grail",
      activeSurface,
      surfaces: Object.keys(SURFACES),
      transport: transportState.state,
      auth: authState.state,
      model: modelState.state,
      media: mediaIngestState.state,
      companyWeek: companyWeek.snapshot(),
    });
  }

  function semanticOpen(surface) {
    if (!Object.hasOwn(SURFACES, surface)) {
      throw new Error(`Unknown Grail surface: ${String(surface)}`);
    }
    return renderSurface(surface).then(semanticSnapshot);
  }

  global.openrappterGrailSemantic = createSemanticController(
    Object.keys(SURFACES),
    semanticSnapshot,
    renderSurface,
  );

  global.__openrappterDesktopCommand = async (command = {}) => {
    const action = String(command.action || "snapshot");
    const args = command.args || {};
    if (action === "snapshot" || action === "desktop_state") {
      return {
        view: activeSurface || "operating-room",
        shell: "grail",
        state: semanticSnapshot(),
        text: document.body.innerText.slice(0, 12000),
        elements: [],
      };
    }
    if (action === "navigate" || action === "open_app") {
      const requested = String(args.view || args.appId || "");
      const aliases = {
        presence: "health",
        "show-and-tell": "show-and-tell",
      };
      const surface = aliases[requested] || requested;
      await semanticOpen(surface);
      return { view: requested, shell: "grail", state: semanticSnapshot() };
    }
    if (action === "company_state") return companyWeek.snapshot();
    if (action === "company_scenario") {
      const operation = String(args.operation || "");
      if (operation === "start" || operation === "reset") companyWeek.reset();
      else if (operation === "step") companyWeek.step();
      else if (operation === "run" || operation === "replay") {
        if (operation === "replay") companyWeek.reset();
        companyWeek.run();
      } else {
        throw new Error(`Unknown Living Company operation: ${operation}`);
      }
      return companyWeek.snapshot();
    }
    throw new Error(`Unsupported Grail semantic action: ${action}`);
  };

  function wireEvents() {
    const navToggle = document.getElementById("grail-nav-toggle");
    navToggle.addEventListener("click", () => {
      const open = document.body.classList.toggle("grail-nav-open");
      navToggle.setAttribute("aria-expanded", String(open));
    });
    nav.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-surface]");
      if (!button) return;
      restoreFocus = button;
      void renderSurface(button.dataset.surface);
      document.body.classList.remove("grail-nav-open");
      navToggle.setAttribute("aria-expanded", "false");
    });
    panelClose.addEventListener("click", closeSurface);
    for (const button of legacyButtons) {
      button.addEventListener("click", () => void openLegacy());
    }
    for (const button of document.querySelectorAll("[data-grail-contrast]")) {
      button.addEventListener("click", () => applyContrast(button.dataset.grailContrast));
    }
    document.getElementById("grail-onboarding-open")
      .addEventListener("click", openOnboarding);
    onboardingContinue.addEventListener("click", closeOnboarding);
    mediaInput.addEventListener("change", () => handleMedia(mediaInput.files?.[0]));
    const ringSelect = document.getElementById("grail-ring-select");
    const ringApply = document.getElementById("grail-ring-apply");
    const ringDowngrade = document.getElementById("grail-ring-downgrade");
    const ringMessage = document.getElementById("grail-ring-message");
    ringSelect.addEventListener("change", async () => {
      ringApply.disabled = true;
      ringDowngrade.checked = false;
      releasePreview = null;
      ringMessage.textContent =
        `${ringSelect.value} selected. Resolving the closed ring pointer…`;
      try {
        releasePreview = await rpc("rings.preview", {
          ring: ringSelect.value,
        });
        const needsDowngrade = releasePreview.olderThanCurrent === true;
        ringMessage.textContent =
          `${releasePreview.status}; version ${releasePreview.version || "unavailable"}. `
          + "Selection alone changes nothing.";
        ringApply.disabled =
          releasePreview.canApply !== true || needsDowngrade;
      } catch (cause) {
        ringMessage.textContent =
          `Release preview unavailable: ${String(cause?.message || cause)}`;
      }
    });
    ringDowngrade.addEventListener("change", () => {
      ringApply.disabled =
        releasePreview?.canApply !== true ||
        (releasePreview?.olderThanCurrent === true && !ringDowngrade.checked);
    });
    ringApply.addEventListener("click", async () => {
      ringApply.disabled = true;
      try {
        const result = await rpc("rings.apply", {
          ring: ringSelect.value,
          allowDowngrade: ringDowngrade.checked,
        });
        ringMessage.textContent = result?.applied === true
          ? `${result.selectedRing} saved for the next update. No package was downloaded.`
          : "Release adapter returned no applied pointer; nothing changed.";
        await refreshDependencies();
      } catch (cause) {
        ringMessage.textContent =
          `Release Apply unavailable: ${String(cause?.message || cause)}`;
      } finally {
        ringApply.disabled = false;
      }
    });
    onboarding.addEventListener("keydown", (event) => {
      event.stopPropagation();
      const focusable = [
        ...onboarding.querySelectorAll("button:not([disabled]), input:not([disabled])"),
      ];
      if (event.key === "Escape") {
        event.preventDefault();
        onboarding.querySelector("[data-grail-legacy]")?.focus();
        document.getElementById("grail-onboarding-status").textContent =
          "Setup remains open. Legacy OpenRappter is focused.";
        return;
      }
      if (event.key !== "Tab" || focusable.length === 0) return;
      const current = focusable.indexOf(document.activeElement);
      if (event.shiftKey && current <= 0) {
        event.preventDefault();
        focusable.at(-1).focus();
      } else if (!event.shiftKey && current === focusable.length - 1) {
        event.preventDefault();
        focusable[0].focus();
      } else if (current < 0) {
        event.preventDefault();
        (event.shiftKey ? focusable.at(-1) : focusable[0]).focus();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && panel.classList.contains("open")) closeSurface();
    });
  }

  async function initialize() {
    wireEvents();
    updateStatusRail();
    try {
      if (localStorage.getItem("openrappter.shell") === "legacy") {
        await openLegacy();
        return;
      }
    } catch {
      // Unreadable migration preference retains Grail and shows onboarding.
    }
    const hasPreference = (() => {
      try {
        return JSON.parse(localStorage.getItem(preferencesKey) || "null")
          ?.onboardingComplete === true;
      } catch {
        return false;
      }
    })();
    if (!hasPreference) openOnboarding();
    else document.getElementById("intro")?.classList.add("hidden");
    await Promise.all([
      refreshPatientTransport(),
      refreshCopilotState(),
      refreshDependencies(),
    ]);
    const requested = new URL(location.href).searchParams.get("view");
    await renderSurface(Object.hasOwn(SURFACES, requested)
      ? requested
      : "operating-room");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void initialize(), {
      once: true,
    });
  } else {
    void initialize();
  }
})(window);
