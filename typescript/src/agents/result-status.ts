export function agentResultIsError(result: unknown): boolean {
  if (typeof result !== "string") return false;
  try {
    const parsed = JSON.parse(result) as { status?: unknown };
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.status === "string" &&
      parsed.status.toLowerCase() === "error"
    );
  } catch {
    return false;
  }
}
