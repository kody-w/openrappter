export function exactRapp1Success(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || typeof value.response !== "string"
    || typeof value.session_id !== "string"
    || !value.session_id
  ) {
    throw new Error("invalid success envelope");
  }
  let agentLogs;
  if (Array.isArray(value.agent_logs) && value.agent_logs.every((entry) => (
    typeof entry === "string"
  ))) {
    agentLogs = value.agent_logs;
  } else if (typeof value.agent_logs === "string") {
    agentLogs = value.agent_logs ? [value.agent_logs] : [];
  } else {
    throw new Error("invalid agent_logs");
  }
  return {
    response: value.response,
    agent_logs: agentLogs,
    session_id: value.session_id,
  };
}
