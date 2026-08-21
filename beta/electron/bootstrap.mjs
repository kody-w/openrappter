import { installProcessOutputRedaction } from "./log-redaction.mjs";

const outputRedaction = installProcessOutputRedaction();
process.once("exit", () => outputRedaction.flush());

await import("./main.mjs");
