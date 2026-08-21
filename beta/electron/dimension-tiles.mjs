import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  DEFAULT_VIEW_MODE,
  normalizeViewModeSettings,
} from "./arena-layouts.mjs";

export const DIMENSION_TILE_SCHEMA = "rapp-dimension-tile/1.0";
export const MAX_DIMENSION_TILE_TURNS = 200;
export const MAX_DIMENSION_TILE_BYTES = 256 * 1024;
export const DIMENSION_TILE_UNDO_MS = 10_000;
const DIMENSION_TILE_STATUSES = new Set([
  "parked",
  "racing",
  "primary",
  "folded",
]);
const DIMENSION_TILE_SURFACES = new Set(["herd", "arena", "binder"]);
const DIMENSION_TILE_ID = /^tile-[a-z0-9][a-z0-9-]{5,120}$/;
const DIMENSION_TILE_BUNCH_ID = /^bunch-[a-z0-9][a-z0-9-]{5,120}$/;
const DIMENSION_TILE_AGENT_FILE = /^[A-Za-z0-9_.-]+_agent\.py$/;

function settingsPath(betaHome) {
  if (!betaHome) throw new Error("A beta home is required for dimension tile settings.");
  return path.join(betaHome, "settings.json");
}

function readSettings(betaHome) {
  const file = settingsPath(betaHome);
  if (!existsSync(file)) return {};
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Invalid Frontier settings at ${file}: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Frontier settings at ${file}.`);
  }
  return value;
}

function writeSettings(betaHome, value) {
  const file = settingsPath(betaHome);
  mkdirSync(betaHome, { recursive: true, mode: 0o700 });
  try {
    chmodSync(betaHome, 0o700);
  } catch {
    // Windows does not expose POSIX directory modes.
  }
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows does not expose POSIX file modes.
  }
  return file;
}

function environmentOverride(env) {
  if (!Object.hasOwn(env, "RAPP_VIEW_MODE")) return null;
  return env.RAPP_VIEW_MODE === "arena" ? "arena" : "herd";
}

export function readViewModeSettings({
  betaHome,
  env = process.env,
} = {}) {
  const settings = readSettings(betaHome);
  const storedViewMode = normalizeViewModeSettings(
    settings.viewMode || DEFAULT_VIEW_MODE,
  );
  const override = environmentOverride(env);
  const viewMode = {
    ...storedViewMode,
    mode: override === null ? storedViewMode.mode : override,
  };
  return {
    viewMode,
    viewModeOverridden: override !== null,
    file: settingsPath(betaHome),
    storedViewMode,
  };
}

export function writeViewModeSettings({
  viewMode,
  betaHome,
} = {}) {
  const settings = readSettings(betaHome);
  settings.viewMode = normalizeViewModeSettings({
    ...DEFAULT_VIEW_MODE,
    ...(settings.viewMode || {}),
    ...(viewMode || {}),
  });
  const file = writeSettings(betaHome, settings);
  return { viewMode: settings.viewMode, file };
}

export function changeViewModeSettings({
  apply,
  viewMode,
  betaHome,
  env = process.env,
} = {}) {
  writeViewModeSettings({ viewMode, betaHome });
  const effective = readViewModeSettings({ betaHome, env });
  apply?.(effective);
  return effective;
}

export function parseViewModeCommand(message) {
  const command = typeof message === "string" ? message.trim() : "";
  if (command === "agent arena") {
    return { action: "set-view-mode", mode: "arena", original: message };
  }
  if (command === "herd") {
    return { action: "set-view-mode", mode: "herd", original: message };
  }
  return null;
}

function tilesPath(betaHome) {
  if (!betaHome) throw new Error("A beta home is required for dimension tiles.");
  return path.join(betaHome, "tiles");
}

function safeTileId(value) {
  const id = String(value || "");
  if (!DIMENSION_TILE_ID.test(id)) {
    throw new Error("A valid dimension tile id is required.");
  }
  return id;
}

function tilePath(betaHome, id) {
  return path.join(tilesPath(betaHome), `${safeTileId(id)}.json`);
}

function timestamp(value, fallback) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function tileTitle(turns, value) {
  const requested = String(value || "").trim();
  const firstUser = turns.find((turn) => turn.role === "user")?.text || "";
  const title = requested || firstUser.split(/\r?\n/, 1)[0].trim() || "Parked chat";
  return [...title].slice(0, 60).join("");
}

function normalizeTurn(value, fallbackAt) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Every dimension tile turn must be an object.");
  }
  if (!["user", "assistant"].includes(value.role)) {
    throw new Error("Dimension tile turns must use the user or assistant role.");
  }
  return {
    role: value.role,
    text: String(value.text || ""),
    html: String(value.html || ""),
    at: timestamp(value.at, fallbackAt),
    ...(value.pending === true ? { pending: true } : {}),
    ...(typeof value.requestId === "string" && value.requestId
      ? { requestId: value.requestId }
      : {}),
  };
}

function normalizeHistoryMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Every dimension tile history message must be an object.");
  }
  if (!["user", "assistant"].includes(value.role)) {
    throw new Error("Dimension tile history must use the user or assistant role.");
  }
  return {
    role: value.role,
    content: String(value.content || ""),
    ...(typeof value.requestId === "string" && value.requestId
      ? { requestId: value.requestId }
      : {}),
  };
}

function normalizeRoute(value) {
  const route = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  return {
    url: String(route.url || ""),
    rappid: String(route.rappid || ""),
    compositionHash: String(route.compositionHash || ""),
    model: String(route.model || "auto"),
  };
}

function normalizeArenaPlacement(value) {
  const placement = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const seat = Number(placement.seat);
  return {
    seat: Number.isInteger(seat) && seat >= 1 && seat <= 12 ? seat : null,
    faceUp: placement.faceUp !== false,
  };
}

function normalizeTileAgents(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("A dimension tile agent payload must be an array.");
  }
  const seen = new Set();
  return value.map((agent) => {
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
      throw new Error("Every dimension tile agent must be an object.");
    }
    const filename = String(agent.filename || "");
    if (
      path.basename(filename) !== filename
      || !DIMENSION_TILE_AGENT_FILE.test(filename)
      || filename === "basic_agent.py"
    ) {
      throw new Error("Dimension tile agents require safe *_agent.py filenames.");
    }
    if (seen.has(filename)) {
      throw new Error(`Dimension tile agent payload repeats ${filename}.`);
    }
    seen.add(filename);
    const source = String(agent.source || "");
    if (!source) {
      throw new Error(`Dimension tile agent ${filename} has no source payload.`);
    }
    return {
      filename,
      source,
      scope: String(agent.scope || "tile"),
    };
  });
}

export function normalizeDimensionTile(value, {
  id,
  now = new Date().toISOString(),
} = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A dimension tile must be an object.");
  }
  const tileId = safeTileId(id || value.id);
  const turns = Array.isArray(value.turns)
    ? value.turns.map((turn) => normalizeTurn(turn, now))
    : [];
  if (turns.length > MAX_DIMENSION_TILE_TURNS) {
    throw new Error(
      `Dimension tiles are limited to ${MAX_DIMENSION_TILE_TURNS} transcript turns.`,
    );
  }
  const history = Array.isArray(value.history)
    ? value.history.map(normalizeHistoryMessage)
    : [];
  const status = DIMENSION_TILE_STATUSES.has(value.status)
    ? value.status
    : "parked";
  const createdAt = timestamp(value.createdAt, now);
  const completedRequestIds = Array.isArray(value.completedRequestIds)
    ? [...new Set(value.completedRequestIds.map(String).filter(Boolean))].slice(-50)
    : [];
  return {
    schema: DIMENSION_TILE_SCHEMA,
    id: tileId,
    title: tileTitle(turns, value.title),
    createdAt,
    parkedAt: timestamp(value.parkedAt, now),
    route: normalizeRoute(value.route),
    turns,
    history,
    status,
    surface: DIMENSION_TILE_SURFACES.has(value.surface)
      ? value.surface
      : "herd",
    bunch: typeof value.bunch === "string"
      && DIMENSION_TILE_BUNCH_ID.test(value.bunch)
      ? value.bunch
      : null,
    agents: normalizeTileAgents(value.agents),
    arena: normalizeArenaPlacement(value.arena),
    restorable: value.restorable !== false,
    restoreError: value.restorable === false
      ? String(value.restoreError || "This tile has no observed wire history.")
      : null,
    raceId: typeof value.raceId === "string" && value.raceId
      ? value.raceId
      : null,
    completedRequestIds,
  };
}

function serializeTile(tile) {
  const serialized = `${JSON.stringify(tile, null, 2)}\n`;
  const size = Buffer.byteLength(serialized);
  if (size > MAX_DIMENSION_TILE_BYTES) {
    throw new Error(
      `Dimension tiles are limited to ${MAX_DIMENSION_TILE_BYTES} bytes; this tile is ${size} bytes.`,
    );
  }
  return serialized;
}

function atomicWriteTile(betaHome, tile) {
  const directory = tilesPath(betaHome);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Windows does not expose POSIX directory modes.
  }
  const file = tilePath(betaHome, tile.id);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, serializeTile(tile), { mode: 0o600 });
  renameSync(temporary, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows does not expose POSIX file modes.
  }
  return file;
}

function lastQuestion(tile) {
  const question = [...tile.turns]
    .reverse()
    .find((turn) => turn.role === "user")
    ?.text
    .trim();
  return question?.endsWith("?") ? question : null;
}

function sameUserAnchor(left, right) {
  if (!left || !right || left.role !== "user" || right.role !== "user") {
    return false;
  }
  if (left.requestId && right.requestId) return left.requestId === right.requestId;
  return left.text === right.text;
}

function mergePendingTurns(existingTurns, incomingTurns, completedRequestIds) {
  const merged = Array.isArray(incomingTurns) ? structuredClone(incomingTurns) : [];
  const completed = new Set(completedRequestIds);
  const representedRequestIds = new Set(
    merged.map((turn) => turn?.requestId).filter(Boolean),
  );
  let representedUnbound = merged.filter((turn) => (
    turn?.role === "assistant" && turn.pending && !turn.requestId
  )).length;

  existingTurns.forEach((turn, pendingIndex) => {
    if (turn.role !== "assistant" || !turn.pending) return;
    if (turn.requestId && completed.has(turn.requestId)) return;
    if (turn.requestId && representedRequestIds.has(turn.requestId)) return;
    if (!turn.requestId && representedUnbound > 0) {
      representedUnbound -= 1;
      return;
    }

    const anchor = existingTurns
      .slice(0, pendingIndex)
      .reverse()
      .find((candidate) => candidate.role === "user");
    if (!anchor) {
      merged.push(structuredClone(turn));
      return;
    }
    const occurrence = existingTurns
      .slice(0, pendingIndex)
      .filter((candidate) => sameUserAnchor(candidate, anchor))
      .length;
    let seen = 0;
    let anchorIndex = -1;
    for (let index = 0; index < merged.length; index += 1) {
      if (!sameUserAnchor(merged[index], anchor)) continue;
      seen += 1;
      if (seen === occurrence) {
        anchorIndex = index;
        break;
      }
    }
    if (anchorIndex < 0) {
      merged.push(structuredClone(turn));
      return;
    }
    let insertionIndex = anchorIndex + 1;
    while (merged[insertionIndex]?.pending) insertionIndex += 1;
    merged.splice(insertionIndex, 0, structuredClone(turn));
  });
  return merged;
}

export class DimensionTileStore {
  constructor({
    betaHome,
    idFactory = () => (
      `tile-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
    ),
    bunchIdFactory = () => `bunch-${randomUUID()}`,
    raceIdFactory = () => `race-${randomUUID()}`,
    now = () => new Date(),
  } = {}) {
    if (!betaHome) throw new Error("A beta home is required for dimension tiles.");
    this.betaHome = betaHome;
    this.idFactory = idFactory;
    this.bunchIdFactory = bunchIdFactory;
    this.raceIdFactory = raceIdFactory;
    this.now = now;
    this.undoEntries = new Map();
  }

  nowIso() {
    return this.now().toISOString();
  }

  list() {
    const directory = tilesPath(this.betaHome);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => /^tile-[a-z0-9][a-z0-9-]{5,120}\.json$/.test(name))
      .map((name) => {
        const id = name.slice(0, -5);
        try {
          return this.read(id);
        } catch (error) {
          return normalizeDimensionTile({
            id,
            title: `Unavailable tile: ${id}`,
            turns: [],
            history: [],
            status: "folded",
            arena: { faceUp: false },
            restorable: false,
            restoreError: String(error?.message || error),
          }, {
            id,
            now: new Date(0).toISOString(),
          });
        }
      })
      .sort((left, right) => (
        right.parkedAt.localeCompare(left.parkedAt)
        || left.id.localeCompare(right.id)
      ));
  }

  read(id) {
    const file = tilePath(this.betaHome, id);
    if (!existsSync(file)) {
      throw new Error(`Dimension tile ${safeTileId(id)} was not found.`);
    }
    const size = statSync(file).size;
    if (size > MAX_DIMENSION_TILE_BYTES) {
      throw new Error(
        `Dimension tile ${id} exceeds the ${MAX_DIMENSION_TILE_BYTES} byte limit.`,
      );
    }
    const source = readFileSync(file, "utf8");
    if (Buffer.byteLength(source) > MAX_DIMENSION_TILE_BYTES) {
      throw new Error(
        `Dimension tile ${id} exceeds the ${MAX_DIMENSION_TILE_BYTES} byte limit.`,
      );
    }
    let value;
    try {
      value = JSON.parse(source);
    } catch (error) {
      throw new Error(`Dimension tile ${id} is invalid: ${error.message}`);
    }
    if (value?.schema !== DIMENSION_TILE_SCHEMA) {
      throw new Error(`Dimension tile ${id} does not use ${DIMENSION_TILE_SCHEMA}.`);
    }
    return normalizeDimensionTile(value, { id });
  }

  nextSeat(excludeId = null) {
    const occupied = new Set(this.list()
      .filter((tile) => tile.id !== excludeId && tile.status !== "folded")
      .map((tile) => tile.arena.seat)
      .filter(Boolean));
    for (let seat = 1; seat <= 12; seat += 1) {
      if (!occupied.has(seat)) return seat;
    }
    return null;
  }

  save(value) {
    const tile = normalizeDimensionTile(value, {
      id: value.id,
      now: this.nowIso(),
    });
    atomicWriteTile(this.betaHome, tile);
    return tile;
  }

  clearOrphanedBunch(bunch) {
    if (!bunch) return;
    const members = this.list().filter((tile) => tile.bunch === bunch);
    if (members.length !== 1) return;
    members[0].bunch = null;
    this.save(members[0]);
  }

  park(value) {
    const now = this.nowIso();
    const id = value?.id || this.idFactory();
    const existing = value?.id && existsSync(tilePath(this.betaHome, id))
      ? this.read(id)
      : null;
    const completedRequestIds = [
      ...new Set([
        ...(existing?.completedRequestIds || []),
        ...(Array.isArray(value?.completedRequestIds)
          ? value.completedRequestIds
          : []),
      ]),
    ].slice(-50);
    const tile = normalizeDimensionTile({
      ...value,
      id,
      agents: value?.agents ?? existing?.agents ?? [],
      bunch: value?.bunch !== undefined ? value.bunch : existing?.bunch,
      completedRequestIds,
      createdAt: value?.createdAt || now,
      parkedAt: now,
      surface: value?.surface || existing?.surface || "herd",
      status: value?.status === "racing" ? "racing" : "parked",
      arena: {
        ...(value?.arena || {}),
        seat: value?.arena?.seat || this.nextSeat(id),
      },
      turns: existing
        ? mergePendingTurns(
            existing.turns,
            value?.turns,
            completedRequestIds,
          )
        : value?.turns,
    }, { id, now });
    atomicWriteTile(this.betaHome, tile);
    return tile;
  }

  parkExisting(id) {
    const tile = this.read(id);
    tile.status = "parked";
    tile.parkedAt = this.nowIso();
    return this.save(tile);
  }

  move(id, surface) {
    if (!DIMENSION_TILE_SURFACES.has(surface)) {
      throw new Error("A tile surface must be herd, arena, or binder.");
    }
    const tile = this.read(id);
    if (tile.status === "primary") {
      throw new Error("Move the primary chat by its title bar.");
    }
    const previousBunch = tile.bunch;
    tile.surface = surface;
    tile.bunch = null;
    tile.parkedAt = this.nowIso();
    const moved = this.save(tile);
    this.clearOrphanedBunch(previousBunch);
    return moved;
  }

  bunch(sourceId, targetId) {
    const source = this.read(sourceId);
    const target = this.read(targetId);
    if (source.id === target.id) {
      throw new Error("A tile cannot be bunched with itself.");
    }
    if (source.status === "primary" || target.status === "primary") {
      throw new Error("Only dormant tiles can be bunched.");
    }
    if (source.surface !== target.surface) {
      throw new Error("Tiles must share a surface before they can be bunched.");
    }
    const previousBunch = source.bunch;
    const bunch = target.bunch || this.bunchIdFactory();
    if (!DIMENSION_TILE_BUNCH_ID.test(bunch)) {
      throw new Error("A valid dimension tile bunch id is required.");
    }
    source.bunch = bunch;
    target.bunch = bunch;
    this.save(target);
    const result = {
      bunch,
      source: this.save(source),
      target: this.read(target.id),
    };
    if (previousBunch !== bunch) this.clearOrphanedBunch(previousBunch);
    return result;
  }

  complete(id, {
    at,
    history = null,
    html = "",
    model = null,
    requestId = null,
    reply,
    userInput = "",
  } = {}) {
    const tile = this.read(id);
    const completionId = String(requestId || "");
    if (completionId && tile.completedRequestIds.includes(completionId)) {
      return tile;
    }
    const completedAt = timestamp(at, this.nowIso());
    let pending = [...tile.turns]
      .reverse()
      .find((turn) => (
        turn.role === "assistant"
        && turn.pending
        && (!completionId || turn.requestId === completionId)
      ));
    if (!pending && completionId) {
      const unboundPending = tile.turns.filter((turn) => (
        turn.role === "assistant" && turn.pending && !turn.requestId
      ));
      if (unboundPending.length === 1) pending = unboundPending[0];
    }
    if (pending) {
      pending.text = String(reply || "");
      pending.html = String(html || "");
      pending.at = completedAt;
      if (completionId) pending.requestId = completionId;
      delete pending.pending;
    } else {
      const additions = userInput ? 2 : 1;
      if (tile.turns.length + additions > MAX_DIMENSION_TILE_TURNS) {
        throw new Error(
          `Dimension tiles are limited to ${MAX_DIMENSION_TILE_TURNS} transcript turns.`,
        );
      }
      if (userInput) {
        tile.turns.push({
          role: "user",
          text: String(userInput),
          html: "",
          at: completedAt,
          ...(completionId ? { requestId: completionId } : {}),
        });
      }
      tile.turns.push({
        role: "assistant",
        text: String(reply || ""),
        html: String(html || ""),
        at: completedAt,
        ...(completionId ? { requestId: completionId } : {}),
      });
    }
    if (Array.isArray(history)) {
      tile.history = history.map(normalizeHistoryMessage);
    } else {
      const userIndex = completionId
        ? tile.history.findIndex((message) => (
            message.role === "user" && message.requestId === completionId
          ))
        : -1;
      const assistant = {
        role: "assistant",
        content: String(reply || ""),
        ...(completionId ? { requestId: completionId } : {}),
      };
      if (userIndex >= 0) tile.history.splice(userIndex + 1, 0, assistant);
      else if (userInput) {
        tile.history.push({
          role: "user",
          content: String(userInput),
          ...(completionId ? { requestId: completionId } : {}),
        }, assistant);
      } else {
        tile.history.push(assistant);
      }
    }
    if (completionId) {
      tile.completedRequestIds = [
        ...tile.completedRequestIds,
        completionId,
      ].slice(-50);
    }
    if (model) tile.route.model = String(model);
    if (!tile.turns.some((turn) => turn.pending)) {
      for (const turn of tile.turns) delete turn.requestId;
      tile.history = tile.history.map((message) => ({
        role: message.role,
        content: message.content,
      }));
    }
    return this.save(tile);
  }

  fold(id) {
    const tile = this.read(id);
    const undoUntil = this.now().getTime() + DIMENSION_TILE_UNDO_MS;
    this.undoEntries.set(tile.id, {
      status: tile.status,
      faceUp: tile.arena.faceUp,
      undoUntil,
    });
    tile.status = "folded";
    tile.arena.faceUp = false;
    return {
      tile: this.save(tile),
      undoUntil: new Date(undoUntil).toISOString(),
    };
  }

  undo(id) {
    const tileId = safeTileId(id);
    const entry = this.undoEntries.get(tileId);
    if (!entry || this.now().getTime() > entry.undoUntil) {
      this.undoEntries.delete(tileId);
      throw new Error("The 10 second fold undo window has expired.");
    }
    const tile = this.read(tileId);
    tile.status = entry.status;
    tile.arena.faceUp = entry.faceUp;
    this.undoEntries.delete(tileId);
    return this.save(tile);
  }

  wake(id) {
    const target = this.read(id);
    if (!target.restorable) {
      throw new Error(target.restoreError || "This dimension tile cannot be restored.");
    }
    const raceId = target.status === "racing" ? target.raceId : null;
    for (const tile of this.list()) {
      if (tile.id === target.id) continue;
      if (
        raceId
        && tile.status === "racing"
        && tile.raceId === raceId
      ) {
        tile.status = "folded";
        tile.arena.faceUp = false;
        this.save(tile);
      } else if (tile.status === "primary") {
        tile.status = "parked";
        this.save(tile);
      }
    }
    const previousBunch = target.bunch;
    target.status = "primary";
    target.bunch = null;
    target.arena.faceUp = true;
    const primary = this.save(target);
    this.clearOrphanedBunch(previousBunch);
    return primary;
  }

  race(id) {
    const source = this.read(id);
    if (source.status === "racing") {
      throw new Error("This tile is already in an unresolved race.");
    }
    const question = lastQuestion(source);
    if (!question) {
      throw new Error("Race requires a tile whose last user turn is a question.");
    }
    const raceId = this.raceIdFactory();
    source.status = "racing";
    source.raceId = raceId;
    this.save(source);
    const now = this.nowIso();
    const contender = this.park({
      title: `${source.title} race`,
      route: source.route,
      agents: source.agents,
      turns: [
        {
          role: "user",
          text: question,
          html: "",
          at: now,
        },
        {
          role: "assistant",
          text: "Waiting for reply...",
          html: "",
          at: now,
          pending: true,
        },
      ],
      history: [{ role: "user", content: question }],
      status: "racing",
      surface: source.surface,
      bunch: null,
      arena: { faceUp: true },
      raceId,
    });
    return {
      contender,
      question,
      source: this.read(source.id),
    };
  }
}

