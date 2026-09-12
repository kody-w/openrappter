import { describe, expect, it } from "vitest";
import { parseGuestRequest, sandboxArguments } from "../src/guest-helper.js";

const request = () => ({
  version: 1, action: "execute", root: "/workspaces/workspace-a",
  workspace: { agentId: "agent-a", workspaceId: "workspace-a" }, intentRef: "a".repeat(64),
  hostKey: "pinned-by-ssh", request: { argv: ["/usr/bin/printf", "guest output"], cwd: "/workspaces/workspace-a",
    timeoutMs: 1000, maxOutputBytes: 4096, readOnly: false },
});
describe("Omarchy workspace execution helper", () => {
  it("mounts only the scoped workspace in a new PID/user/mount namespace with an empty environment", () => {
    const args = sandboxArguments(parseGuestRequest(request()));
    expect(args).toEqual(expect.arrayContaining(["--unshare-all", "--new-session", "--die-with-parent", "--clearenv"]));
    expect(args.slice(args.indexOf("--bind"), args.indexOf("--bind") + 3)).toEqual(["--bind", "/workspaces/workspace-a", "/workspace"]);
    expect(args).not.toContain("/workspaces");
    expect(args).not.toContain("/Users");
    expect(args.slice(-3)).toEqual(["--", "/usr/bin/printf", "guest output"]);
  });
  it("binds read-only agents' workspaces read-only, not by trusting a command's name", () => {
    const value = request(); value.request.readOnly = true;
    const args = sandboxArguments(parseGuestRequest(value));
    expect(args).not.toContain("--bind");
    const index = args.indexOf("/workspaces/workspace-a");
    expect(args[index - 1]).toBe("--ro-bind");
  });
  it.each(["/workspaces/workspace-b", "/workspaces/workspace-a/../workspace-b", "/etc", "/workspaces/workspace-a//nested"])("rejects cwd %s", (cwd) => {
    const value = request(); value.request.cwd = cwd;
    expect(() => parseGuestRequest(value)).toThrow("guest_request_rejected");
  });
  it("rejects wrong-root identity and unbounded commands before constructing an invocation", () => {
    const value = request(); value.workspace.workspaceId = "workspace-b";
    expect(() => parseGuestRequest(value)).toThrow();
    const excessive = request(); excessive.request.timeoutMs = 30001;
    expect(() => parseGuestRequest(excessive)).toThrow();
  });
});
