import { sha256 } from "./reader.js";
import { MigrationError } from "./types.js";
import type {
  ImportPlan, ImportPlanItem, InertLegacyReaderPort, InertValue,
  InventoryFile, LegacyKind, LegacySource, MigrationInventory, ReviewRecord,
} from "./types.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function field(value: Record<string, unknown>, key: string, required = false): string | undefined {
  const found = Object.hasOwn(value, key) ? value[key] : undefined;
  if (found === undefined && !required) return undefined;
  if (typeof found !== "string" || found.length > 65_536 || (required && found.trim().length === 0)) {
    throw new MigrationError("record_requires_manual_review");
  }
  return found;
}

function sanitize(kind: LegacyKind, input: unknown): { data: Record<string, InertValue>; warnings: string[] } {
  if (!record(input)) throw new MigrationError("record_requires_manual_review");
  const warnings = ["untrusted_source_data", "not_evidence_of_completed_work"];
  if (Object.keys(input).some((key) => /^(?:code|script|source|module|entrypoint|executable|tools|permissions|policy|workspace|workspaceId|path)$/iu.test(key))) {
    warnings.push("executable_and_authority_fields_excluded");
  }
  if (kind === "agent") {
    const name = field(input, "name", true)!;
    const instructions = field(input, "instructions") ?? field(input, "description") ?? "";
    warnings.push("agent_disabled", "workspace_and_tool_policy_review_required");
    return { data: { kind, name, instructions, enabled: false, policyReviewRequired: true }, warnings };
  }
  if (kind === "task") {
    const title = field(input, "title", true)!;
    const description = field(input, "description") ?? "";
    const legacyStatus = field(input, "status") ?? "unknown";
    return { data: { kind, title, description, status: "draft", legacyStatus }, warnings };
  }
  const content = field(input, "content", true)!;
  const tags = Array.isArray(input.tags) ? input.tags.filter((tag) => typeof tag === "string" && tag.length <= 80).slice(0, 32) : [];
  return { data: { kind, content, tags: tags as string[], trusted: false }, warnings };
}

export class LegacyMigration {
  private readonly inventories = new WeakMap<MigrationInventory, ReadonlyMap<string, LegacySource>>();
  private readonly maxFileBytes: number;
  private readonly maxRecords: number;
  private readonly now: () => Date;

  constructor(
    private readonly reader: InertLegacyReaderPort,
    options: { readonly maxFileBytes?: number; readonly maxRecords?: number; readonly now?: () => Date } = {},
  ) {
    if (!reader || typeof reader.discover !== "function" || typeof reader.read !== "function") {
      throw new MigrationError("missing_inert_reader");
    }
    this.maxFileBytes = options.maxFileBytes ?? 8_388_608;
    this.maxRecords = options.maxRecords ?? 10_000;
    if (!Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes < 1 || this.maxFileBytes > 67_108_864
      || !Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1 || this.maxRecords > 100_000) {
      throw new MigrationError("invalid_migration_limits");
    }
    this.now = options.now ?? (() => new Date());
  }