export function registerDimensionTileIpc({
  activateTile = null,
  assertTrustedIpc,
  captureActivePayload = null,
  deactivatePrimary = null,
  ipcMain,
  isEnabled,
  store,
} = {}) {
  if (!ipcMain?.handle || !(store instanceof DimensionTileStore)) {
    throw new Error("Dimension tile IPC requires ipcMain and a DimensionTileStore.");
  }
  function trust(event) {
    assertTrustedIpc?.(event);
  }
  function guard(event) {
    trust(event);
    if (!isEnabled?.()) {
      throw new Error("Agent Arena is not active.");
    }
  }
  ipcMain.handle("beta:tiles-list", (event) => {
    guard(event);
    return store.list();
  });
  ipcMain.handle("beta:tiles-park", async (event, tile) => {
    guard(event);
    const payload = await captureActivePayload?.();
    return store.park({
      ...(tile || {}),
      ...(payload?.agents ? { agents: payload.agents } : {}),
      route: {
        ...(tile?.route || {}),
        ...(payload?.route || {}),
      },
    });
  });
  ipcMain.handle("beta:tiles-park-existing", (event, id) => {
    guard(event);
    return store.parkExisting(id);
  });
  ipcMain.handle("beta:tiles-wake", async (event, id) => {
    guard(event);
    const tile = store.read(id);
    const route = await activateTile?.(tile);
    const primary = store.wake(id);
    if (route?.compositionHash) {
      primary.route = {
        ...primary.route,
        url: String(route.url || primary.route.url),
        rappid: String(route.callerRappid || primary.route.rappid),
        compositionHash: String(route.transientCompositionHash
          || route.compositionHash),
      };
      return store.save(primary);
    }
    return primary;
  });
  ipcMain.handle("beta:tiles-deactivate", async (event) => {
    guard(event);
    await deactivatePrimary?.();
    return { ok: true };
  });
  ipcMain.handle("beta:tiles-move", (event, id, surface) => {
    guard(event);
    return store.move(id, surface);
  });
  ipcMain.handle("beta:tiles-bunch", (event, sourceId, targetId) => {
    guard(event);
    return store.bunch(sourceId, targetId);
  });
  ipcMain.handle("beta:tiles-fold", (event, id) => {
    guard(event);
    return store.fold(id);
  });
  ipcMain.handle("beta:tiles-undo", (event, id) => {
    guard(event);
    return store.undo(id);
  });
  ipcMain.handle("beta:tiles-race", (event, id) => {
    guard(event);
    return store.race(id);
  });
  ipcMain.handle("beta:tiles-complete", (event, id, completion) => {
    trust(event);
    if (!isEnabled?.()) {
      const requestId = String(completion?.requestId || "");
      const pending = store.read(id).turns.filter((turn) => (
        turn.role === "assistant" && turn.pending
      ));
      const identified = requestId && pending.some((turn) => (
        turn.requestId === requestId
      ));
      const singleUnbound = requestId
        && pending.length === 1
        && !pending[0].requestId;
      if (!identified && !singleUnbound) {
        throw new Error(
          "Only the identified reply for an existing pending tile may finish in herd mode.",
        );
      }
    }
    return store.complete(id, completion || {});
  });
}

