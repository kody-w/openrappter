import assert from "node:assert/strict";
import test from "node:test";

import { humanizeAgentName } from "../electron/agent-display.mjs";

test("agent display names split CamelCase while preserving acronyms", () => {
  assert.equal(
    humanizeAgentName("TimeEntryBillingWorkshop"),
    "Time Entry Billing Workshop",
  );
  assert.equal(humanizeAgentName("DailyCloseout"), "Daily Closeout");
  assert.equal(humanizeAgentName("ManageMemory"), "Manage Memory");
  assert.equal(
    humanizeAgentName("NBCUFinanceReportingCopilot"),
    "NBCU Finance Reporting Copilot",
  );
  assert.equal(
    humanizeAgentName("SalesQualificationAgent"),
    "Sales Qualification Agent",
  );
  assert.equal(
    humanizeAgentName("DailyHackernewsDigest"),
    "Daily Hackernews Digest",
  );
  assert.equal(humanizeAgentName("RARRemoteAgent"), "RAR Remote Agent");
  assert.equal(humanizeAgentName("RBoxKnowledgeSync"), "R Box Knowledge Sync");
});
