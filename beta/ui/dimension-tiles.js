(function registerDimensionTiles(root) {
  const STYLE_ID = "__rappDimensionTilesStyle";
  const SCRIPT_STATE = {
    actorStamps: new Map(),
    tiles: [],
    captureWaiters: new Map(),
    chatDragArmed: false,
    context: null,
    controller: null,
    createdHerd: false,
    draggedTileId: null,
    enabled: false,
    frameReadyGeneration: null,
    keyboardTileId: null,
    openedHerd: false,
    pendingWake: null,
    pendingWakeDeadline: 0,
    pendingWakeTimer: null,
    primaryFrameGeneration: null,
    primaryId: null,
    primaryRouteKey: null,
    refreshSequence: 0,
    routeTransition: false,
    timers: new Set(),
  };

  function addTimer(callback, delay) {
    const timer = setTimeout(() => {
      SCRIPT_STATE.timers.delete(timer);
      callback();
    }, delay);
    SCRIPT_STATE.timers.add(timer);
    return timer;
  }

  function driveTile(id, part = "") {
    return `herd.tile[${id}]${part ? `.${part}` : ""}`;
  }

  function installStyles() {
    let link = document.getElementById(STYLE_ID);
    if (link) return link;
    link = document.createElement("link");
    link.id = STYLE_ID;
    link.rel = "stylesheet";
    link.href = new URL("dimension-tiles.css", document.baseURI).href;
    document.head.appendChild(link);
    return link;
  }

  function removeStyles() {
    document.getElementById(STYLE_ID)?.remove();
  }

  function postToFrame(message) {
    SCRIPT_STATE.context?.frame?.contentWindow?.postMessage(message, "*");
  }

  // Who is acting. A person's interaction is a trusted event; anything the driver
  // dispatches is synthetic and untrusted. Article VI: a person's own action may
  // get brief feedback, a driver's does not, and attribution is carried on the
  // object rather than in a message. Captured at the start of a mutation because
  // the mutation then awaits, and the answer must not change underneath it.
  let actingActor = "person";
  // This module is imported headlessly by tests to prove herd mode loads nothing,
  // so it must not touch the DOM at registration time.
  if (typeof document !== "undefined") {
    for (const type of ["pointerdown", "click", "keydown", "drop", "dragstart"]) {
      document.addEventListener(type, (event) => {
        actingActor = event.isTrusted ? "person" : "driver";
      }, true);
    }
  }

  function actorFromFrame(value) {
    return ["ai", "driver"].includes(String(value || "user"))
      ? "driver"
      : "person";
  }

  function clearActorMarker(element) {
    if (!element) return;
    delete element.dataset.actor;
    element.classList.remove("actor-marked");
  }

  function applyActorMarker(element, actor, duration = 2600, onExpire) {
    if (!element || actor === "person") return null;
    element.dataset.actor = actor;
    element.classList.add("actor-marked");
    return addTimer(() => {
      clearActorMarker(element);
      onExpire?.();
    }, duration);
  }

  function applyStoredActorStamp(element, tileId) {
    const stamp = SCRIPT_STATE.actorStamps.get(tileId);
    if (!stamp) return;
    const remaining = stamp.until - Date.now();
    if (remaining <= 0) {
      SCRIPT_STATE.actorStamps.delete(tileId);
      return;
    }
    applyActorMarker(element, stamp.actor, remaining, () => {
      if (SCRIPT_STATE.actorStamps.get(tileId) === stamp) {
        SCRIPT_STATE.actorStamps.delete(tileId);
      }
    });
  }

  // A change made by the driver is announced on the tile itself, briefly, so two
  // hands on one window stay legible without narrating into the chat.
  function stampActor(tileId, actor) {
    if (!tileId) return;
    // Tiles are identified in the DOM by their drive handle, not by a data-tile-id.
    const element = document.querySelector(
      `.dimension-tile[data-drive="${CSS.escape(driveTile(tileId))}"]`,
    );
    if (actor === "person") {
      SCRIPT_STATE.actorStamps.delete(tileId);
      clearActorMarker(element);
      return;
    }
    const stamp = { actor, until: Date.now() + 2600 };
    SCRIPT_STATE.actorStamps.set(tileId, stamp);
    applyStoredActorStamp(element, tileId);
  }

  function stampSurfaceActor(surface, actor) {
    const control = document.querySelector(
      `[data-tile-surface-target="${CSS.escape(surface)}"]`,
    );
    applyActorMarker(control, actor);
  }

  function stampPrimaryActor(actor) {
    const host = SCRIPT_STATE.context?.frame?.parentElement;
    host?.querySelector(".dimension-tile-primary-actor-mark")?.remove();
    if (!host || actor === "person") return;
    const marker = document.createElement("span");
    marker.className = "dimension-tile-primary-actor-mark";
    marker.dataset.actor = actor;
    marker.textContent = "AI";
    host.appendChild(marker);
    addTimer(() => marker.remove(), 2600);
  }

  function announceChange(actor, tileId, message, options) {
    stampActor(tileId, actor);
    if (actor !== "person") return null;
    return showToast(message, options);
  }

  function showToast(message, {
    action,
    actionHandle,
    actionLabel,
    duration = 8000,
  } = {}) {
    if (!SCRIPT_STATE.enabled) return null;
    document.querySelector(".dimension-tile-toast")?.remove();
    const toast = document.createElement("div");
    toast.className = "dimension-tile-toast";
    toast.dataset.drive = "arena.toast";
    toast.setAttribute("role", "status");
    const text = document.createElement("span");
    text.textContent = String(message || "");
    toast.appendChild(text);
    if (action && actionLabel) {
      const button = document.createElement("button");
      button.type = "button";
      if (actionHandle) button.dataset.drive = actionHandle;
      button.textContent = actionLabel;
      button.addEventListener("click", () => {
        toast.remove();
        Promise.resolve(action()).catch(showError);
      }, { once: true });
      toast.appendChild(button);
    }
    document.body.appendChild(toast);
    addTimer(() => toast.remove(), duration);
    return toast;
  }

  function showError(error) {
    showToast(String(error?.message || error), { duration: 10000 });
  }

  function emitHandledChange(type, detail) {
    window.dispatchEvent(new CustomEvent(type, { detail }));
  }

  function changeActor(event) {
    return event.__rappAutopilotActor
      || (window.__rappAutopilotEvents?.has(event) ? "ai" : "user");
  }

  function requestCapture() {
    const frameWindow = SCRIPT_STATE.context?.frame?.contentWindow;
    if (!frameWindow) {
      return Promise.reject(new Error("The Brainstem frame is unavailable."));
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = addTimer(() => {
        SCRIPT_STATE.captureWaiters.delete(requestId);
        reject(new Error("Timed out while capturing the Brainstem chat."));
      }, 10000);
      SCRIPT_STATE.captureWaiters.set(requestId, {
        resolve(value) {
          clearTimeout(timer);
          SCRIPT_STATE.timers.delete(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          SCRIPT_STATE.timers.delete(timer);
          reject(error);
        },
      });
      frameWindow.postMessage({
        type: "rapp-beta:tile-capture",
        requestId,
      }, "*");
    });
  }

  function hasConversation(capture) {
    return capture?.turns?.some((turn) => turn.role === "user");
  }

  function isPrimaryBlank(capture) {
    return !SCRIPT_STATE.primaryId && !hasConversation(capture);
  }

  function routeForCapture(capture) {
    const state = SCRIPT_STATE.context?.state || {};
    return {
      url: String(state.url || ""),
      rappid: String(state.brainstem?.callerRappid || ""),
      compositionHash: String(state.brainstem?.compositionHash || ""),
      model: String(capture.model || "auto"),
    };
  }

  function routeKey(state = SCRIPT_STATE.context?.state) {
    return String(state?.brainstem?.callerRappid || "");
  }

  function assertTileRoute(tile) {
    const current = routeKey();
    const stored = String(tile?.route?.rappid || "");
    if (!tile || !stored || stored !== current) {
      throw new Error(
        "This tile belongs to a different Brainstem identity and cannot be restored here.",
      );
    }
  }

  async function persistCapture(capture, { surface = "herd" } = {}) {
    if (!hasConversation(capture) && !SCRIPT_STATE.primaryId) {
      throw new Error("There is no Brainstem conversation to park.");
    }
    const boundToCurrentFrame = (
      SCRIPT_STATE.primaryFrameGeneration
        === SCRIPT_STATE.context.frameGeneration
      && SCRIPT_STATE.primaryRouteKey === routeKey()
    );
    const existing = SCRIPT_STATE.primaryId && boundToCurrentFrame
      ? SCRIPT_STATE.tiles.find((tile) => tile.id === SCRIPT_STATE.primaryId)
      : null;
    if (!boundToCurrentFrame) SCRIPT_STATE.primaryId = null;
    const tile = await SCRIPT_STATE.context.api.tilesPark({
      ...(existing || {}),
      ...(existing ? { id: existing.id } : {}),
      title: capture.title,
      route: routeForCapture(capture),
      turns: capture.turns,
      history: capture.restorable
        ? capture.history
        : existing?.history || capture.history,
      restorable: capture.restorable || existing?.restorable === true,
      restoreError: capture.restorable || existing?.restorable === true
        ? null
        : capture.restoreError,
      surface,
      bunch: null,
      arena: existing?.arena || { faceUp: true },
    });
    postToFrame({
      type: "rapp-beta:tile-parked",
      id: tile.id,
      requestIds: capture.pendingRequestIds || [],
    });
    SCRIPT_STATE.primaryId = null;
    SCRIPT_STATE.primaryFrameGeneration = null;
    SCRIPT_STATE.primaryRouteKey = null;
    return tile;
  }

  async function parkCurrent(
    surface = SCRIPT_STATE.context?.viewMode?.surface || "herd",
    { actor = actingActor } = {},
  ) {
    const capture = await requestCapture();
    if (isPrimaryBlank(capture)) {
      throw new Error("There is no Brainstem conversation to park.");
    }
    const tile = await persistCapture(capture, { surface });
    SCRIPT_STATE.routeTransition = true;
    try {
      await SCRIPT_STATE.context.api.tilesDeactivate();
    } finally {
      SCRIPT_STATE.routeTransition = false;
    }
    await refreshTiles();
    announceChange(actor, tile.id, `Parked "${tile.title}" in the ${surface}.`);
    return tile;
  }

  const WAKE_RETRY_MS = 120;
  const WAKE_DEADLINE_MS = 15000;

  // The wake handshake had exactly two chances to land: once when the frame
  // reports ready, and once when wakeTile's route transition finishes. Both can
  // legitimately miss — the ready message arrives while routeTransition is still
  // true, and a second navigation then nulls frameReadyGeneration while
  // frameChanged returns early because a wake is pending. Nothing retried, so the
  // tile was dropped silently and the chat showed a fresh Brainstem instead of the
  // restored conversation. Retry until the generations agree, then give up loudly.
  function clearWakeRetry() {
    if (SCRIPT_STATE.pendingWakeTimer === null) return;
    clearTimeout(SCRIPT_STATE.pendingWakeTimer);
    SCRIPT_STATE.timers.delete(SCRIPT_STATE.pendingWakeTimer);
    SCRIPT_STATE.pendingWakeTimer = null;
  }

  function scheduleWakeRetry() {
    if (SCRIPT_STATE.pendingWakeTimer !== null) return;
    if (!SCRIPT_STATE.pendingWakeDeadline) {
      SCRIPT_STATE.pendingWakeDeadline = Date.now() + WAKE_DEADLINE_MS;
    }
    SCRIPT_STATE.pendingWakeTimer = addTimer(() => {
      SCRIPT_STATE.pendingWakeTimer = null;
      if (!SCRIPT_STATE.pendingWake) return;
      if (Date.now() > SCRIPT_STATE.pendingWakeDeadline) {
        const title = SCRIPT_STATE.pendingWake?.title || "that tile";
        SCRIPT_STATE.pendingWake = null;
        SCRIPT_STATE.pendingWakeDeadline = 0;
        showError(new Error(
          `"${title}" could not be restored into the Brainstem — the chat never `
          + "became ready. Its conversation is still parked; try again.",
        ));
        return;
      }
      deliverPendingWake();
    }, WAKE_RETRY_MS);
  }

  function deliverPendingWake() {
    if (!SCRIPT_STATE.pendingWake) {
      clearWakeRetry();
      SCRIPT_STATE.pendingWakeDeadline = 0;
      return false;
    }
    if (
      SCRIPT_STATE.routeTransition
      || SCRIPT_STATE.frameReadyGeneration
        !== SCRIPT_STATE.context?.frameGeneration
    ) {
      scheduleWakeRetry();
      return false;
    }
    clearWakeRetry();
    SCRIPT_STATE.pendingWakeDeadline = 0;
    postToFrame({
      type: "rapp-beta:tile-wake",
      tile: SCRIPT_STATE.pendingWake,
    });
    SCRIPT_STATE.primaryFrameGeneration = SCRIPT_STATE.context.frameGeneration;
    SCRIPT_STATE.pendingWake = null;
    return true;
  }

  async function wakeTile(id, { actor = actingActor } = {}) {
    const requested = SCRIPT_STATE.tiles.find((tile) => tile.id === id);
    if (requested?.restorable === false) {
      throw new Error(requested.restoreError || "This tile cannot be restored.");
    }
    assertTileRoute(requested);
    if (
      SCRIPT_STATE.primaryId === id
      && SCRIPT_STATE.primaryFrameGeneration
        === SCRIPT_STATE.context.frameGeneration
      && SCRIPT_STATE.primaryRouteKey === routeKey()
    ) {
      const winner = await SCRIPT_STATE.context.api.tilesWake(id);
      await refreshTiles();
      return winner;
    }
    const current = await requestCapture();
    if (!isPrimaryBlank(current)) {
      await persistCapture(current, {
        surface: requested.surface || "herd",
      });
    } else {
      SCRIPT_STATE.primaryId = null;
      SCRIPT_STATE.primaryFrameGeneration = null;
      SCRIPT_STATE.primaryRouteKey = null;
    }
    SCRIPT_STATE.routeTransition = true;
    SCRIPT_STATE.pendingWake = requested;
    let tile;
    try {
      tile = await SCRIPT_STATE.context.api.tilesWake(id);
      SCRIPT_STATE.pendingWake = tile;
      SCRIPT_STATE.primaryId = tile.id;
      SCRIPT_STATE.primaryRouteKey = routeKey();
    } catch (error) {
      SCRIPT_STATE.pendingWake = null;
      throw error;
    } finally {
      SCRIPT_STATE.routeTransition = false;
    }
    deliverPendingWake();
    await refreshTiles();
    stampPrimaryActor(actor);
    announceChange(actor, tile.id, `Made "${tile.title}" primary.`);
    return tile;
  }

  async function foldTile(id, { actor = actingActor } = {}) {
    if (SCRIPT_STATE.primaryId === id) {
      const current = await requestCapture();
      if (hasConversation(current)) await persistCapture(current);
    }
    const result = await SCRIPT_STATE.context.api.tilesFold(id);
    if (SCRIPT_STATE.primaryId === id) {
      SCRIPT_STATE.primaryId = null;
      SCRIPT_STATE.primaryFrameGeneration = null;
      SCRIPT_STATE.primaryRouteKey = null;
      postToFrame({ type: "rapp-beta:tile-clear" });
    }
    await refreshTiles();
    announceChange(actor, id, `Folded "${result.tile.title}".`, {
      actionLabel: "Undo",
      actionHandle: "tiles.undo",
      action: async () => {
        await SCRIPT_STATE.context.api.tilesUndo(id);
        await refreshTiles();
      },
      duration: 10000,
    });
    return result.tile;
  }

  async function moveTile(id, surface, { actor = actingActor } = {}) {
    const tile = await SCRIPT_STATE.context.api.tilesMove(id, surface);
    SCRIPT_STATE.keyboardTileId = null;
    await refreshTiles();
    announceChange(actor, id, `Moved "${tile.title}" to the ${surface}.`);
    stampSurfaceActor(surface, actor);
    return tile;
  }

  async function bunchTiles(sourceId, targetId, { actor = actingActor } = {}) {
    const result = await SCRIPT_STATE.context.api.tilesBunch(sourceId, targetId);
    SCRIPT_STATE.keyboardTileId = null;
    await refreshTiles();
    announceChange(actor, targetId,
      `Bunched "${result.source.title}" with "${result.target.title}".`);
    return result;
  }

  function toggleKeyboardPickup(tile) {
    const actor = actingActor;
    if (actor !== "person") return;
    if (!SCRIPT_STATE.keyboardTileId) {
      SCRIPT_STATE.keyboardTileId = tile.id;
      announceChange(actor, tile.id,
        `Picked up "${tile.title}". Focus another tile and press Space.`);
      renderTiles();
      return;
    }
    if (SCRIPT_STATE.keyboardTileId === tile.id) {
      SCRIPT_STATE.keyboardTileId = null;
      announceChange(actor, tile.id, `Put down "${tile.title}".`);
      renderTiles();
      return;
    }
    const sourceId = SCRIPT_STATE.keyboardTileId;
    void bunchTiles(sourceId, tile.id).catch(showError);
  }

  async function raceTile(id) {
    const actor = actingActor;
    const source = SCRIPT_STATE.tiles.find((tile) => tile.id === id);
    assertTileRoute(source);
    const current = await requestCapture();
    if (hasConversation(current)) await persistCapture(current);
    const race = await SCRIPT_STATE.context.api.tilesRace(id);
    const raceTarget = document.querySelector(".dimension-tile-race-target")?.value
      || "brainstem";
    if (raceTarget.startsWith("twin:")) {
      const twinId = raceTarget.slice(5);
      const result = await SCRIPT_STATE.context.api.twinChat(
        twinId,
        race.question,
      );
      const reply = String(
        result.response || result.assistant_response || result.result || "",
      );
      if (!reply) throw new Error(`Twin ${twinId} returned an empty race reply.`);
      await SCRIPT_STATE.context.api.tilesComplete(race.contender.id, {
        reply,
        html: "",
        history: [
          { role: "user", content: race.question },
          { role: "assistant", content: reply },
        ],
        model: `twin:${twinId}`,
        requestId: `twin-${crypto.randomUUID()}`,
      });
      SCRIPT_STATE.primaryId = null;
      SCRIPT_STATE.primaryFrameGeneration = null;
      SCRIPT_STATE.primaryRouteKey = null;
      await refreshTiles();
      announceChange(actor, race.contender.id, `Twin ${twinId} answered the race.`);
      return race;
    }
    SCRIPT_STATE.primaryId = race.contender.id;
    SCRIPT_STATE.primaryFrameGeneration = SCRIPT_STATE.context.frameGeneration;
    SCRIPT_STATE.primaryRouteKey = routeKey();
    postToFrame({
      type: "rapp-beta:tile-race",
      id: race.contender.id,
      question: race.question,
    });
    await refreshTiles();
    stampPrimaryActor(actor);
    announceChange(
      actor,
      race.contender.id,
      "Race staged. Pick a model or companion, then send the question.",
      { duration: 10000 },
    );
    return race;
  }

  async function populateRaceTargets() {
    const select = document.querySelector(".dimension-tile-race-target");
    if (!select) return;
    const selected = select.value || "brainstem";
    select.replaceChildren();
    const brainstem = document.createElement("option");
    brainstem.value = "brainstem";
    brainstem.textContent = "Race target: Brainstem model";
    select.appendChild(brainstem);
    let twins;
    try {
      twins = await SCRIPT_STATE.context.api.twinList();
    } catch (error) {
      showError(new Error(
        `Twin race targets are unavailable: ${String(error?.message || error)}`,
      ));
      return;
    }
    for (const twin of twins || []) {
      const option = document.createElement("option");
      option.value = `twin:${twin.id}`;
      option.textContent = `Race target: ${twin.name || twin.id}`;
      select.appendChild(option);
    }
    if ([...select.options].some((option) => option.value === selected)) {
      select.value = selected;
    }
  }

  function tileCanRace(tile) {
    if (tile.status === "racing") return false;
    const lastUser = [...(tile.turns || [])]
      .reverse()
      .find((turn) => turn.role === "user");
    return Boolean(lastUser?.text?.trim().endsWith("?"));
  }

  function tileExcerpt(tile) {
    const last = [...(tile.turns || [])]
      .reverse()
      .find((turn) => !turn.pending && turn.text);
    const text = String(last?.text || "Waiting for a reply...").trim();
    return [...text].slice(0, 140).join("");
  }

  function attachSwipe(element, tile) {
    let pointerId = null;
    let startX = 0;
    let deltaX = 0;
    let wheelDelta = 0;
    let wheelTimer = null;
    const reset = () => {
      pointerId = null;
      deltaX = 0;
      element.classList.remove("swiping");
      element.style.removeProperty("--swipe-x");
      element.style.removeProperty("--swipe-tilt");
    };
    element.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button,select,a,input")) return;
      pointerId = event.pointerId;
      startX = event.clientX;
      try {
        element.setPointerCapture?.(pointerId);
      } catch {
        // Synthetic UI-driver pointers do not belong to a native pointer stream.
      }
      element.classList.add("swiping");
    });
    element.addEventListener("pointermove", (event) => {
      if (pointerId !== event.pointerId) return;
      deltaX = event.clientX - startX;
      element.style.setProperty("--swipe-x", `${deltaX}px`);
      element.style.setProperty(
        "--swipe-tilt",
        `${Math.max(-10, Math.min(10, deltaX / 14))}deg`,
      );
    });
    element.addEventListener("pointerup", (event) => {
      if (pointerId !== event.pointerId) return;
      const actor = event.isTrusted ? "person" : "driver";
      const movement = deltaX;
      reset();
      if (movement >= 72) void wakeTile(tile.id, { actor }).catch(showError);
      else if (movement <= -72) void foldTile(tile.id, { actor }).catch(showError);
    });
    element.addEventListener("pointercancel", reset);
    element.addEventListener("wheel", (event) => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      const actor = event.isTrusted ? "person" : "driver";
      event.preventDefault();
      wheelDelta += event.deltaX;
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => { wheelDelta = 0; }, 260);
      if (Math.abs(wheelDelta) < 72) return;
      const movement = wheelDelta;
      wheelDelta = 0;
      clearTimeout(wheelTimer);
      if (movement > 0) void wakeTile(tile.id, { actor }).catch(showError);
      else void foldTile(tile.id, { actor }).catch(showError);
    }, { passive: false });
  }

  function tileDragId(event) {
    return event.dataTransfer?.getData("application/x-rapp-dimension-tile")
      || SCRIPT_STATE.draggedTileId;
  }

  function attachTileDrag(element, tile) {
    element.draggable = true;
    element.addEventListener("dragstart", (event) => {
      if (event.target.closest("button,select,a,input")) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-rapp-dimension-tile", tile.id);
      SCRIPT_STATE.draggedTileId = tile.id;
      element.classList.add("dragging");
      postToFrame({
        type: "rapp-beta:tile-drag-armed",
        id: tile.id,
        label: SCRIPT_STATE.primaryId ? "Swap with this chat" : "Make primary",
      });
      void requestCapture().then((capture) => {
        if (SCRIPT_STATE.draggedTileId !== tile.id) return;
        postToFrame({
          type: "rapp-beta:tile-drag-armed",
          id: tile.id,
          label: isPrimaryBlank(capture)
            ? "Make primary"
            : "Swap with this chat",
        });
      }).catch(showError);
    });
    element.addEventListener("dragend", () => {
      SCRIPT_STATE.draggedTileId = null;
      element.classList.remove("dragging");
      postToFrame({ type: "rapp-beta:tile-drag-disarmed" });
      hideDropOverlay();
    });
  }

  function createTile(tile, { folded = false } = {}) {
    const element = document.createElement("article");
    element.className = `dimension-tile${folded ? " folded" : ""}`;
    element.dataset.dimensionTile = tile.id;
    element.dataset.drive = driveTile(tile.id);
    element.dataset.seat = tile.arena?.seat || "";
    element.dataset.status = tile.status;
    element.dataset.surface = tile.surface;
    element.dataset.bunch = tile.bunch || "";
    applyStoredActorStamp(element, tile.id);
    const seat = Number(tile.arena?.seat) || 1;
    element.style.setProperty("--spread-angle", `${(seat - 6) * 2}deg`);
    element.tabIndex = 0;
    element.setAttribute("aria-keyshortcuts", "Enter H A B Space");
    element.setAttribute(
      "aria-grabbed",
      String(SCRIPT_STATE.keyboardTileId === tile.id),
    );
    element.setAttribute(
      "aria-label",
      `${tile.title}, ${tile.status} dimension tile`,
    );

    const corner = document.createElement("span");
    corner.className = "dimension-tile-corner";
    corner.textContent = String(tile.turns?.length || 0);
    const drag = document.createElement("span");
    drag.className = "dimension-tile-drag";
    drag.dataset.drive = driveTile(tile.id, "drag");
    drag.title = "Drag this tile";
    drag.setAttribute("aria-label", `Drag ${tile.title}`);
    drag.textContent = "⠿";
    const face = document.createElement("div");
    face.className = "dimension-tile-face";
    const banner = document.createElement("div");
    banner.className = "dimension-tile-banner";
    const title = document.createElement("strong");
    title.textContent = tile.title;
    const status = document.createElement("span");
    status.textContent = tile.status;
    banner.append(title, status);
    const art = document.createElement("div");
    art.className = "dimension-tile-art";
    art.setAttribute("aria-hidden", "true");
    for (let index = 0; index < Math.min(6, tile.turns?.length || 0); index += 1) {
      const pip = document.createElement("i");
      art.appendChild(pip);
    }
    const excerpt = document.createElement("p");
    excerpt.textContent = tileExcerpt(tile);
    const meta = document.createElement("div");
    meta.className = "dimension-tile-meta";
    meta.textContent = `${tile.route?.model || "auto"} · ${
      tile.turns?.length || 0
    } turns`;
    const actions = document.createElement("div");
    actions.className = "dimension-tile-actions";
    if (!folded) {
      const race = document.createElement("button");
      race.type = "button";
      race.dataset.drive = driveTile(tile.id, "race");
      race.textContent = "Race";
      race.disabled = !tileCanRace(tile);
      race.title = race.disabled
        ? "The last user turn must be a question."
        : "Race this question with another model or companion.";
      race.addEventListener(
        "click",
        () => void raceTile(tile.id).catch(showError),
      );
      const fold = document.createElement("button");
      fold.type = "button";
      fold.dataset.drive = driveTile(tile.id, "fold");
      fold.textContent = "Fold";
      fold.addEventListener(
        "click",
        () => void foldTile(tile.id).catch(showError),
      );
      actions.append(race, fold);
    } else {
      const undo = document.createElement("button");
      undo.type = "button";
      undo.dataset.drive = "tiles.undo";
      undo.textContent = "Undo";
      undo.addEventListener("click", () => {
        const actor = actingActor;
        void SCRIPT_STATE.context.api.tilesUndo(tile.id)
          .then(refreshTiles)
          .then(() => announceChange(actor, tile.id, `Restored "${tile.title}".`))
          .catch(showError);
      });
      actions.appendChild(undo);
    }
    face.append(banner, art, excerpt, meta, actions);
    element.append(corner, drag, face);
    attachSwipe(element, tile);
    attachTileDrag(element, tile);
    element.addEventListener("dragover", (event) => {
      const sourceId = tileDragId(event);
      if (!sourceId || sourceId === tile.id) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      showDropOverlay("Bunch these tiles");
    });
    element.addEventListener("dragleave", hideDropOverlayOnRealLeave);
    element.addEventListener("drop", (event) => {
      const sourceId = tileDragId(event);
      if (!sourceId || sourceId === tile.id) return;
      const actor = changeActor(event);
      event.preventDefault();
      event.stopPropagation();
      hideDropOverlay();
      void bunchTiles(sourceId, tile.id, {
        actor: actorFromFrame(actor),
      }).then((result) => {
        emitHandledChange("rapp-beta:tile-bunch-complete", {
          actor,
          bunch: result.bunch,
          sourceId,
          targetId: tile.id,
        });
      }).catch(showError);
    });
    element.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight" || event.key === "Enter") {
        event.preventDefault();
        void wakeTile(tile.id).catch(showError);
      } else if (event.key === "ArrowLeft" && !folded) {
        event.preventDefault();
        void foldTile(tile.id).catch(showError);
      } else if (event.key.toLowerCase() === "r" && !folded && tileCanRace(tile)) {
        event.preventDefault();
        void raceTile(tile.id).catch(showError);
      } else if (["h", "a", "b"].includes(event.key.toLowerCase())) {
        event.preventDefault();
        const surface = {
          h: "herd",
          a: "arena",
          b: "binder",
        }[event.key.toLowerCase()];
        void moveTile(tile.id, surface).catch(showError);
      } else if (event.key === " ") {
        event.preventDefault();
        toggleKeyboardPickup(tile);
      } else if (event.key === "Escape" && SCRIPT_STATE.keyboardTileId) {
        event.preventDefault();
        SCRIPT_STATE.keyboardTileId = null;
        renderTiles();
      }
    });
    const custom = SCRIPT_STATE.context?.state?.arenaLayout;
    if (SCRIPT_STATE.context?.viewMode?.layout === "custom" && custom) {
      const seat = Number(tile.arena?.seat) || 1;
      const faceDown = custom.faceDownRule === "all"
        || (custom.faceDownRule === "folded" && tile.status === "folded")
        || (custom.faceDownRule === "alternate" && seat % 2 === 0);
      element.classList.toggle("face-down", faceDown);
    }
    return element;
  }

  function applyCustomPosition(element, tile, customLayout) {
    const seat = Number(tile.arena?.seat) || 1;
    const position = customLayout?.seatPositions?.[(seat - 1)
      % customLayout.seatPositions.length];
    if (!position) return;
    element.style.setProperty("--custom-x", `${position.x}%`);
    element.style.setProperty("--custom-y", `${position.y}%`);
    element.style.setProperty("--custom-rotation", `${position.rotation}deg`);
  }

  function renderDiscard(surface, folded) {
    let pile = surface.querySelector(".dimension-tile-discard");
    if (!folded.length) {
      pile?.remove();
      return;
    }
    if (!pile) {
      pile = document.createElement("section");
      pile.className = "dimension-tile-discard";
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.drive = "arena.discard";
      button.addEventListener("click", () => {
        pile.classList.toggle("open");
        button.setAttribute(
          "aria-expanded",
          String(pile.classList.contains("open")),
        );
      });
      pile.appendChild(button);
      surface.appendChild(pile);
    }
    const button = pile.querySelector("button");
    button.textContent = `Discard pile · ${folded.length}`;
    pile.querySelectorAll(".dimension-tile.folded").forEach((tile) => tile.remove());
    for (const [index, tile] of folded.entries()) {
      const element = createTile(tile, { folded: true });
      const spread = Math.min(8, 48 / Math.max(1, folded.length));
      element.style.setProperty(
        "--pile-angle",
        `${(index - ((folded.length - 1) / 2)) * spread}deg`,
      );
      element.style.setProperty("--pile-offset", `${index * -7}px`);
      pile.appendChild(element);
    }
  }

  function renderOverflow(surface, overflowTiles) {
    let pile = surface.querySelector(".dimension-tile-overflow");
    if (!overflowTiles.length) {
      pile?.remove();
      return;
    }
    if (!pile) {
      pile = document.createElement("section");
      pile.className = "dimension-tile-overflow";
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.drive = "arena.overflow";
      button.addEventListener("click", () => {
        pile.classList.toggle("open");
        button.setAttribute(
          "aria-expanded",
          String(pile.classList.contains("open")),
        );
      });
      pile.appendChild(button);
      surface.appendChild(pile);
    }
    pile.querySelector("button").textContent =
      `Overflow pile · ${overflowTiles.length}`;
    pile.querySelectorAll(".dimension-tile").forEach((tile) => tile.remove());
    for (const [index, tile] of overflowTiles.entries()) {
      const element = createTile(tile);
      const spread = Math.min(8, 48 / Math.max(1, overflowTiles.length));
      element.style.setProperty(
        "--pile-angle",
        `${(index - ((overflowTiles.length - 1) / 2)) * spread}deg`,
      );
      element.style.setProperty("--pile-offset", `${index * 7}px`);
      pile.appendChild(element);
    }
  }

  function appendTileCollection(container, tiles) {
    const renderedBunches = new Set();
    for (const tile of tiles) {
      let target = container;
      if (tile.bunch) {
        if (renderedBunches.has(tile.bunch)) continue;
        renderedBunches.add(tile.bunch);
        target = document.createElement("section");
        target.className = "dimension-tile-bunch";
        target.dataset.bunch = tile.bunch;
        target.dataset.drive = `tiles.bunch[${tile.bunch}]`;
        target.setAttribute("aria-label", "Tile bunch");
        container.appendChild(target);
      }
      const members = tile.bunch
        ? tiles.filter((candidate) => candidate.bunch === tile.bunch)
        : [tile];
      for (const member of members) {
        const element = createTile(member);
        if (
          SCRIPT_STATE.context.viewMode.surface === "arena"
          && SCRIPT_STATE.context.viewMode.layout === "custom"
        ) {
          applyCustomPosition(
            element,
            member,
            SCRIPT_STATE.context.state.arenaLayout,
          );
        }
        target.appendChild(element);
      }
    }
  }

  function renderBinderPages(surface, tiles) {
    const pageSize = 12;
    const pageCount = Math.max(1, Math.ceil(tiles.length / pageSize));
    for (let page = 0; page < pageCount; page += 1) {
      const element = document.createElement("section");
      element.className = "dimension-tile-binder-page";
      element.dataset.drive = `binder.page[${page + 1}]`;
      element.setAttribute(
        "aria-label",
        `Binder page ${page + 1} of ${pageCount}`,
      );
      appendTileCollection(
        element,
        tiles.slice(page * pageSize, (page + 1) * pageSize),
      );
      surface.appendChild(element);
    }
  }

  function renderTiles() {
    const surface = document.querySelector(".dimension-tile-surface");
    if (!surface) return;
    surface.replaceChildren();
    const selectedSurface = SCRIPT_STATE.context.viewMode.surface || "herd";
    surface.dataset.surface = selectedSurface;
    surface.dataset.drive = `tiles.surface[${selectedSurface}]`;
    surface.setAttribute(
      "aria-label",
      `${selectedSurface} Brainstem dimension tiles`,
    );
    const matching = SCRIPT_STATE.tiles.filter((tile) => (
      tile.surface === selectedSurface && tile.status !== "primary"
    ));
    const active = matching.filter((tile) => tile.status !== "folded");
    const folded = matching.filter((tile) => tile.status === "folded");
    if (selectedSurface === "binder") {
      renderBinderPages(surface, active);
    } else {
      appendTileCollection(surface, active.slice(0, 12));
      renderOverflow(surface, active.slice(12));
    }
    renderDiscard(surface, folded);
  }

  function applyLayout() {
    const herd = document.getElementById("surgeon-herd");
    const surface = herd?.querySelector(".dimension-tile-surface");
    if (!herd || !surface) return;
    for (const name of ["ring", "row", "focus", "grid", "stack", "custom"]) {
      herd.classList.remove(`tile-layout-${name}`);
    }
    for (const name of ["herd", "arena", "binder"]) {
      herd.classList.remove(`tile-surface-${name}`);
    }
    const selectedSurface = SCRIPT_STATE.context.viewMode.surface || "herd";
    const layoutName = selectedSurface === "arena"
      ? SCRIPT_STATE.context.viewMode.layout || "ring"
      : "ring";
    herd.classList.add("dimension-tile-view");
    // Arena arrangements are the arena's. The herd stays a grid and the binder
    // stays pages; neither is a layout of the other, so no tile-layout-* class
    // is applied off the arena.
    if (selectedSurface === "arena") {
      herd.classList.add(`tile-layout-${layoutName}`);
      herd.dataset.arenaLayout = layoutName;
    } else {
      delete herd.dataset.arenaLayout;
    }
    herd.classList.add(`tile-surface-${selectedSurface}`);
    herd.dataset.tileSurface = selectedSurface;
    const custom = SCRIPT_STATE.context.state.arenaLayout;
    if (selectedSurface === "arena" && layoutName === "custom" && custom) {
      surface.style.setProperty("--arena-surface", custom.surfaceColor);
      surface.style.setProperty("--tile-width", `${custom.tileSize.width}px`);
      surface.style.setProperty("--tile-height", `${custom.tileSize.height}px`);
      surface.dataset.faceDownRule = custom.faceDownRule;
      surface.dataset.arrangePattern = custom.arrangePattern;
    } else {
      surface.style.removeProperty("--arena-surface");
      surface.style.removeProperty("--tile-width");
      surface.style.removeProperty("--tile-height");
      delete surface.dataset.faceDownRule;
      delete surface.dataset.arrangePattern;
    }
    const layout = document.querySelector(".dimension-tile-layout");
    if (layout) layout.value = layoutName;
    document.querySelector(".dimension-tile-load-custom")
      ?.toggleAttribute("hidden", layoutName !== "custom");
    document.querySelectorAll(".dimension-tile-arena-only").forEach((control) => {
      control.toggleAttribute("hidden", selectedSurface !== "arena");
    });
    const label = document.querySelector(".dimension-tile-controls > strong");
    if (label) {
      label.textContent = {
        herd: "Herd — parked conversations, side by side",
        arena: "Agent Arena — parked conversations compete side by side",
        binder: "Binder — dormant tiles kept in pages and bunches",
      }[selectedSurface];
    }
    document.querySelectorAll("[data-tile-surface-target]").forEach((button) => {
      const selected = button.dataset.tileSurfaceTarget === selectedSurface;
      button.setAttribute("aria-pressed", String(selected));
    });
    renderTiles();
  }

  async function changeLayout(value) {
    if (value === "custom") {
      const loaded = await SCRIPT_STATE.context.api.tilesLoadCustomLayout();
      if (loaded.canceled) {
        document.querySelector(".dimension-tile-layout").value =
          SCRIPT_STATE.context.viewMode.layout;
      }
      return;
    }
    await SCRIPT_STATE.context.api.setViewMode({ layout: value });
  }

  function randomIndex(length) {
    if (length < 1) return -1;
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return values[0] % length;
  }

  async function runArrange(action, { actor = actingActor } = {}) {
    const surface = document.querySelector(".dimension-tile-surface");
    if (!surface || !action) return;
    surface.classList.remove(
      "arrange-reorder",
      "arrange-spread",
      "arrange-distribute",
      "arrange-open-one",
    );
    void surface.offsetWidth;
    surface.classList.add(`arrange-${action}`);
    if (action === "open-one") {
      const candidates = SCRIPT_STATE.tiles.filter((tile) => (
        tile.status === "parked" || tile.status === "racing"
      ));
      const index = randomIndex(candidates.length);
      if (index < 0) throw new Error("There is no parked tile to open.");
      await new Promise((resolve) => addTimer(resolve, 320));
      await wakeTile(candidates[index].id, { actor });
    }
  }

  function ensureControls(herd, surface) {
    let controls = herd.querySelector(".dimension-tile-controls");
    if (controls) return controls;
    controls = document.createElement("div");
    controls.className = "dimension-tile-controls";
    controls.dataset.drive = "arena.controls";
    const label = document.createElement("strong");
    const surfaceControl = document.createElement("div");
    surfaceControl.className = "dimension-tile-surface-control";
    surfaceControl.dataset.drive = "tiles.surfaces";
    surfaceControl.setAttribute("role", "group");
    surfaceControl.setAttribute("aria-label", "Tile surface");
    for (const name of ["herd", "arena", "binder"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.tileSurfaceTarget = name;
      button.dataset.drive = `tiles.surface.${name}`;
      button.textContent = name[0].toUpperCase() + name.slice(1);
      button.addEventListener("click", () => {
        void SCRIPT_STATE.context.api.setViewMode({ surface: name })
          .catch(showError);
      });
      surfaceControl.appendChild(button);
    }
    const layout = document.createElement("select");
    layout.className = "dimension-tile-layout";
    layout.classList.add("dimension-tile-arena-only");
    layout.dataset.drive = "arena.layout";
    layout.setAttribute("aria-label", "Agent Arena layout");
    const labels = {
      ring: "Ring",
      row: "Rows",
      focus: "Focus",
      grid: "Grid",
      stack: "Stack",
      custom: "Custom…",
    };
    for (const [value, text] of Object.entries(labels)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      layout.appendChild(option);
    }
    layout.addEventListener("change", () => {
      void changeLayout(layout.value).catch(showError);
    });
    const load = document.createElement("button");
    load.type = "button";
    load.className = "dimension-tile-load-custom";
    load.classList.add("dimension-tile-arena-only");
    load.dataset.drive = "arena.loadCustom";
    load.textContent = "Load layout…";
    load.addEventListener("click", () => {
      void SCRIPT_STATE.context.api.tilesLoadCustomLayout().catch(showError);
    });
    const raceTarget = document.createElement("select");
    raceTarget.className = "dimension-tile-race-target";
    raceTarget.classList.add("dimension-tile-arena-only");
    raceTarget.dataset.drive = "arena.raceTarget";
    raceTarget.setAttribute("aria-label", "Race target");
    const arrange = document.createElement("select");
    arrange.className = "dimension-tile-arena-only";
    arrange.dataset.drive = "arena.arrange";
    arrange.setAttribute("aria-label", "Arrange tiles");
    for (const [value, text] of [
      ["", "Arrange…"],
      ["reorder", "Reorder"],
      ["spread", "Spread"],
      ["distribute", "Distribute"],
      ["open-one", "Open one"],
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      arrange.appendChild(option);
    }
    arrange.addEventListener("change", (event) => {
      const action = arrange.value;
      arrange.value = "";
      const actor = event.isTrusted ? "person" : "driver";
      void runArrange(action, { actor }).catch(showError);
    });
    controls.append(
      label,
      surfaceControl,
      layout,
      load,
      raceTarget,
      arrange,
    );
    herd.insertBefore(controls, surface);
    return controls;
  }

  function ensureDropOverlay(herd) {
    let overlay = herd.querySelector(".dimension-tile-drop-overlay");
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.className = "dimension-tile-drop-overlay";
    overlay.dataset.drive = "tiles.dropOverlay";
    overlay.setAttribute("role", "status");
    const line = document.createElement("span");
    overlay.appendChild(line);
    herd.appendChild(overlay);
    return overlay;
  }

  function showDropOverlay(message) {
    const overlay = document.querySelector(".dimension-tile-drop-overlay");
    if (!overlay) return;
    overlay.querySelector("span").textContent = String(message || "");
    overlay.style.display = "flex";
  }

  function hideDropOverlay() {
    const overlay = document.querySelector(".dimension-tile-drop-overlay");
    if (overlay) overlay.style.display = "none";
  }

  function hideDropOverlayOnRealLeave(event) {
    if (
      event.relatedTarget === null
      || event.clientX <= 0
      || event.clientY <= 0
      || event.clientX >= window.innerWidth
      || event.clientY >= window.innerHeight
    ) {
      hideDropOverlay();
    }
  }

  function ensureSurface(herd, grid) {
    let surface = herd.querySelector(".dimension-tile-surface");
    if (!surface) {
      surface = document.createElement("section");
      surface.className = "dimension-tile-surface";
      surface.setAttribute("aria-label", "Parked Brainstem dimension tiles");
      herd.insertBefore(surface, grid);
    }
    return surface;
  }

  function hasDragType(event, type) {
    return Boolean(event.dataTransfer?.types?.includes(type));
  }

  function surfaceDropLabel(surface, chatDrag) {
    if (surface === "binder") return "Keep in the binder";
    if (chatDrag) return "Park as a tile";
    return `Move to the ${surface}`;
  }

  function installSurfaceDropTarget(target, surfaceForEvent) {
    const signal = SCRIPT_STATE.controller.signal;
    target.addEventListener("dragover", (event) => {
      const chatDrag = SCRIPT_STATE.chatDragArmed
        || hasDragType(event, "application/x-rapp-brainstem-chat");
      const tileDrag = Boolean(tileDragId(event));
      if (!chatDrag && !tileDrag) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const surface = typeof surfaceForEvent === "function"
        ? surfaceForEvent()
        : surfaceForEvent;
      showDropOverlay(surfaceDropLabel(surface, chatDrag));
    }, { signal });
    target.addEventListener("dragleave", hideDropOverlayOnRealLeave, { signal });
    target.addEventListener("drop", (event) => {
      const chatDrag = SCRIPT_STATE.chatDragArmed
        || hasDragType(event, "application/x-rapp-brainstem-chat");
      const id = tileDragId(event);
      if (!chatDrag && !id) return;
      const actor = changeActor(event);
      event.preventDefault();
      event.stopPropagation();
      const surface = typeof surfaceForEvent === "function"
        ? surfaceForEvent()
        : surfaceForEvent;
      hideDropOverlay();
      const mutationActor = actorFromFrame(actor);
      if (chatDrag) {
        void parkCurrent(surface, { actor: mutationActor }).then((tile) => {
          emitHandledChange("rapp-beta:tile-park-complete", {
            actor,
            id: tile.id,
            surface,
          });
        }).catch(showError);
      } else {
        void moveTile(id, surface, { actor: mutationActor }).then((tile) => {
          emitHandledChange("rapp-beta:tile-move-complete", {
            actor,
            id: tile.id,
            surface,
          });
        }).catch(showError);
      }
    }, { signal });
  }

  function installDragTargets(herd, surface) {
    installSurfaceDropTarget(
      surface,
      () => SCRIPT_STATE.context.viewMode.surface || "herd",
    );
    herd.querySelectorAll("[data-tile-surface-target]").forEach((button) => {
      installSurfaceDropTarget(button, button.dataset.tileSurfaceTarget);
    });
  }

  function receiveFrameMessage(event) {
    if (event.source !== SCRIPT_STATE.context?.frame?.contentWindow) return;
    if (event.data?.type === "rapp-beta:chat-drag-start") {
      SCRIPT_STATE.chatDragArmed = true;
      return;
    }
    if (event.data?.type === "rapp-beta:chat-drag-end") {
      SCRIPT_STATE.chatDragArmed = false;
      hideDropOverlay();
      return;
    }
    if (event.data?.type === "rapp-beta:tile-drop-primary") {
      const id = String(event.data.id || SCRIPT_STATE.draggedTileId || "");
      if (id) {
        const actor = actorFromFrame(event.data.actor);
        void wakeTile(id, { actor }).then((tile) => {
          emitHandledChange("rapp-beta:tile-primary-complete", {
            actor: actor === "driver" ? "ai" : "user",
            id: tile.id,
          });
        }).catch(showError);
      }
      return;
    }
    if (event.data?.type === "rapp-beta:tile-keyboard-park") {
      void parkCurrent(event.data.surface, {
        actor: actorFromFrame(event.data.actor),
      }).catch(showError);
      return;
    }
    if (event.data?.type === "rapp-beta:tile-frame-ready") {
      SCRIPT_STATE.frameReadyGeneration = SCRIPT_STATE.context.frameGeneration;
      deliverPendingWake();
      return;
    }
    if (event.data?.type === "rapp-beta:tile-capture-result") {
      const waiter = SCRIPT_STATE.captureWaiters.get(event.data.requestId);
      if (!waiter) return;
      SCRIPT_STATE.captureWaiters.delete(event.data.requestId);
      if (event.data.ok) waiter.resolve(event.data.tile);
      else waiter.reject(new Error(event.data.error || "Chat capture failed."));
      return;
    }
  }

  function completionSaved(event) {
    if (!SCRIPT_STATE.enabled) return;
    if (
      event.restoreInFrame
      && SCRIPT_STATE.primaryId === event.id
    ) {
      postToFrame({
        type: "rapp-beta:tile-late-completion",
        completion: event.completion,
      });
    }
    void refreshTiles().catch(showError);
  }

  function completionFailed(error) {
    if (SCRIPT_STATE.enabled) showError(error);
  }

  function tileDetached(id) {
    if (!SCRIPT_STATE.enabled || SCRIPT_STATE.primaryId !== id) return;
    const detached = SCRIPT_STATE.tiles.find((tile) => tile.id === id);
    SCRIPT_STATE.primaryId = null;
    SCRIPT_STATE.primaryFrameGeneration = null;
    SCRIPT_STATE.primaryRouteKey = null;
    if (detached) {
      void SCRIPT_STATE.context.api.tilesParkExisting(detached.id)
        .then(() => SCRIPT_STATE.context.api.tilesDeactivate())
        .then(refreshTiles)
        .catch(showError);
    }
  }

  function frameChanged({ generation } = {}) {
    if (SCRIPT_STATE.context) {
      SCRIPT_STATE.context.frameGeneration = generation;
    }
    SCRIPT_STATE.frameReadyGeneration = null;
    if (SCRIPT_STATE.routeTransition || SCRIPT_STATE.pendingWake) return;
    if (
      SCRIPT_STATE.primaryId
      && SCRIPT_STATE.primaryFrameGeneration !== generation
    ) {
      const detached = SCRIPT_STATE.tiles.find((tile) => (
        tile.id === SCRIPT_STATE.primaryId
      ));
      const currentComposition = String(
        SCRIPT_STATE.context?.state?.brainstem?.compositionHash || "",
      );
      if (
        detached
        && detached.route?.compositionHash === currentComposition
      ) {
        SCRIPT_STATE.pendingWake = detached;
        SCRIPT_STATE.primaryFrameGeneration = null;
        return;
      }
      SCRIPT_STATE.primaryId = null;
      SCRIPT_STATE.primaryFrameGeneration = null;
      SCRIPT_STATE.primaryRouteKey = null;
      if (SCRIPT_STATE.enabled && detached) {
        void SCRIPT_STATE.context.api.tilesParkExisting(detached.id)
          .then(refreshTiles)
          .catch(showError);
      }
    }
  }

  async function refreshTiles() {
    if (!SCRIPT_STATE.enabled) return [];
    const sequence = ++SCRIPT_STATE.refreshSequence;
    const tiles = await SCRIPT_STATE.context.api.tilesList();
    if (!SCRIPT_STATE.enabled || sequence !== SCRIPT_STATE.refreshSequence) {
      return tiles;
    }
    SCRIPT_STATE.tiles = tiles;
    renderTiles();
    return tiles;
  }

  async function enable(context) {
    SCRIPT_STATE.context = context;
    if (SCRIPT_STATE.enabled) {
      applyLayout();
      await populateRaceTargets();
      await refreshTiles();
      return;
    }
    SCRIPT_STATE.enabled = true;
    SCRIPT_STATE.controller = new AbortController();
    SCRIPT_STATE.openedHerd = document.body.classList.contains(
      "surgeon-herd-open",
    );
    SCRIPT_STATE.createdHerd = !context.hadHerdDom;
    try {
      installStyles();
      context.enterHerd();
      const { grid, herd } = context.ensureHerd();
      const surface = ensureSurface(herd, grid);
      ensureControls(herd, surface);
      ensureDropOverlay(herd);
      installDragTargets(herd, surface);
      window.addEventListener("message", receiveFrameMessage, {
        signal: SCRIPT_STATE.controller.signal,
      });
      applyLayout();
      if (context.state.arenaLayoutError) showError(context.state.arenaLayoutError);
      await populateRaceTargets();
      await refreshTiles();
      postToFrame({ type: "rapp-beta:tile-ready" });
      addTimer(() => postToFrame({ type: "rapp-beta:tile-ready" }), 150);
      addTimer(() => postToFrame({ type: "rapp-beta:tile-ready" }), 600);
    } catch (error) {
      disable();
      throw error;
    }
  }

  function disable() {
    if (!SCRIPT_STATE.enabled) {
      if (typeof document !== "undefined") {
        removeStyles();
        document.getElementById("__rappDimensionTilesScript")?.remove();
      }
      return;
    }
    SCRIPT_STATE.enabled = false;
    SCRIPT_STATE.refreshSequence += 1;
    SCRIPT_STATE.controller?.abort();
    SCRIPT_STATE.controller = null;
    for (const timer of SCRIPT_STATE.timers) clearTimeout(timer);
    SCRIPT_STATE.timers.clear();
    for (const waiter of SCRIPT_STATE.captureWaiters.values()) {
      waiter.reject(new Error("Agent Arena switched to herd mode."));
    }
    SCRIPT_STATE.captureWaiters.clear();
    document.querySelector(".dimension-tile-controls")?.remove();
    document.querySelector(".dimension-tile-surface")?.remove();
    document.querySelector(".dimension-tile-drop-overlay")?.remove();
    document.querySelector(".dimension-tile-toast")?.remove();
    const herd = document.getElementById("surgeon-herd");
    if (herd) {
      herd.className = herd.className
        .split(/\s+/)
        .filter((name) => !name.startsWith("tile-layout-")
          && !name.startsWith("tile-surface-")
          && name !== "dimension-tile-view")
        .join(" ");
      delete herd.dataset.arenaLayout;
      delete herd.dataset.tileSurface;
    }
    removeStyles();
    document.getElementById("__rappDimensionTilesScript")?.remove();
    if (SCRIPT_STATE.createdHerd) {
      SCRIPT_STATE.context?.destroyHerd();
    } else if (!SCRIPT_STATE.openedHerd) {
      SCRIPT_STATE.context?.exitHerd();
    }
    SCRIPT_STATE.tiles = [];
    SCRIPT_STATE.actorStamps.clear();
    document.querySelector(".dimension-tile-primary-actor-mark")?.remove();
    SCRIPT_STATE.createdHerd = false;
    SCRIPT_STATE.context = null;
    SCRIPT_STATE.primaryId = null;
    SCRIPT_STATE.primaryFrameGeneration = null;
    SCRIPT_STATE.primaryRouteKey = null;
    SCRIPT_STATE.chatDragArmed = false;
    SCRIPT_STATE.draggedTileId = null;
    SCRIPT_STATE.frameReadyGeneration = null;
    SCRIPT_STATE.keyboardTileId = null;
    SCRIPT_STATE.pendingWake = null;
    SCRIPT_STATE.routeTransition = false;
  }

  root.RappDimensionTiles = Object.freeze({
    tileDetached,
    completionFailed,
    completionSaved,
    disable,
    enabled: () => SCRIPT_STATE.enabled,
    frameChanged,
    parkCurrent,
    refresh: refreshTiles,
    sync: enable,
  });
})(globalThis);