function installArenaFrameBridge(settings) {
  const prior = window.__rappBetaArenaBridge;
  if (prior) {
    prior.update(settings);
    return true;
  }

  let current = settings;
  let activeTileId = null;
  let activeHistory = null;
  let conversationSequence = 0;
  let currentConversationId = null;
  let internalClear = false;
  let lastRequest = null;
  let nextRaceTileId = null;
  const completedRequests = new Map();
  const conversations = new Map();
  const pendingRequests = new Map();
  const upstreamFetch = window.fetch;
  window.__rappBetaDeferredTileCompletions ||= [];

  function removeToggle() {
    document.getElementById("beta-agent-arena-toggle")?.remove();
  }

  function renderToggle() {
    const panel = document.getElementById("beta-app-panel");
    if (!panel) return false;
    let button = document.getElementById("beta-agent-arena-toggle");
    if (!button) {
      button = document.createElement("button");
      button.id = "beta-agent-arena-toggle";
      button.className = "beta-panel-btn";
      button.type = "button";
      button.textContent = "Agent Arena";
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        window.parent.postMessage({
          type: "rapp-beta:set-view-mode",
          viewMode: {
            mode: current.mode === "arena" ? "herd" : "arena",
          },
        }, "*");
      });
      const updateButton = document.getElementById("beta-check-updates");
      panel.insertBefore(button, updateButton || null);
    }
    const arenaActive = current.mode === "arena";
    button.setAttribute("aria-pressed", String(arenaActive));
    button.textContent = `Agent Arena ${arenaActive ? "✓" : ""}`.trim();
    return true;
  }

  function sanitizedHtml(element) {
    const container = document.createElement("div");
    const sanitizer = typeof window.sanitizeMarkdownFragment === "function"
      ? window.sanitizeMarkdownFragment
      : null;
    if (sanitizer) {
      container.appendChild(sanitizer(String(element?.innerHTML || "")));
    } else {
      container.textContent = String(element?.textContent || "");
    }
    return container.innerHTML;
  }

  function replyHtml(text) {
    const source = typeof window.marked?.parse === "function"
      ? window.marked.parse(String(text || ""))
      : String(text || "");
    const holder = document.createElement("div");
    if (typeof window.sanitizeMarkdownFragment === "function") {
      holder.appendChild(window.sanitizeMarkdownFragment(source));
    } else {
      holder.textContent = String(text || "");
    }
    return holder.innerHTML;
  }

  function turnFromMessage(message, requestId = null) {
    const now = new Date().toISOString();
    const bubble = message.querySelector(".bubble") || message;
    return {
      role: message.classList.contains("user") ? "user" : "assistant",
      text: String(bubble.textContent || "").trim(),
      html: sanitizedHtml(bubble),
      at: now,
      ...(requestId ? { requestId } : {}),
    };
  }

  function transcriptTurns() {
    const chat = document.getElementById("chat");
    if (!chat) return [];
    const turns = [];
    for (const child of chat.children) {
      if (
        child.classList?.contains("msg")
        && (
          child.classList.contains("user")
          || child.classList.contains("assistant")
        )
        && !child.classList.contains("typing-indicator")
        && !child.classList.contains("stream-arriving")
        && !child.hasAttribute("data-rapp-provisional")
      ) {
        const turn = turnFromMessage(
          child,
          child.dataset.rappTileRequestId || null,
        );
        if (turn.text) turns.push(turn);
        continue;
      }
      if (!child.classList?.contains("response-slot")) continue;
      const requestId = child.dataset.rappTileRequestId || null;
      const replies = [...child.querySelectorAll(
        ":scope > .msg.assistant:not(.typing-indicator)"
          + ":not(.stream-arriving):not([data-rapp-provisional])",
      )];
      for (const reply of replies) {
        const turn = turnFromMessage(reply, requestId);
        if (turn.text) turns.push(turn);
      }
      if (!replies.length && requestId && pendingRequests.has(requestId)) {
        const request = pendingRequests.get(requestId);
        turns.push({
          role: "assistant",
          text: "Waiting for reply...",
          html: "",
          at: request.startedAt,
          pending: true,
          requestId,
        });
      }
    }
    return turns;
  }

  function startConversation(baseHistory = null) {
    if (!Array.isArray(baseHistory)) {
      currentConversationId = null;
      return null;
    }
    currentConversationId = `conversation-${++conversationSequence}`;
    const conversation = {
      baseHistory: structuredClone(baseHistory),
      requests: [],
    };
    conversations.set(currentConversationId, conversation);
    return conversation;
  }

  function ensureConversation(baseHistory) {
    return conversations.get(currentConversationId)
      || startConversation(baseHistory);
  }

  function canonicalHistory(conversationId = currentConversationId) {
    const conversation = conversations.get(conversationId);
    if (!conversation) return null;
    const history = structuredClone(conversation.baseHistory);
    for (const request of conversation.requests) {
      history.push({
        role: "user",
        content: request.userInput,
        requestId: request.id,
      });
      if (request.reply !== undefined) {
        history.push({
          role: "assistant",
          content: request.reply,
          requestId: request.id,
        });
      }
    }
    return history;
  }

  function wireHistory(messages) {
    return (Array.isArray(messages) ? messages : []).map((message) => ({
      role: message.role,
      content: String(message.content || ""),
    }));
  }

  function pendingHistory() {
    const observed = canonicalHistory();
    if (observed) return observed;
    return activeHistory ? structuredClone(activeHistory) : [];
  }

  function captureTile() {
    const turns = transcriptTurns();
    const pending = [...pendingRequests.values()]
      .filter((request) => !request.parkedTileId);
    const model = document.getElementById("model-select")?.value || "auto";
    const observedHistory = canonicalHistory();
    const hasObservedHistory = Boolean(
      observedHistory
      || activeHistory,
    );
    return {
      title: turns.find((turn) => turn.role === "user")?.text || "Parked chat",
      turns,
      history: observedHistory || pendingHistory(),
      model,
      pending: pending.length > 0,
      pendingRequestIds: pending.map((request) => request.id),
      restorable: hasObservedHistory || !turns.some((turn) => turn.role === "user"),
      restoreError: hasObservedHistory
        ? null
        : "This transcript predates Agent Arena, so its exact wire history was not observed.",
    };
  }

  function completionEvent(request) {
    return {
      type: "rapp-beta:tile-pending-complete",
      id: request.parkedTileId,
      requestId: request.id,
      completion: {
        ...request.completion,
        history: request.clearedFromKernel
          ? null
          : request.completion.history,
      },
      restoreInFrame: request.clearedFromKernel === true,
    };
  }

  function emitCompletion(request) {
    if (!request.parkedTileId || !request.completion) return;
    const deferred = window.__rappBetaDeferredTileCompletions;
    if (!deferred.some((entry) => entry.requestId === request.id)) {
      deferred.push(completionEvent(request));
      if (deferred.length > 50) deferred.splice(0, deferred.length - 50);
    }
    window.parent.postMessage(completionEvent(request), "*");
  }

  function drainDeferredCompletions() {
    for (const completion of window.__rappBetaDeferredTileCompletions || []) {
      window.parent.postMessage(completion, "*");
    }
  }

  function markPendingForTile(tileId, requestIds = []) {
    activeTileId = null;
    activeHistory = null;
    nextRaceTileId = null;
    const ids = requestIds.length
      ? requestIds
      : [...pendingRequests.keys()];
    for (const requestId of ids) {
      const request = pendingRequests.get(requestId)
        || completedRequests.get(requestId);
      if (!request) continue;
      request.parkedTileId = tileId;
      request.preserveOnClear = true;
      request.clearedFromKernel = true;
      emitCompletion(request);
    }
  }

  function clearKernel({ preservePending = false } = {}) {
    if (preservePending) {
      for (const request of pendingRequests.values()) {
        request.preserveOnClear = true;
      }
    }
    const clear = [...document.querySelectorAll("button")]
      .find((button) => button.textContent.trim() === "Clear");
    if (!clear) throw new Error("The Brainstem Clear button is unavailable.");
    internalClear = true;
    try {
      clear.click();
    } finally {
      internalClear = false;
    }
  }

  function renderTranscript(tile) {
    clearKernel();
    lastRequest = null;
    // Waking a tile abandons any race that was staged but never sent.
    nextRaceTileId = null;
    activeTileId = tile.id || null;
    activeHistory = Array.isArray(tile.history)
      ? structuredClone(tile.history)
      : [];
    startConversation(activeHistory);
    const modelSelect = document.getElementById("model-select");
    const model = String(tile.route?.model || "");
    if (
      modelSelect
      && model
      && [...modelSelect.options].some((option) => option.value === model)
      && modelSelect.value !== model
    ) {
      modelSelect.value = model;
      modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const chat = document.getElementById("chat");
    if (!chat) throw new Error("The Brainstem transcript is unavailable.");
    for (const turn of tile.turns || []) {
      if (turn.pending) continue;
      appendRestoredTurn(turn);
    }
    chat.classList.add("has-messages");
    chat.scrollTop = chat.scrollHeight;
    return true;
  }

  function appendRestoredTurn(turn) {
    const chat = document.getElementById("chat");
    if (!chat) throw new Error("The Brainstem transcript is unavailable.");
    let message = null;
    if (typeof window.appendMsg === "function") {
      message = window.appendMsg(turn.role, turn.text);
    } else {
      message = document.createElement("div");
      message.className = `msg ${turn.role}`;
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = turn.text;
      message.appendChild(bubble);
      chat.appendChild(message);
    }
    if (turn.requestId && message) {
      message.dataset.rappTileRequestId = turn.requestId;
    }
    const bubble = message?.querySelector?.(".bubble");
    if (bubble && turn.html) {
      bubble.replaceChildren(
        typeof window.sanitizeMarkdownFragment === "function"
          ? window.sanitizeMarkdownFragment(String(turn.html))
          : document.createTextNode(turn.text),
      );
    }
    chat.classList.add("has-messages");
    chat.scrollTop = chat.scrollHeight;
    return message;
  }

  function applyLateCompletion(completion) {
    const reply = String(completion?.reply || "");
    if (!reply) return;
    activeHistory ||= [];
    const last = activeHistory.at(-1);
    if (last?.role === "assistant" && last.content === reply) return;
    activeHistory.push({ role: "assistant", content: reply });
    const conversation = conversations.get(currentConversationId);
    if (conversation) {
      conversation.baseHistory = structuredClone(activeHistory);
    }
    appendRestoredTurn({
      role: "assistant",
      text: reply,
      html: String(completion.html || ""),
    });
  }

  function prepareRace(tileId, question) {
    clearKernel();
    activeTileId = tileId;
    activeHistory = null;
    startConversation([]);
    nextRaceTileId = tileId;
    const input = document.getElementById("input");
    if (!input) throw new Error("The Brainstem composer is unavailable.");
    input.value = String(question || "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  }

  function streamReply(text) {
    let reply = "";
    for (const frame of String(text || "").split(/\r?\n\r?\n/)) {
      const data = frame.split(/\r?\n/)
        .find((line) => line.startsWith("data:"));
      if (!data) continue;
      try {
        const value = JSON.parse(data.slice(5).trim());
        if (value.type === "done") {
          reply = value.response == null ? reply : String(value.response);
        }
      } catch {
        // Non-JSON keepalive and [DONE] frames do not carry a reply.
      }
    }
    return reply;
  }

  async function responseReply(response, pathname) {
    const text = await response.clone().text();
    if (pathname === "/chat/stream") return streamReply(text);
    try {
      const value = JSON.parse(text);
      return String(value.response || "");
    } catch {
      return "";
    }
  }

  async function observeCompletion(request, response, pathname) {
    try {
      const reply = await responseReply(response, pathname);
      if (!reply) return;
      request.reply = reply;
      request.completedHistory = canonicalHistory(request.conversationId)
        || [
          ...request.effectiveHistory,
          { role: "user", content: request.userInput },
          { role: "assistant", content: reply },
        ];
      request.completion = {
        reply,
        html: replyHtml(reply),
        at: new Date().toISOString(),
        history: request.completedHistory,
        model: request.model,
        requestId: request.id,
        userInput: request.userInput,
      };
      if (!request.parkedTileId) lastRequest = request;
      completedRequests.set(request.id, request);
      while (completedRequests.size > 50) {
        completedRequests.delete(completedRequests.keys().next().value);
      }
      emitCompletion(request);
    } finally {
      request.detachAbort?.();
      pendingRequests.delete(request.id);
      const conversation = conversations.get(request.conversationId);
      if (
        request.conversationId !== currentConversationId
        && conversation?.requests.every((entry) => entry.reply !== undefined)
      ) {
        conversations.delete(request.conversationId);
      }
    }
  }

  async function tileFetch(resource, options = {}) {
    let target;
    try {
      const raw = resource instanceof Request ? resource.url : String(resource);
      target = new URL(raw, window.location.href);
    } catch {
      return Reflect.apply(upstreamFetch, window, [resource, options]);
    }
    const method = String(
      options.method || (resource instanceof Request ? resource.method : "GET"),
    ).toUpperCase();
    const isChat = method === "POST"
      && (target.pathname === "/chat" || target.pathname === "/chat/stream")
      && typeof options.body === "string";
    if (!isChat) {
      return Reflect.apply(upstreamFetch, window, [resource, options]);
    }
    let body;
    try {
      body = JSON.parse(options.body);
    } catch {
      return Reflect.apply(upstreamFetch, window, [resource, options]);
    }
    if (typeof body.user_input !== "string") {
      return Reflect.apply(upstreamFetch, window, [resource, options]);
    }

    const incomingHistory = wireHistory(body.conversation_history);
    const effectiveHistory = activeHistory
      ? [...wireHistory(activeHistory), ...incomingHistory]
      : incomingHistory;
    body.conversation_history = effectiveHistory;
    const conversation = ensureConversation(effectiveHistory);

    const originalSignal = options.signal
      || (resource instanceof Request ? resource.signal : null);
    const controller = new AbortController();
    const request = {
      completedHistory: null,
      effectiveHistory: structuredClone(effectiveHistory),
      id: window.crypto.randomUUID(),
      conversationId: currentConversationId,
      parkedTileId: nextRaceTileId || activeTileId,
      preserveOnClear: Boolean(nextRaceTileId),
      model: document.getElementById("model-select")?.value || "auto",
      startedAt: new Date().toISOString(),
      userInput: body.user_input,
    };
    conversation.requests.push(request);
    const responseSlot = [...document.querySelectorAll(
      "#chat .response-slot",
    )].reverse().find((slot) => !slot.dataset.rappTileRequestId);
    if (responseSlot) responseSlot.dataset.rappTileRequestId = request.id;
    nextRaceTileId = null;
    const forwardAbort = () => {
      if (!request.preserveOnClear) controller.abort(originalSignal?.reason);
    };
    if (originalSignal) {
      if (originalSignal.aborted) forwardAbort();
      else originalSignal.addEventListener("abort", forwardAbort, { once: true });
      request.detachAbort = () => (
        originalSignal.removeEventListener("abort", forwardAbort)
      );
    }
    pendingRequests.set(request.id, request);
    lastRequest = request;
    const nextOptions = {
      ...options,
      body: JSON.stringify(body),
      signal: controller.signal,
    };
    try {
      const response = await Reflect.apply(
        upstreamFetch,
        window,
        [resource, nextOptions],
      );
      void observeCompletion(request, response, target.pathname);
      return response;
    } catch (error) {
      request.detachAbort?.();
      pendingRequests.delete(request.id);
      const failedConversation = conversations.get(request.conversationId);
      if (failedConversation) {
        failedConversation.requests = failedConversation.requests.filter(
          (entry) => entry.id !== request.id,
        );
      }
      throw error;
    }
  }

  function handleClear(event) {
    const button = event.target?.closest?.("button");
    if (
      !internalClear
      && button
      && button.textContent.trim() === "Clear"
    ) {
      if (activeTileId) {
        window.parent.postMessage({
          type: "rapp-beta:tile-detached",
          id: activeTileId,
        }, "*");
      }
      activeHistory = null;
      activeTileId = null;
      nextRaceTileId = null;
      lastRequest = null;
      startConversation(null);
    }
  }

  function disable() {
    removeToggle();
    document.removeEventListener("click", handleClear, true);
    window.removeEventListener("message", receive);
    if (window.fetch === tileFetch) window.fetch = upstreamFetch;
    if (activeTileId) {
      for (const request of pendingRequests.values()) {
        if (request.parkedTileId === activeTileId) {
          request.preserveOnClear = true;
          request.clearedFromKernel = true;
        }
      }
      clearKernel({ preservePending: true });
    }
    startConversation(null);
    activeTileId = null;
    activeHistory = null;
    nextRaceTileId = null;
    delete window.__rappBetaArenaBridge;
  }

  function receive(event) {
    if (event.source !== window.parent || !event.data) return;
    if (event.data.type === "rapp-beta:view-mode-state") {
      current = event.data.viewMode || current;
      if (current.mode !== "arena") {
        disable();
      } else {
        renderToggle();
      }
      return;
    }
    if (event.data.type === "rapp-beta:tile-capture") {
      try {
        event.source.postMessage({
          type: "rapp-beta:tile-capture-result",
          requestId: event.data.requestId,
          ok: true,
          tile: captureTile(),
        }, "*");
      } catch (error) {
        event.source.postMessage({
          type: "rapp-beta:tile-capture-result",
          requestId: event.data.requestId,
          ok: false,
          error: String(error?.message || error),
        }, "*");
      }
      return;
    }
    if (event.data.type === "rapp-beta:tile-parked") {
      markPendingForTile(event.data.id, event.data.requestIds || []);
      clearKernel({ preservePending: true });
      startConversation(null);
      return;
    }
    if (event.data.type === "rapp-beta:tile-wake") {
      renderTranscript(event.data.tile || {});
      return;
    }
    if (event.data.type === "rapp-beta:tile-clear") {
      clearKernel();
      activeTileId = null;
      activeHistory = null;
      nextRaceTileId = null;
      lastRequest = null;
      startConversation(null);
      return;
    }
    if (event.data.type === "rapp-beta:tile-late-completion") {
      applyLateCompletion(event.data.completion);
      return;
    }
    if (event.data.type === "rapp-beta:tile-completion-ack") {
      completedRequests.delete(event.data.requestId);
      window.__rappBetaDeferredTileCompletions = (
        window.__rappBetaDeferredTileCompletions || []
      ).filter((entry) => entry.requestId !== event.data.requestId);
      return;
    }
    if (event.data.type === "rapp-beta:tile-ready") {
      drainDeferredCompletions();
      return;
    }
    if (event.data.type === "rapp-beta:tile-race") {
      prepareRace(event.data.id, event.data.question);
    }
  }

  const bridge = {
    capture: captureTile,
    disable,
    renderTranscript,
    update(next) {
      current = next;
      renderToggle();
    },
  };
  window.__rappBetaArenaBridge = bridge;
  window.fetch = tileFetch;
  document.addEventListener("click", handleClear, true);
  window.addEventListener("message", receive);
  renderToggle();
  window.setTimeout(drainDeferredCompletions, 100);
  window.setTimeout(drainDeferredCompletions, 500);
  return true;
}

function installTileDragFrameBridge(settings) {
  const prior = window.__rappBetaTileDragBridge;
  if (prior) {
    prior.update(settings);
    return true;
  }

  let current = settings;
  let armedTileId = null;
  let armedTileLabel = "Make primary";
  const controller = new AbortController();
  const header = document.querySelector("header");
  const headerAttributes = header ? {
    ariaKeyshortcuts: header.getAttribute("aria-keyshortcuts"),
    dataDrive: header.getAttribute("data-drive"),
    draggable: header.getAttribute("draggable"),
    tabindex: header.getAttribute("tabindex"),
  } : null;
  const dropOverlay = document.getElementById("drop-overlay");
  const dropOverlayText = dropOverlay
    ? [...dropOverlay.childNodes].find((node) => (
        node.nodeType === Node.TEXT_NODE && node.nodeValue.trim()
      ))
    : null;
  const originalDropOverlayText = dropOverlayText?.nodeValue || "";

  function restoreAttribute(element, name, value) {
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  }

  function showDropOverlay() {
    if (!dropOverlay || !dropOverlayText) return;
    dropOverlayText.nodeValue = ` ${armedTileLabel} `;
    dropOverlay.style.display = "flex";
  }

  function hideDropOverlay() {
    if (!dropOverlay || !dropOverlayText) return;
    dropOverlay.style.display = "none";
    dropOverlayText.nodeValue = originalDropOverlayText;
  }

  function realDragLeave(event) {
    return event.relatedTarget === null
      || event.clientX <= 0
      || event.clientY <= 0
      || event.clientX >= window.innerWidth
      || event.clientY >= window.innerHeight;
  }

  function incomingTileId(event) {
    return event.dataTransfer?.getData("application/x-rapp-dimension-tile")
      || armedTileId;
  }

  function disable() {
    controller.abort();
    window.removeEventListener("message", receive);
    hideDropOverlay();
    if (header && headerAttributes) {
      restoreAttribute(header, "aria-keyshortcuts", headerAttributes.ariaKeyshortcuts);
      restoreAttribute(header, "data-drive", headerAttributes.dataDrive);
      restoreAttribute(header, "draggable", headerAttributes.draggable);
      restoreAttribute(header, "tabindex", headerAttributes.tabindex);
    }
    delete window.__rappBetaTileDragBridge;
  }

  function receive(event) {
    if (event.source !== window.parent || !event.data) return;
    if (event.data.type === "rapp-beta:view-mode-state") {
      current = event.data.viewMode || current;
      if (current.mode !== "arena") disable();
      return;
    }
    if (event.data.type === "rapp-beta:tile-drag-armed") {
      armedTileId = String(event.data.id || "");
      armedTileLabel = String(event.data.label || "Make primary");
      return;
    }
    if (event.data.type === "rapp-beta:tile-drag-disarmed") {
      armedTileId = null;
      hideDropOverlay();
      return;
    }
    if (event.data.type === "rapp-beta:tile-ready") {
      window.parent.postMessage({ type: "rapp-beta:tile-frame-ready" }, "*");
    }
  }

  if (header) {
    header.draggable = true;
    header.tabIndex = 0;
    header.dataset.drive = "brainstem.primary";
    header.setAttribute("aria-keyshortcuts", "H A B");
    header.addEventListener("dragstart", (event) => {
      if (event.target.closest?.("button,select,a,input")) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-rapp-brainstem-chat", "primary");
      window.parent.postMessage({ type: "rapp-beta:chat-drag-start" }, "*");
    }, { signal: controller.signal });
    header.addEventListener("dragend", () => {
      window.parent.postMessage({ type: "rapp-beta:chat-drag-end" }, "*");
    }, { signal: controller.signal });
    header.addEventListener("keydown", (event) => {
      if (event.target !== header) return;
      const surface = {
        h: "herd",
        a: "arena",
        b: "binder",
      }[event.key.toLowerCase()];
      if (!surface) return;
      event.preventDefault();
      window.parent.postMessage({
        type: "rapp-beta:tile-keyboard-park",
        surface,
      }, "*");
    }, { signal: controller.signal });
  }

  window.addEventListener("dragover", (event) => {
    if (!incomingTileId(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    showDropOverlay();
  }, { signal: controller.signal });
  window.addEventListener("dragleave", (event) => {
    if (realDragLeave(event)) hideDropOverlay();
  }, { signal: controller.signal });
  window.addEventListener("drop", (event) => {
    const id = incomingTileId(event);
    if (!id) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    hideDropOverlay();
    armedTileId = null;
    window.parent.postMessage({
      type: "rapp-beta:tile-drop-primary",
      actor: event.__rappAutopilotActor
        || (window.__rappAutopilotEvents?.has(event) ? "ai" : "user"),
      id,
    }, "*");
  }, { signal: controller.signal });
  window.addEventListener("message", receive);

  window.__rappBetaTileDragBridge = {
    disable,
    update(next) {
      current = next;
      if (current.mode !== "arena") disable();
    },
  };
  window.parent.postMessage({ type: "rapp-beta:tile-frame-ready" }, "*");
  return true;
}

export function composeDimensionTilesFrameBridgeSource(checkpointSource, viewMode) {
  const source = String(checkpointSource || "");
  if (viewMode?.mode !== "arena") return source;
  const settings = JSON.stringify(normalizeViewModeSettings(viewMode));
  return `${source}\n;(${installArenaFrameBridge.toString()})(${settings});`
    + `\n;(${installTileDragFrameBridge.toString()})(${settings});`;
}
