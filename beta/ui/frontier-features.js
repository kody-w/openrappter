(function installFrontierFeatures(global) {
  "use strict";

  const {
    LivingCompanyWeek,
    classifyMedia,
    createSemanticController,
    reviewImmutablePayload,
    truthfulUnavailable,
  } = global.OpenRappterFrontierCore;
  const host = global.OpenRappterFrontierHost;
  const dialog = document.getElementById("frontier-features");
  const openButton = document.getElementById("frontier-features-tab");
  const closeButton = document.getElementById("frontier-features-close");
  const legacyButton = document.getElementById("frontier-legacy-patient");
  const nav = document.getElementById("frontier-feature-nav");
  const content = document.getElementById("frontier-feature-content");
  const companyWeek = new LivingCompanyWeek();
  let activeFeature = null;
  let restoreFocus = null;
  let ringPreview = null;

  const FEATURES = Object.freeze({
    "organism-status": {
      title: "Organism status",
      description: "Gateway, Copilot authentication, and active model evidence.",
    },
    "clever-girl": {
      title: "Clever Girl",
      description: "Packaged detector status through its first-party RPC.",
    },
    "release-rings": {
      title: "Release rings",
      description: "Closed ring pointers, preview, explicit apply, and receipts.",
    },
    "quantum-rappids": {
      title: "Grail / Quantum RAPPIDs",
      description: "The existing Frontier herd and real local twin habitat.",
    },
    "living-company": {
      title: "Living Company",
      description: "Truthful company seams plus the deterministic private fixture week.",
    },
    "organism-egg": {
      title: "Whole-organism egg",
      description: "Import and export only through the approved organism-egg bridge.",
    },
    "adaptive-twins": {
      title: "Adaptive twins",
      description: "Current twins and version/rollback adapter status.",
    },
    "large-media": {
      title: "Large media",
      description: "Local media classification and approved ingest adapter state.",
    },
    voice: {
      title: "Voice & ElevenLabs",
      description: "Continuous voice and provider state; controls remain in the chat toolbar.",
    },
    about: {
      title: "About OpenRappter",
      description: "Open-core rights and the separate hosted-business boundary.",
    },
    "show-and-tell": {
      title: "Show & Tell",
      description: "Consent-gated workflow recording through the existing desktop bridge.",
    },
    agents: {
      title: "Agents",
      description: "Registered OpenRappter agents; primary controls remain in the chat toolbar.",
    },
    skills: {
      title: "Skills",
      description: "Installed local skills from the authenticated gateway.",
    },
  });

  const COMPANY_MODULES = Object.freeze([
    ["Engineering", "system.status"],
    ["Release Operations", "rings.get"],
    ["Customer Signals", "channels.status"],
    ["Documentation", "docs.status"],
    ["Expenses", "expenses.drafts.list"],
    ["Decisions", "decisions.list"],
    ["RAPP Estate Health", "estate.buddies.list"],
  ]);

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  async function rpc(method, params = {}) {
    if (!host?.rpc) throw new Error(`${method} has no authenticated gateway adapter.`);
    return host.rpc(method, params);
  }

  async function attempt(name, operation) {
    try {
      return { status: "ready", name, value: await operation() };
    } catch (cause) {
      return truthfulUnavailable(name, cause?.message || cause);
    }
  }

  function card(label, result) {
    const state = result.status === "ready"
      ? "ready"
      : result.state || result.status || "unavailable";
    const detail = result.status === "ready"
      ? JSON.stringify(result.value, null, 2)
      : result.reason || result.message || "No approved adapter is installed.";
    return `<article class="frontier-card" data-state="${escapeHtml(state)}">
      <h2>${escapeHtml(label)}</h2>
      <strong>${escapeHtml(state)}</strong>
      <p>${escapeHtml(detail)}</p>
    </article>`;
  }

  function featureFrame(spec) {
    content.innerHTML = `<article class="frontier-feature">
      <header><h1>${escapeHtml(spec.title)}</h1><p>${escapeHtml(spec.description)}</p></header>
      <div id="frontier-feature-body" class="frontier-grid">
        <div class="frontier-card">Loading real state…</div>
      </div>
    </article>`;
    return content.querySelector("#frontier-feature-body");
  }

  function setFeatureInUrl(feature) {
    const url = new URL(location.href);
    url.searchParams.set("view", feature);
    history.replaceState(null, "", url);
  }

  async function renderStatus(body) {
    const [health, auth, model] = await Promise.all([
      attempt("/health", () => host.health()),
      attempt("Copilot auth", () => rpc("auth.status")),
      attempt("Copilot model", () => rpc("backend.status")),
    ]);
    body.innerHTML = [
      card("Gateway /health", health),
      card("Copilot auth", auth),
      card("Copilot model", model),
    ].join("");
  }

  async function renderCleverGirl(body) {
    body.innerHTML = card(
      "Clever Girl v3",
      await attempt("Clever Girl v3", () => rpc("clever-girl.status")),
    );
  }

  async function renderReleaseRings(body) {
    const state = await attempt("Release rings", () => rpc("rings.get"));
    body.innerHTML = `${card("Current ring", state)}
      <article class="frontier-card">
        <h2>Preview and apply</h2>
        <p>Selection changes nothing. Non-stable or older rings require explicit acknowledgement.</p>
        <div class="frontier-actions">
          <select id="frontier-ring-select" aria-label="Release ring">
            <option value="stable">stable</option>
            <option value="beta">beta</option>
            <option value="canary">canary</option>
            <option value="alpha">alpha</option>
            <option value="nightly">nightly</option>
          </select>
          <button id="frontier-ring-preview" type="button">Preview</button>
          <label><input id="frontier-ring-confirm" type="checkbox">
            I reviewed this ring and any downgrade warning.</label>
          <button id="frontier-ring-apply" type="button" disabled>Apply for next update</button>
        </div>
        <pre id="frontier-ring-result" class="frontier-result">No preview requested.</pre>
      </article>`;
    const select = body.querySelector("#frontier-ring-select");
    const previewButton = body.querySelector("#frontier-ring-preview");
    const confirm = body.querySelector("#frontier-ring-confirm");
    const applyButton = body.querySelector("#frontier-ring-apply");
    const result = body.querySelector("#frontier-ring-result");
    const invalidate = () => {
      ringPreview = null;
      confirm.checked = false;
      applyButton.disabled = true;
      result.textContent = "Selection changed. Preview and review again.";
    };
    select.addEventListener("change", invalidate);
    previewButton.addEventListener("click", async () => {
      previewButton.disabled = true;
      try {
        ringPreview = await rpc("rings.preview", { ring: select.value });
        result.textContent = JSON.stringify(ringPreview, null, 2);
        const warning = select.value !== "stable" || ringPreview?.olderThanCurrent === true;
        applyButton.disabled = ringPreview?.canApply !== true || (warning && !confirm.checked);
      } catch (cause) {
        ringPreview = null;
        result.textContent = `Preview unavailable: ${String(cause?.message || cause)}`;
      } finally {
        previewButton.disabled = false;
      }
    });
    confirm.addEventListener("change", () => {
      const warning = select.value !== "stable" || ringPreview?.olderThanCurrent === true;
      applyButton.disabled = ringPreview?.canApply !== true || (warning && !confirm.checked);
    });
    applyButton.addEventListener("click", async () => {
      applyButton.disabled = true;
      try {
        const receipt = await rpc("rings.apply", {
          ring: select.value,
          allowDowngrade: ringPreview?.olderThanCurrent === true && confirm.checked,
        });
        result.textContent = receipt?.applied === true
          ? JSON.stringify(receipt, null, 2)
          : "No applied receipt was returned; nothing changed.";
      } catch (cause) {
        result.textContent = `Apply unavailable: ${String(cause?.message || cause)}`;
      }
    });
  }

  async function renderQuantumRappids(body) {
    const twins = await attempt("Quantum RAPPIDs", async () => {
      if (!Object.hasOwn(global.brainstemBeta || {}, "twinList")) {
        throw new Error("The native twin habitat is unavailable in this host.");
      }
      return global.brainstemBeta.twinList();
    });
    body.innerHTML = `${card("Live Frontier twins", twins)}
      <article class="frontier-card">
        <h2>Grail habitat</h2>
        <p>Open the existing GitHub Copilot herd control to hatch and steer RAPPIDs. This panel does not duplicate that loop.</p>
      </article>`;
  }

  async function renderLivingCompany(body) {
    const modules = await Promise.all(COMPANY_MODULES.map(async ([name, method]) => [
      name,
      await attempt(name, () => rpc(method)),
    ]));
    const snapshot = companyWeek.snapshot();
    body.innerHTML = `${modules.map(([name, result]) => card(name, result)).join("")}
      <article class="frontier-card" style="grid-column:1/-1">
        <h2>Living Company Week · local fixture</h2>
        <p>Deterministic, replayable, redacted, and zero external side effects.</p>
        <div class="frontier-actions">
          <button id="frontier-company-step" type="button">Advance day</button>
          <button id="frontier-company-run" type="button">Run week</button>
          <button id="frontier-company-reset" type="button">Reset</button>
        </div>
        <pre id="frontier-company-ledger" class="frontier-result">${escapeHtml(JSON.stringify(snapshot, null, 2))}</pre>
      </article>`;
    const update = () => {
      body.querySelector("#frontier-company-ledger").textContent =
        JSON.stringify(companyWeek.snapshot(), null, 2);
    };
    body.querySelector("#frontier-company-step").addEventListener("click", () => {
      companyWeek.step();
      update();
    });
    body.querySelector("#frontier-company-run").addEventListener("click", () => {
      companyWeek.run();
      update();
    });
    body.querySelector("#frontier-company-reset").addEventListener("click", () => {
      companyWeek.reset();
      update();
    });
  }

  function exactNativeAdapter(name) {
    const bridge = global.brainstemBeta;
    return bridge && Object.hasOwn(bridge, name) ? bridge[name].bind(bridge) : null;
  }

  async function renderOrganismEgg(body) {
    const exportEgg = exactNativeAdapter("organismEggExport");
    const importEgg = exactNativeAdapter("organismEggImport");
    body.innerHTML = `<article class="frontier-card" data-state="${exportEgg && importEgg ? "ready" : "unavailable"}">
      <h2>Approved egg bridge</h2>
      <strong>${exportEgg && importEgg ? "ready" : "unavailable"}</strong>
      <p>${exportEgg && importEgg
        ? "Native whole-organism import/export is available."
        : "Whole-organism egg support is not installed. Tile and twin eggs are different formats and are not substituted."}</p>
      <div class="frontier-actions">
        <button id="frontier-egg-export" type="button" ${exportEgg ? "" : "disabled"}>Export egg</button>
        <button id="frontier-egg-import" type="button" ${importEgg ? "" : "disabled"}>Import egg</button>
      </div>
      <pre id="frontier-egg-result" class="frontier-result">No operation requested.</pre>
    </article>`;
    const output = body.querySelector("#frontier-egg-result");
    body.querySelector("#frontier-egg-export").addEventListener("click", async () => {
      try { output.textContent = JSON.stringify(await exportEgg(), null, 2); }
      catch (cause) { output.textContent = `Export unavailable: ${String(cause?.message || cause)}`; }
    });
    body.querySelector("#frontier-egg-import").addEventListener("click", async () => {
      try { output.textContent = JSON.stringify(await importEgg(), null, 2); }
      catch (cause) { output.textContent = `Import unavailable: ${String(cause?.message || cause)}`; }
    });
  }

  async function renderAdaptiveTwins(body) {
    const current = await attempt("Current twins", async () => {
      const list = exactNativeAdapter("twinList");
      if (!list) throw new Error("Native twin list is unavailable.");
      return list();
    });
    const versions = await attempt("Adaptive twin versions", () => rpc("twin.versions"));
    body.innerHTML = card("Current twins", current) + card("Version history and rollback", versions);
  }

  async function renderLargeMedia(body) {
    const ingest = exactNativeAdapter("largeMediaIngest");
    body.innerHTML = `<article class="frontier-card" data-state="${ingest ? "ready" : "unavailable"}">
      <h2>Local ingest</h2>
      <strong>${ingest ? "ready" : "unavailable"}</strong>
      <p>${ingest
        ? "The native large-media bridge is available."
        : "The large-media adapter is not installed; selected bytes will not be uploaded."}</p>
      <div class="frontier-actions"><input id="frontier-media-input" type="file" accept="image/*,audio/*,video/*"></div>
      <pre id="frontier-media-result" class="frontier-result">No media selected.</pre>
    </article>`;
    const input = body.querySelector("#frontier-media-input");
    const output = body.querySelector("#frontier-media-result");
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      const classified = classifyMedia(file);
      if (classified.state !== "ingesting" || !ingest) {
        output.textContent = classified.state === "ingesting"
          ? "unsupported: The approved large-media adapter is unavailable; no bytes were uploaded."
          : `${classified.state}: ${classified.message}`;
        return;
      }
      try {
        output.textContent = JSON.stringify(await ingest({
          name: file.name,
          type: file.type,
          size: file.size,
          bytes: await file.arrayBuffer(),
        }), null, 2);
      } catch (cause) {
        output.textContent = `error: ${String(cause?.message || cause)}`;
      }
    });
  }

  async function renderVoice(body) {
    const [status, providers] = await Promise.all([
      attempt("Continuous voice", () => rpc("voice.mode.status")),
      attempt("Voice providers", () => rpc("tts.providers")),
    ]);
    body.innerHTML = `${card("Continuous voice", status)}${card("Providers / ElevenLabs", providers)}
      <article class="frontier-card"><h2>Primary controls</h2>
        <p>Use the existing Voice and Voice settings controls in the top OpenRappter chat toolbar. Credentials remain in approved stores.</p>
      </article>`;
  }

  function renderAbout(body) {
    body.innerHTML = `<article class="frontier-card" style="grid-column:1/-1">
      <h2>OpenRappter Personal</h2>
      <p>OpenRappter core rights follow this repository's Apache-2.0 license. The default personal organism is tenant-free and contains no proprietary billing or control-plane code.</p>
      <h2 style="margin-top:14px">RapterOS boundary</h2>
      <p>Hosted licensed business-organism tenancy and training are separate. Integration is through documented interfaces only.</p>
    </article>`;
  }

  async function renderGatewayFeature(body, name, operation) {
    body.innerHTML = card(name, await attempt(name, operation));
  }

  async function renderFeature(feature) {
    if (!Object.hasOwn(FEATURES, feature)) {
      throw new Error(`Unknown Frontier feature: ${String(feature)}`);
    }
    activeFeature = feature;
    setFeatureInUrl(feature);
    for (const button of nav.querySelectorAll("[data-frontier-feature]")) {
      button.setAttribute(
        "aria-current",
        button.dataset.frontierFeature === feature ? "page" : "false",
      );
    }
    const body = featureFrame(FEATURES[feature]);
    if (feature === "organism-status") await renderStatus(body);
    else if (feature === "clever-girl") await renderCleverGirl(body);
    else if (feature === "release-rings") await renderReleaseRings(body);
    else if (feature === "quantum-rappids") await renderQuantumRappids(body);
    else if (feature === "living-company") await renderLivingCompany(body);
    else if (feature === "organism-egg") await renderOrganismEgg(body);
    else if (feature === "adaptive-twins") await renderAdaptiveTwins(body);
    else if (feature === "large-media") await renderLargeMedia(body);
    else if (feature === "voice") await renderVoice(body);
    else if (feature === "about") renderAbout(body);
    else if (feature === "show-and-tell") {
      await renderGatewayFeature(body, "Show & Tell", () =>
        host.showAndTell({ action: "status" }));
    } else if (feature === "agents") {
      await renderGatewayFeature(body, "Agents", () => rpc("agents.list"));
    } else if (feature === "skills") {
      await renderGatewayFeature(body, "Skills", () => rpc("skills.list"));
    }
  }

  function snapshot() {
    return Object.freeze({
      schema: "frontier-primary/1.0",
      shell: "frontier",
      activeFeature,
      features: Object.keys(FEATURES),
      companyWeek: companyWeek.snapshot(),
      dialogOpen: dialog.open,
    });
  }

  function openDialog(feature = "organism-status") {
    restoreFocus = document.activeElement;
    if (!dialog.open) dialog.showModal();
    return renderFeature(feature).then(() => {
      nav.querySelector(`[data-frontier-feature="${feature}"]`)?.focus();
    });
  }

  function closeDialog() {
    dialog.close();
    restoreFocus?.focus?.();
    restoreFocus = null;
  }

  function openLegacyPatient() {
    location.href = host?.legacyUrl || "./legacy/index.html";
  }

  global.openrappterFrontierSemantic = createSemanticController(
    Object.keys(FEATURES),
    snapshot,
    openDialog,
  );

  global.__openrappterDesktopCommand = async (command = {}) => {
    const action = String(command.action || "snapshot");
    const args = command.args || {};
    if (action === "snapshot" || action === "desktop_state") {
      return {
        view: activeFeature || "chat",
        shell: "frontier",
        state: snapshot(),
        text: document.body.innerText.slice(0, 12000),
        elements: [],
      };
    }
    if (action === "navigate" || action === "open_app") {
      const requested = String(args.view || args.appId || "");
      const aliases = {
        presence: "organism-status",
        health: "organism-status",
        rappids: "quantum-rappids",
      };
      const feature = aliases[requested] || requested;
      await openDialog(feature);
      return { view: feature, shell: "frontier", state: snapshot() };
    }
    if (action === "company_state") return companyWeek.snapshot();
    if (action === "company_scenario") {
      const operation = String(args.operation || "");
      if (operation === "start" || operation === "reset") companyWeek.reset();
      else if (operation === "step") companyWeek.step();
      else if (operation === "run") companyWeek.run();
      else if (operation === "replay") {
        companyWeek.reset();
        companyWeek.run();
      } else {
        throw new Error(`Unknown Living Company operation: ${operation}`);
      }
      return companyWeek.snapshot();
    }
    throw new Error(`Unsupported Frontier semantic action: ${action}`);
  };

  openButton.addEventListener("click", () => void openDialog());
  closeButton.addEventListener("click", closeDialog);
  legacyButton.addEventListener("click", openLegacyPatient);
  nav.addEventListener("click", (event) => {
    const button = event.target.closest("[data-frontier-feature]");
    if (button) void renderFeature(button.dataset.frontierFeature);
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]",
    )];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  const requested = new URL(location.href).searchParams.get("view");
  if (Object.hasOwn(FEATURES, requested)) void openDialog(requested);
})(window);
