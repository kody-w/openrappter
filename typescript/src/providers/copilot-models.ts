/**
 * Conservative fallback catalog used when account-scoped discovery is
 * unavailable. CopilotAuthority applies account and grant policy to this list.
 */
export const COPILOT_DEFAULT_MODELS = [
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o",
  "gpt-4o-mini",
  "o1",
  "o1-mini",
  "o3",
  "o3-mini",
  "o4-mini",
  "claude-3.5-sonnet",
  "claude-3.7-sonnet",
  "claude-3.7-sonnet-thought",
  "claude-sonnet-4",
  "gemini-2.0-flash",
  "gemini-2.5-pro",
] as const;

export const COPILOT_DEFAULT_MODEL = "gpt-4.1";
