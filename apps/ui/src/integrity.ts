import { frameVerificationSchema, twinBasisSchema, type TwinDraft } from "./model";

export type IntegrityState = "verified" | "unverified" | "unavailable";
export function proposalIntegrity(proposal: TwinDraft | undefined, workspaceId: string | null, connected = true): {
  state: IntegrityState; detail: string;
} {
  if (!connected) return { state: "unavailable", detail: "Reconnect and scan the canonical proposal before review." };
  if (!proposal || proposal.workspaceId !== workspaceId)
    return { state: "unverified", detail: "The proposal does not belong to this workspace." };
  const basis = twinBasisSchema.safeParse(proposal.basis);
  if (!basis.success || basis.data.workspaceId !== workspaceId)
    return { state: "unverified", detail: "A canonical, workspace-bound proposal basis is required." };
  const verification = frameVerificationSchema.safeParse(basis.data.verification);
  if (!verification.success) return { state: "unverified", detail: "A canonical source and linked evidence scan is required." };
  if (verification.data.state !== "verified") return verification.data;
  const verified = verification.data;
  if (verified.workspaceId !== workspaceId
    || !basis.data.heads.some((head) => head.scope.workspaceId === verified.sourceWorkspaceId)
    || (workspaceId !== null && verified.sourceWorkspaceId !== workspaceId)) {
    return { state: "unverified", detail: "The verified source belongs to another workspace." };
  }
  return { state: "verified", detail: "Local RAPP/1 source, linked evidence, and publication integrity — not factual accuracy, authorship, or promotion-grade trust." };
}