  async inventory(explicitRoots: readonly string[]): Promise<MigrationInventory> {
    if (!Array.isArray(explicitRoots) || explicitRoots.length > 32) throw new MigrationError("explicit_roots_required");
    const sources = explicitRoots.length === 0 ? [] : await this.reader.discover(Object.freeze([...explicitRoots]));
    if (sources.length > 128 || new Set(sources.map((source) => source.id)).size !== sources.length) {
      throw new MigrationError("invalid_source_inventory");
    }
    const files: InventoryFile[] = [];
    const records: ReviewRecord[] = [];
    const sourceMap = new Map<string, LegacySource>();
    let inspectedRecords = 0;
    for (const source of sources) {
      if (!["json", "jsonl"].includes(source.format) || !["agent", "task", "memory"].includes(source.kind)) {
        throw new MigrationError("source_not_inert");
      }
      let bytes: Uint8Array;
      let modifiedAt: string;
      try {
        ({ bytes, modifiedAt } = await this.reader.read(source, this.maxFileBytes));
      } catch {
        files.push({ source, status: "unreadable", reason: "source_unreadable" });
        continue;
      }
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > this.maxFileBytes || !Number.isFinite(Date.parse(modifiedAt))) {
        throw new MigrationError("invalid_source_read");
      }
      const sourceHash = sha256(bytes);
      let values: unknown[];
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (source.format === "jsonl") {
          const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
          if (lines.length + inspectedRecords > this.maxRecords) throw new MigrationError("record_limit_exceeded");
          values = lines.map((line) => JSON.parse(line) as unknown);
        } else {
          const parsed: unknown = JSON.parse(text);
          values = Array.isArray(parsed) ? parsed : [parsed];
        }
      } catch (error) {
        if (error instanceof MigrationError) throw error;
        files.push({ source, sourceHash, modifiedAt, status: "rejected", reason: "invalid_inert_json" });
        continue;
      }
      inspectedRecords += values.length;
      if (inspectedRecords > this.maxRecords) throw new MigrationError("record_limit_exceeded");
      const start = records.length;
      let rejected = false;
      for (const [index, value] of values.entries()) {
        try {
          const { data, warnings } = sanitize(source.kind, value);
          const entry: ReviewRecord = {
            id: `${source.id}:${index}`, sourceId: source.id, sourceHash, sourceModifiedAt: modifiedAt,
            index, kind: source.kind, data, warnings,
          };
          records.push(entry);
          sourceMap.set(entry.id, source);
        } catch { rejected = true; }
      }
      files.push({
        source, sourceHash, modifiedAt, status: records.length > start ? "reviewable" : "rejected",
        ...(rejected ? { reason: "some_records_require_manual_review" } : {}),
      });
    }
    const inventory: MigrationInventory = freeze({
      schema: "rapp-work.migration-inventory/v1", authoritative: false, files, records,
    });
    this.inventories.set(inventory, sourceMap);
    return inventory;
  }

  async plan(
    inventory: MigrationInventory,
    selectedRecordIds: readonly string[],
    target: { readonly agentId: string; readonly workspaceId: string },
  ): Promise<ImportPlan> {
    const sources = this.inventories.get(inventory);
    if (!sources || !Array.isArray(selectedRecordIds) || new Set(selectedRecordIds).size !== selectedRecordIds.length
      || !target || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(target.agentId)
      || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(target.workspaceId)) {
      throw new MigrationError("invalid_review_selection");
    }
    const entries = selectedRecordIds.map((id) => {
      const entry = inventory.records.find((record) => record.id === id);
      if (!entry || !sources.has(id)) throw new MigrationError("unknown_review_record");
      return entry;
    });
    const reread = new Set<string>();
    for (const entry of entries) {
      if (reread.has(entry.sourceId)) continue;
      const current = await this.reader.read(sources.get(entry.id)!, this.maxFileBytes);
      if (current.bytes.byteLength > this.maxFileBytes || sha256(current.bytes) !== entry.sourceHash
        || current.modifiedAt !== entry.sourceModifiedAt) throw new MigrationError("review_source_changed");
      reread.add(entry.sourceId);
    }
    const plannedAt = this.now().toISOString();
    const items: ImportPlanItem[] = entries.map((entry) => {
      const targetPath = `imports/${entry.sourceHash}-${sha256(entry.sourceId)}-${entry.index}.json`;
      const content = `${JSON.stringify({
        schema: "rapp-work.inert-import/v1",
        sourceHash: entry.sourceHash, sourceModifiedAt: entry.sourceModifiedAt,
        kind: entry.kind, data: entry.data,
      }, null, 2)}\n`;
      return {
        recordId: entry.id, targetPath, content, sha256: sha256(content),
        proposedEvent: {
          type: "migration.import.proposed", sourceHash: entry.sourceHash,
          sourceModifiedAt: entry.sourceModifiedAt, plannedAt, targetPath,
          artifactHash: sha256(content), kind: entry.kind, reviewRequired: true,
        },
      };
    });
    return freeze({
      schema: "rapp-work.import-plan/v1", mode: "review-only", authoritative: false,
      requiresAuthorization: true, target: { agentId: target.agentId, workspaceId: target.workspaceId },
      items, sourceDisposition: "leave-unchanged",
    });
  }
}
