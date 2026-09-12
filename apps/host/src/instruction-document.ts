import { ModelProviderError } from "@rapp-work/model-provider";
import type { TwinProposal, TwinTurn } from "./contracts.js";
import { digest } from "./persistence.js";

export const INSTRUCTION_DOCUMENT_REF = "rapp-work:verbatim-instruction-document";
export interface InstructionDocument {
  text: string;
  turnId: string;
  contentHash: string;
  name: string | null;
  maximumComputerPolicy: "none" | "read-only" | "control";
  requireDisabled: boolean;
  forbidRoutines: boolean;
}
export function instructionDocument(text: string, turnId: string): InstructionDocument | null {
  const heading = /(?:^|\n)[ \t]*#{1,3}[ \t]+([^\r\n]+)/.exec(text);
  if (!heading || !/\b(?:agent|instructions|responsibilities)\b/i.test(heading[1]!)) return null;
  const start = heading.index + (heading[0].startsWith("\n") ? 1 : 0);
  const document = text.slice(0, start).trim() === "" ? text : text.slice(start);
  const title = heading[1]!.replace(/[ \t]+#+[ \t]*$/, "").replace(
    /\s+(?:—|–|-)\s+(?:(?:manual|global)\s+)*instructions\b.*$/i, "",
  ).trim();
  const noTools = /\b(?:no computer(?: access)?|no tool(?:s| execution)?|(?:do not|never)\s+(?:use (?:the |a )?(?:computer|tools)|execute tools|run (?:any )?(?:shell )?commands))\b/i.test(document);
  const readOnly = /\bread[- ]only\b/i.test(document);
  const control = /\b(?:computer (?:access|policy)\s*:\s*control|control (?:the |an? )?(?:agent )?computer)\b/i.test(document);
  return {
    text: document, turnId, contentHash: digest(document),
    name: /\bagent\b/i.test(title) && title.length <= 160 ? title : null,
    maximumComputerPolicy: noTools ? "none" : readOnly ? "read-only" : control ? "control" : "none",
    requireDisabled: /\b(?:start disabled|remain disabled|disabled until|do not enable|manual activation)\b/i.test(document),
    forbidRoutines: /\b(?:(?:do not|never)\s+(?:create |enable )?(?:schedules?|routines?|automations?)|no (?:schedules?|routines?|automations?)|manual (?:execution )?only)\b/i.test(document),
  };
}
export function selectInstructionDocument(message: string, turnId: string, turns: readonly TwinTurn[], followup: boolean): InstructionDocument | null {
  const current = instructionDocument(message, turnId);
  if (current || !followup) return current;
  for (const turn of [...turns].reverse()) {
    if (turn.role !== "user") continue;
    const document = instructionDocument(turn.content, turn.id);
    if (document) return document;
  }
  return null;
}
export function bindInstructionDocument(proposal: TwinProposal, document: InstructionDocument): TwinProposal {
  const invalid = () => { throw new ModelProviderError("invalid_structured_output"); };
  if (proposal.kind === "clarification") {
    if (proposal.missing.some((field) => /^(?:instructions?|instructionDocument|agentName|name|role|agentRole)$/i.test(field)
      && (document.name !== null || !/name/i.test(field)))) invalid();
    return proposal;
  }
  if (proposal.kind !== "agent" && proposal.kind !== "workspace") return invalid();
  const agent = proposal.kind === "agent" ? proposal.draft : proposal.draft.leadAgent;
  if (agent.instructions !== INSTRUCTION_DOCUMENT_REF && agent.instructions !== document.text) invalid();
  if (document.name !== null && agent.name !== document.name) invalid();
  const rank = { none: 0, "read-only": 1, control: 2 };
  if (rank[agent.computerPolicy] > rank[document.maximumComputerPolicy] || agent.approvalPolicy !== "always"
    || (document.requireDisabled && agent.enabled)) invalid();
  const routines = proposal.kind === "agent" ? proposal.draft.suggestedRoutines ?? [] : proposal.draft.starterRoutines;
  if ((document.forbidRoutines && routines.length) || routines.some((routine) => routine.enabled)) invalid();
  agent.instructions = document.text;
  return proposal;
}

export function boundedConversation(turns: readonly TwinTurn[], document: InstructionDocument | null) {
  const selected: { role: "user" | "assistant"; content: string }[] = [];
  let budget = 24_000;
  for (const turn of [...turns].reverse()) {
    const content = turn.id === document?.turnId ? `Instruction document retained as ${INSTRUCTION_DOCUMENT_REF}.` : turn.content;
    if (content.length > budget) continue;
    selected.unshift({ role: turn.role, content });
    budget -= content.length;
    if (selected.length === 24) break;
  }
  return selected;
}
