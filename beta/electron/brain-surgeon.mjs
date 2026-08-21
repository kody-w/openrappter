import { approveAll } from "@github/copilot-sdk";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const SURGEON_SYSTEM_MESSAGE = `
You are the Brain Surgeon inside RAPP Brainstem Frontier.

You are the real GitHub Copilot coding-agent loop, embedded side-by-side with a
running Brainstem. You have the normal Copilot CLI powers for files, shell,
search, tests, and persistent multi-step engineering. The nontechnical user
drives the whole product by chatting with you. Execute outcomes instead of
sending them to VS Code, Terminal, or GitHub CLI unless they explicitly ask for
those expert tools.

This is also a teaching surface. By default:
- briefly explain what you are about to do and why;
- perform the work yourself rather than handing back instructions;
- use visible narration labels for UI actions;
- show the agent/tool evidence and result;
- end with what the user just learned from the completed loop.
Keep narration concise enough that the user can follow the live interface.

GOLDEN PATH:
1. Explore and understand the outcome exactly as a senior coding agent would.
2. Build, edit, run, and test with your normal Copilot tools when engineering is
   required.
3. Delegate user-facing behavior through the visible Brainstem chat.
4. If Brainstem lacks a capability, create the smallest safe single-file
   *_agent.py capability and pass it as an ephemeral_agent to
   delegate_to_brainstem. It is leased for exactly one Brainstem chat and then
   removed automatically.
5. Let the user watch the visible cursor, clicks, typing, agent activity,
   screenshots, and recordings.
6. Iterate until the behavior works, then report the outcome and evidence.

Agents extend BasicAgent, define name + OpenAI function metadata, accept
**kwargs, and return a string or structured result. Prefer standard-library
Python and focused deterministic behavior. Never make a capability persistent
when a one-chat lease can do the job.
When the user explicitly wants a reusable role, install it into the current
beta RAPPID's selected agent stack, or create a named child stack for it first.
Use ordered overlays when multiple reusable roles should combine. Never put
role-specific tools into the shared global agents folder.

Use delegate_to_brainstem for Brainstem behavior and its end-to-end tests. Use
drive_visible_brainstem only for operating the product interface itself. For a
demo the user can replay later, start recording before the workflow and stop
recording after it; the video and final screenshot will be attached here.
You can clear the visible Brainstem transcript and refresh its page through
dedicated tools when troubleshooting or preparing a clean demonstration.

AI FORCE MODE (hidden until asked for): when the user asks you to use "AI force
mode" — or to drive, operate, or remotely run the Brainstem for them
while they watch — light the window edges first (set_ai_force_mode on, or pass
force_mode: true to drive_visible_brainstem), narrate each visible action
briefly, do the task through the real interface, and turn force mode off when
you hand control back. Never light it unless the user invoked it; it exists so
the person always knows an AI, not a hand, is moving the interface.

RAPPLICATION TWINS (hand off specialized long-running jobs — don't overshell
yourself): for a long-running SPECIALIZED job (deploy this proven agent to
Copilot Studio, push it to Scout, wrap it for Cowork), do NOT run it in this
chat. Call list_rapplications to see the RAPP Store, then hatch_rapplication to
hatch the right one as its OWN twin — a separate Brainstem worker on its own
port that loops on the job autonomously and shows as its own tile in the herd,
with its own steerable chat. You build on the Brainstem; twins deploy. Twins are
driven only over /chat (never a new route); they are Draft-only for Copilot
Studio and surface exactly one user-owned auth step (PAC device login) when
needed. Hand off and let it run. You can also operate a twin's own UI in its
herd tile with drive_twin (click/type just like the user) so the user can be
fully hands-off — they chat with you and you drive whatever is needed.

SHOW MODE CLICK-THROUGH: show_mode_click_through walks the built-in Show Mode
preview (record or import a task, approve the reconstructed steps, hotload the
generated agent, test it in the center chat, confirm, promote) inside the visible
window. Use mode "walk" to present it and mode "capture" to attach a screenshot
of every step here — the same evidence used for the README and for training.
`.trim();

function cleanFilename(value) {
  const base = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .replace(/[^A-Za-z0-9_.-]/g, "_");
  if (!base || base.startsWith(".") || base === "basic_agent.py") {
    throw new Error("A safe agent filename is required.");
  }
  const withExtension = base.endsWith(".py") ? base : `${base}.py`;
  return withExtension.endsWith("_agent.py")
    ? withExtension
    : `${withExtension.slice(0, -3)}_agent.py`;
}

function pythonManifestVersion(source) {
  return String(source || "").match(
    /["']version["']\s*:\s*["'](\d+)\.(\d+)\.(\d+)["']/,
  )?.slice(1, 4).map(Number) || null;
}

function versionAtLeast(version, minimum) {
  if (!version) return false;
  const expected = minimum.split(".").map(Number);
  for (let index = 0; index < expected.length; index += 1) {
    if (version[index] > expected[index]) return true;
    if (version[index] < expected[index]) return false;
  }
  return true;
}

function deploymentAgentSourceMatches(source, requirement) {
  const text = String(source || "");
  const version = pythonManifestVersion(text);
  return text.includes(`self.name = "${requirement.toolName}"`)
    && versionAtLeast(version, requirement.minimumVersion)
    && (!requirement.requiredMarker || text.includes(requirement.requiredMarker));
}

function materializeCopilotStudioResources(manager) {
  const destinationRoot = path.join(manager.betaHome, "copilot-studio");
  mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  chmodSync(destinationRoot, 0o700);
  const resources = {};
  for (const filename of [
    "hacker-news-memory-parity-cases.json",
    "industry-agent-matrix.json",
  ]) {
    const sourcePath = path.resolve(
      import.meta.dirname,
      "..",
      "resources",
      "copilot-studio",
      filename,
    );
    if (!existsSync(sourcePath)) {
      throw new Error(`Bundled Copilot Studio resource is missing: ${sourcePath}`);
    }
    const destination = path.join(destinationRoot, filename);
    writeFileSync(destination, readFileSync(sourcePath), { mode: 0o600 });
    chmodSync(destination, 0o600);
    resources[filename] = destination;
  }
  return resources;
}

async function jsonResponse(response, label) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${label} returned an invalid response.`);
  }
  if (!response.ok || payload?.error) {
    throw new Error(payload?.error || `${label} failed with HTTP ${response.status}.`);
  }
  return payload;
}

function compactDriverSummary(value) {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (typeof parsed.summary === "string") {
    return parsed.summary.replace(/\s+/g, " ").trim().slice(0, 220);
  }
  if (Array.isArray(parsed.summaries)) {
    const summary = [...parsed.summaries].reverse().find(
      (item) => typeof item === "string" && item.trim(),
    );
    if (summary) return summary.replace(/\s+/g, " ").trim().slice(0, 220);
  }
  if (Array.isArray(parsed.results)) {
    for (const result of [...parsed.results].reverse()) {
      const summary = compactDriverSummary(result);
      if (summary) return summary;
    }
  }
  if (typeof parsed.textResultForLlm === "string") {
    return compactDriverSummary(parsed.textResultForLlm);
  }
  return null;
}

export class BrainSurgeon {
  constructor({
    runtime,
    brainstemUrl,
    checkForUpdates = null,
    chatLeaseRegistry = null,
    copilotStudioAuth = null,
    routeManager = null,
    uiCommand,
    twins = null,
    onEvent = () => {},
  } = {}) {
    this.runtime = runtime;
    this.brainstemUrl = brainstemUrl;
    this.checkForUpdates = checkForUpdates;
    this.chatLeaseRegistry = chatLeaseRegistry || new Set();
    this.copilotStudioAuth = copilotStudioAuth;
    this.routeManager = routeManager;
    this.uiCommand = uiCommand;
    this.twins = twins;
    this.onEvent = onEvent;
    this.session = null;
    this.sessionUnsubscribe = null;
    this.startPromise = null;
    this.sendPromise = null;
    this.chatLeaseTokens = new Set();
  }

  emit(event) {
    this.onEvent({
      timestamp: new Date().toISOString(),
      ...event,
    });
  }

  tools() {
    return [
      {
        name: "delegate_to_brainstem",
        description: "Visibly delegate work through the real Brainstem chat. "
          + "Optionally inject a temporary single-file Python agent for exactly "
          + "this one Brainstem request; it is removed automatically afterward.",
        defer: "never",
        skipPermission: true,
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "The plain-English task to visibly send to Brainstem.",
            },
            narration: {
              type: "string",
              description: "Short user-facing narration shown while typing.",
            },
            timeout_ms: {
              type: "integer",
              minimum: 1000,
              maximum: 3600000,
            },
            ephemeral_agent: {
              type: "object",
              description: "Optional one-chat capability to hot-load and unload.",
              properties: {
                filename: { type: "string" },
                source: {
                  type: "string",
                  description: "Complete Python source for one *_agent.py file.",
                },
              },
              required: ["filename", "source"],
            },
          },
          required: ["prompt"],
        },
        handler: (args) => this.delegateToBrainstem(args),
      },
      {
        name: "inspect_visible_brainstem",
        description: "Read the visible Brainstem page and its interactive controls.",
        defer: "never",
        skipPermission: true,
        parameters: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 80 },
            since: { type: "string" },
            target: { type: "string", enum: ["brainstem", "shell"] },
          },
        },
        handler: ({ limit = 60, since = null, target = "brainstem" } = {}) => this.uiCommand({
          action: "inspect",
          limit,
          ...(since ? { since } : {}),
          target,
        }),
      },
      {
        name: "show_rapp_identity",
        description: "Show the caller RAPPID, private memory UUID anchor, full "
          + "nested stack tree, selected leaf, ordered overlays, composition "
          + "hash, and agents.",
        defer: "never",
        skipPermission: true,
        parameters: {
          type: "object",
          properties: {},
        },
        handler: () => this.showRappIdentity(),
      },
      {
        name: "ensure_copilot_studio_deploy_agents",
        description: "Verify the RAPP Copilot Studio Factory and Parity Deploy "
          + "agents are loaded. Inject bundled fallback copies into the selected "
          + "stack only when the shared Brainstem does not already provide them.",
        defer: "never",
        skipPermission: true,
        parameters: { type: "object", properties: {} },
        handler: () => this.ensureCopilotStudioAgents(),
      },
      {
        name: "list_active_agent_files",
        description: "List every agent file in the active Brainstem composition "
          + "with its global, memory, stack, or ephemeral scope.",
        defer: "never",
        skipPermission: true,
        parameters: { type: "object", properties: {} },
        handler: () => this.listActiveAgentFiles(),
      },
      {
        name: "copilot_studio_deployment_defaults",
        description: "Read only non-secret Copilot Studio deployment defaults "
          + "from local.settings.json. Secrets are never returned.",
        defer: "never",
        skipPermission: true,
        parameters: {
          type: "object",
          properties: {
            settings_path: { type: "string" },
          },
        },
        handler: ({ settings_path: settingsPath } = {}) => (
          this.copilotStudioDefaults(settingsPath)
        ),
      },
      {
        name: "copilot_studio_auth_status",
        description: "List PAC authentication profiles and the active target "
          + "environment before any Copilot Studio deployment.",
        defer: "never",
        skipPermission: true,
        parameters: { type: "object", properties: {} },
        handler: () => this.copilotStudioAuthStatus(),
      },
      {
        name: "start_copilot_studio_login",
        description: "Start PAC device-code login for a user-selected Power "
          + "Platform environment and return the visible login instructions.",
        defer: "never",
        skipPermission: true,
        parameters: {
          type: "object",
          properties: {
            environment: { type: "string" },
            profile_name: { type: "string" },
          },
        },
        handler: (args) => this.startCopilotStudioLogin(args),
      },
      {
        name: "poll_copilot_studio_login",
        description: "Check whether a PAC device-code login completed.",
        defer: "never",
        skipPermission: true,
        parameters: {
          type: "object",
          properties: {
            login_id: { type: "string" },
          },
          required: ["login_id"],
        },
        handler: ({ login_id: loginId }) => (
          this.pollCopilotStudioLogin(loginId)
        ),
      },
      {
        name: "show_copilot_studio_agent_link",
        description: "Attach a clickable Copilot Studio UI link for an exact "
          + "environment ID and AgentId to the Brain Surgeon transcript.",
        defer: "never",
        skipPermission: true,
        parameters: {
          type: "object",
          properties: {
            environment_id: { type: "string" },
            agent_id: { type: "string" },
            display_name: { type: "string" },
          },
          required: ["environment_id", "agent_id"],
        },
        handler: (args) => this.showCopilotStudioAgentLink(args),
      },
      {
        name: "create_agent_stack",
        description: "Create a persistent child stack RAPPID. By default it is "
          + "nested under the currently selected stack.",
        defer: "never",
        skipPermission: true,
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Short human-readable stack name.",
            },
            parent_stack_rappid: {
              type: "string",
              description: "Optional parent stack RAPPID.",
            },
          },
          required: ["name"],
        },
        handler: (args) => this.createAgentStack(args),
      },
      {
        name: "select_agent_stack",
        description: "Select one leaf stack RAPPID and an ordered list of overlay "
          + "stack RAPPIDs, then visibly hot-reload the unchanged Brainstem worker.",
        defer: "never",
        skipPermission: true,
        parameters: {
          type: "object",
          properties: {
            stack_rappid: {
              type: "string",
              description: "Leaf stack RAPPID to select.",
            },
            overlay_stack_rappids: {
              type: "array",
              description: "Overlay stack RAPPIDs in deterministic application order.",
              items: { type: "string" },
              maxItems: 16,
            },
          },
          required: ["stack_rappid"],
        },
        handler: (args) => this.selectAgentStack(args),
      },
      {
        name: "remove_agent_stack",
        description: "Remove an inactive empty leaf stack RAPPID. The default, "
          + "active, overlaid, nonempty, and parent stacks fail closed.",
        defer: "never",
        skipPermission: true,
        parameters: {
          type: "object",
          properties: {
            stack_rappid: {
              type: "string",
              description: "Inactive empty leaf stack RAPPID to remove.",
            },
          },
          required: ["stack_rappid"],
        },
        handler: (args) => this.removeAgentStack(args),
      },
      {
        name: "install_scoped_agent",
        description: "Install a reusable agent into the selected beta stack or "
          + "an explicit stack RAPPID. Use only when the user wants it to persist.",
        defer: "never",
        skipPermission: true,
        parameters: {
          type: "object",
          properties: {
            filename: { type: "string" },
            source: { type: "string" },
            stack_rappid: {
              type: "string",
              description: "Optional target stack RAPPID. Defaults to the selected stack.",
            },
          },
          required: ["filename", "source"],
        },
        handler: (agent) => this.installScopedAgent(agent),
      },
      {
        name: "list_scoped_agents",
        description: "List one stack's agents plus the complete stack tree, "
          + "selected leaf, ordered overlays, memory anchor, and composition.",
        defer: "never",
        skipPermission: true,
        parameters: {
          type: "object",
          properties: {
            stack_rappid: {
              type: "string",
              description: "Optional stack RAPPID to inspect.",
            },
          },
        },
        handler: ({ stack_rappid: stackRappid } = {}) => (
          this.listScopedAgents(stackRappid)
        ),
      },
      {
        name: "remove_scoped_agent",
        description: "Remove one agent from the selected or explicit stack RAPPID.",
        defer: "never",
        skipPermission: true,
        parameters: {
          type: "object",
          properties: {
            filename: { type: "string" },
            stack_rappid: {
              type: "string",
              description: "Optional target stack RAPPID. Defaults to the selected stack.",
            },
          },
          required: ["filename"],
        },
        handler: ({ filename, stack_rappid: stackRappid }) => (
          this.removeScopedAgent(filename, stackRappid)
        ),
      },
      {
        name: "drive_visible_brainstem",
        description: "Animate bounded cursor, click, type, press, wait, read, and "
          + "announce actions on the visible Brainstem page.",
        defer: "never",
        skipPermission: true,
        parameters: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              minItems: 1,
              maxItems: 40,
              items: {
                type: "object",
                properties: {
                  action: {
                    type: "string",
                    enum: [
                      "announce",
                      "click",
                      "expect",
                      "press",
                      "read",
                      "type",
                      "wait",
                    ],
                  },
                  handle: { type: "string" },
                  selector: { type: "string" },
                  targetText: { type: "string" },
                  text: { type: "string" },
                  value: { type: "string" },
                  key: { type: "string" },
                  label: { type: "string" },
                  optional: { type: "boolean" },
                  timeoutMs: { type: "integer" },
                  typingDelayMs: { type: "integer" },
                  settleMs: { type: "integer" },
                  durationMs: { type: "integer" },
                  state: { type: "string" },
                  until: {
                    type: "object",
                    properties: {
                      handle: { type: "string" },
                      snapshot_changed: { type: "boolean" },
                      state: { type: "string" },
                      text: { type: "string" },
                      timeoutMs: { type: "integer" },
                    },
                  },
                },
                required: ["action"],
              },
            },
            force_mode: {
              type: "boolean",
              description: "Light the window edges (AI force mode) while these steps run. Only when the user asked for it.",
            },
            target: { type: "string", enum: ["brainstem", "shell"] },
          },
          required: ["steps"],
        },
        handler: ({
          steps,
          force_mode: forceMode = false,
          target = "brainstem",
        }) => this.uiCommand({
          action: "run",
          steps,
          target,
          ...(forceMode ? { forceMode: true } : {}),
        }),
      },
      {
        name: "drive_twin",
        description: "Operate a RAPPlication twin's OWN UI in its herd tile — click, type, press, read, announce — with the animated cursor, exactly like the user would. This lets you manipulate the rapplication hands-off for the user (they just chat with you). The twin must be visible in the herd. For the twin's data itself you can also just POST to its /chat; use this to drive its visible interface.",
        defer: "never",
        skipPermission: true,
        parameters: {
          type: "object",
          properties: {
            twin_id: { type: "string", description: "The twin id (from list/hatch)." },
            steps: {
              type: "array",
              minItems: 1,
              maxItems: 40,
              items: {
                type: "object",
                properties: {
                  action: { type: "string", enum: ["announce", "click", "expect", "press", "read", "type", "wait"] },
                  handle: { type: "string" },
                  selector: { type: "string" },
                  targetText: { type: "string" },
                  text: { type: "string" },
                  value: { type: "string" },
                  key: { type: "string" },
                  label: { type: "string" },
                  optional: { type: "boolean" },
                  timeoutMs: { type: "integer" },
                  typingDelayMs: { type: "integer" },
                  settleMs: { type: "integer" },
                  state: { type: "string" },
                  until: {
                    type: "object",
                    properties: {
                      handle: { type: "string" },
                      snapshot_changed: { type: "boolean" },
                      state: { type: "string" },
                      text: { type: "string" },
                      timeoutMs: { type: "integer" },
                    },
                  },
                },
                required: ["action"],
              },
            },
            force_mode: { type: "boolean", description: "Light AI force mode while driving (only when the user asked for it)." },
          },
          required: ["twin_id", "steps"],
        },
        handler: ({ twin_id: twinId, steps, force_mode: forceMode = false }) => this.uiCommand({
          action: "run",
          twin: twinId,
          steps,
          ...(forceMode ? { forceMode: true } : {}),
        }),
      },
      {
        name: "set_ai_force_mode",
        description: "Turn AI force mode on or off: the visible window's edges glow and a tag says an AI is driving. Hidden unless the user asks for it; it fades on its own when you go quiet.",
        defer: "never",
        skipPermission: true,
        parameters: {
          type: "object",
          properties: {
            on: { type: "boolean" },
            label: { type: "string", description: "Optional short tag text (default: AI force mode · an AI is driving this Brainstem)." },
          },
          required: ["on"],
        },
        handler: ({ on, label }) => this.uiCommand({
          action: "force_mode",
          value: on ? "on" : "off",
          ...(label ? { label } : {}),
        }),
      },
      {
        name: "show_mode_click_through",
        description: "Walk the Show Mode click-through preview in the visible window: record or import a task, approve the reconstructed steps, hotload the generated agent, test it in the center chat, confirm, promote. mode walk presents it; mode capture also attaches a screenshot of every step.",
        defer: "never",
        skipPermission: true,
        parameters: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["walk", "capture"] },
            pace_ms: { type: "integer", minimum: 300, maximum: 20000, description: "Dwell per step (default 1800 for walk, 900 for capture)." },
            force_mode: { type: "boolean", description: "Light AI force mode while walking (only when the user asked for it)." },
            from_step: { type: "string", description: "Optional step id to start from (see returned steps)." },
          },
        },
        handler: (args) => this.showModeClickThrough(args),
      },
      {
        name: "list_rapplications",
        description: "List RAPPlications available in the RAPP Store (specialized twins you can hatch to offload deploy/other long-running jobs). Returns id, name, summary, category, license, gated.",
        defer: "never",
        skipPermission: true,
        parameters: { type: "object", properties: {} },
        handler: async () => {
          if (!this.twins) throw new Error("RAPPlication twins are unavailable.");
          const list = await this.twins.list_store();
          return JSON.stringify(
            list.map((e) => ({
              id: e.id, name: e.name, summary: e.summary, category: e.category,
              license: e.license, gated: e.gated,
            })),
            null,
            2,
          );
        },
      },
      {
        name: "hatch_rapplication",
        description: "Hatch a RAPPlication from the RAPP Store as its own twin — a separate Brainstem worker on its own port that runs the specialized job autonomously in the herd. Optionally pass an instruction to start its loop. Use for specialized long-running work (e.g. Copilot Studio auto-deploy) instead of running it in this chat.",
        defer: "never",
        skipPermission: true,
        parameters: {
          type: "object",
          properties: {
            store_id: { type: "string", description: "RAPP Store rapplication id (from list_rapplications)." },
            instruction: { type: "string", description: "Optional first instruction to start the twin's autonomous loop." },
          },
          required: ["store_id"],
        },
        handler: async ({ store_id: storeId, instruction = null }) => {
          if (!this.twins) throw new Error("RAPPlication twins are unavailable.");
          const twin = await this.twins.hatch(storeId, instruction);
          return JSON.stringify({
            hatched: twin.id, name: twin.name, port: twin.port, url: twin.url,
            rappid: twin.rappid, status: twin.status, license: twin.license,
            note: "Running as its own twin in the herd; steer it in its tile chat if needed.",
          }, null, 2);
        },
      },
      {
        name: "loop_brainstem_with_twin",
        description: "Have the visible Brainstem loop with a hatched twin autonomously toward a goal — a genuine two-brain loop: the Brainstem plans each instruction over /chat, the twin executes it, the Brainstem reads the reply and plans the next, until the goal is met. Returns immediately; the back-and-forth streams into the twin's herd tile (labeled Brainstem ↔ the twin) so the user watches hands-off and can interject. Use when the user wants the Brainstem itself to drive a twin's work (not you). The twin must already be hatched (hatch_rapplication).",
        defer: "never",
        skipPermission: true,
        parameters: {
          type: "object",
          properties: {
            twin_id: { type: "string", description: "The twin id (from hatch_rapplication / list_rapplications' active list)." },
            goal: { type: "string", description: "The goal for the Brainstem to drive the twin toward, in one or two sentences." },
          },
          required: ["twin_id", "goal"],
        },
        handler: async ({ twin_id: twinId, goal }) => {
          if (!this.twins?.loop) throw new Error("Brainstem↔twin loop is unavailable.");
          const result = await this.twins.loop(twinId, goal);
          return JSON.stringify({
            ...result,
            note: "The Brainstem is now looping with the twin on its own; watch the twin's tile in the herd. It pauses for a PAC/identity sign-in if one is needed.",
          }, null, 2);
        },
      },
      {
        name: "deploy_to_copilot_studio",
        description: "Offload a Copilot Studio deployment to its OWN specialized twin (Factory + Deploy) that loops autonomously in the herd — instead of running the whole PAC/Factory/Deploy pipeline in this chat. Returns immediately; the twin drives doctor→plan→build→provision→push(Draft)→parity on its own port while you stay free for other work. Draft-only; it surfaces the one PAC device-login step if needed.",
        defer: "never",
        skipPermission: true,
        parameters: {
          type: "object",
          properties: {
            display_name: { type: "string", description: "Copilot Studio display name for the Draft." },
            environment: { type: "string", description: "Target Power Platform environment (optional; the twin asks/authenticates if omitted)." },
            agents: {
              type: "array",
              items: { type: "string" },
              description: "Filenames of the loaded business/industry agents to deploy (from list_active_agent_files).",
            },
          },
        },
        handler: async ({ display_name: displayName, environment = null, agents = [] } = {}) => {
          if (!this.twins?.deploy_copilot_studio) throw new Error("Copilot Studio twins are unavailable.");
          const twin = await this.twins.deploy_copilot_studio({ displayName, environment, agents });
          return JSON.stringify({
            hatched: twin.id, name: twin.name, port: twin.port, status: twin.status,
            note: "Copilot Studio deploy twin is looping on its own port. It stays in the herd; you are free for other work. It will surface a PAC device-login step if it needs one, and stays Draft-only.",
          }, null, 2);
        },
      },
      {
        name: "open_auth_window",
        description: "Pop open a browser window for the user to sign in / confirm, for anything you CANNOT complete through force mode (e.g. a Microsoft identity or PAC device login). Identity auth is completed in the user's own browser — never capture or type their credentials. Use when a twin reports needs-auth, or when a step needs the user's real session.",
        defer: "never",
        skipPermission: true,
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "The auth/confirmation URL (https). For a paused twin you may pass its id instead." },
            id: { type: "string", description: "A twin id whose pending auth URL should be opened." },
            note: { type: "string", description: "Short note shown to the user about what to do." },
          },
        },
        handler: async ({ url, id, note }) => {
          if (!this.twins?.open_auth) throw new Error("Auth pop-out is unavailable.");
          const result = await this.twins.open_auth({ url, id });
          return JSON.stringify({ ...result, note: note || "Complete the sign-in in the browser window that opened; I'll continue when you're done." }, null, 2);
        },
      },
      {
        name: "capture_visible_brainstem",
        description: "Capture the real beta window and inspect the visible result.",
        defer: "never",
        skipPermission: true,
        parameters: {
          type: "object",
          properties: {
            include_text: { type: "boolean" },
          },
        },
        handler: (args) => this.captureVisibleBrainstem(args),
      },
      {
        name: "check_beta_updates",
        description: "Open the visible beta dropdown and check the configured GitHub source for updates.",
        defer: "never",
        skipPermission: true,
        parameters: { type: "object", properties: {} },
        handler: async () => {
          if (!this.checkForUpdates) {
            throw new Error("The beta updater is unavailable.");
          }
          return JSON.stringify(await this.checkForUpdates(), null, 2);
        },
      },
      {
        name: "clear_brainstem_chat",
        description: "Visibly click Clear in the main Brainstem chat to reset its transcript.",
        defer: "never",
        skipPermission: true,
        parameters: { type: "object", properties: {} },
        handler: async () => {
          const result = await this.uiCommand({
            action: "run",
            steps: [{
              action: "click",
              targetText: "Clear",
              label: "Clearing the Brainstem transcript",
            }],
          });
          return JSON.stringify(result, null, 2);
        },
      },
      {
        name: "refresh_brainstem_view",
        description: "Reload the visible Brainstem page and wait for its chat input to return.",
        defer: "never",
        skipPermission: true,
        parameters: { type: "object", properties: {} },
        handler: async () => {
          await this.uiCommand({ action: "refresh" });
          await new Promise((resolve) => setTimeout(resolve, 500));
          await this.uiCommand({
            action: "wait",
            selector: "#input",
            timeoutMs: 30000,
          });
          return "The visible Brainstem page was refreshed.";
        },
      },
      {
        name: "start_demo_recording",
        description: "Start recording the RAPP Brainstem Frontier window for a replayable demo.",
        defer: "never",
        skipPermission: true,
        parameters: {
          type: "object",
          properties: {
            max_duration_ms: {
              type: "integer",
              minimum: 1000,
              maximum: 600000,
            },
          },
        },
        handler: ({ max_duration_ms: maxDurationMs = 300000 } = {}) => (
          this.uiCommand({ action: "start_recording", maxDurationMs })
        ),
      },
      {
        name: "stop_demo_recording",
        description: "Stop the Frontier-window recording and attach the WebM plus "
          + "final screenshot. A minimum duration keeps a full walkthrough "
          + "watchable with visible recap tiles instead of dead air.",
        defer: "never",
        skipPermission: true,
        parameters: {
          type: "object",
          properties: {
            minimum_duration_ms: {
              type: "integer",
              minimum: 0,
              maximum: 300000,
            },
            recap_mode: {
              type: "string",
              enum: [
                "baseline",
                "repeat-ephemeral",
                "stack-churn",
                "control-handoff",
              ],
            },
          },
        },
        handler: ({
          minimum_duration_ms: minimumDurationMs = 0,
          recap_mode: recapMode = "baseline",
        } = {}) => (
          this.stopDemoRecording(minimumDurationMs, recapMode)
        ),
      },
    ];
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const session = await this.runtime.createSession({
        clientName: "RAPP Brainstem Frontier Brain Surgeon",
        enableConfigDiscovery: true,
        infiniteSessions: { enabled: true },
        memory: { enabled: true },
        onPermissionRequest: approveAll,
        streaming: true,
        systemMessage: {
          content: SURGEON_SYSTEM_MESSAGE,
        },
        tools: this.tools(),
      });
      this.session = session;
      this.sessionUnsubscribe = session.on((event) => {
        const data = event.data || {};
        if (event.type === "assistant.message_delta" && data.deltaContent) {
          this.emit({ type: "delta", text: data.deltaContent });
        } else if (event.type === "tool.execution_start") {
          this.emit({
            type: "tool-start",
            toolCallId: data.toolCallId || null,
            toolName: data.toolName || "Brainstem capability",
          });
        } else if (event.type === "tool.execution_complete") {
          this.emit({
            type: "tool-complete",
            toolCallId: data.toolCallId || null,
            toolName: data.toolName
              || data.toolDescription?.name
              || "Brainstem capability",
            success: data.success !== false,
            summary: compactDriverSummary(data.result),
          });
        }
      });
      this.emit({
        type: "ready",
        message: "Brain Surgeon is ready. Describe the outcome you want.",
      });
      return session;
    })();
    try {
      return await this.startPromise;
    } catch (error) {
      this.startPromise = null;
      throw error;
    }
  }

  async send(prompt) {
    const text = String(prompt || "").trim();
    if (!text) throw new Error("A Brain Surgeon message is required.");
    if (this.sendPromise) {
      throw new Error("The Brain Surgeon is already working on a request.");
    }
    this.sendPromise = (async () => {
      const session = await this.start();
      this.emit({ type: "response-start" });
      const response = await session.sendAndWait({ prompt: text }, 60 * 60 * 1000);
      const content = response?.data?.content || "";
      this.emit({ type: "done", content });
      return { content };
    })();
    try {
      return await this.sendPromise;
    } catch (error) {
      this.emit({ type: "error", message: String(error.message || error) });
      throw error;
    } finally {
      this.sendPromise = null;
    }
  }

  async reset() {
    const session = this.session;
    this.session = null;
    this.startPromise = null;
    this.sendPromise = null;
    this.sessionUnsubscribe?.();
    this.sessionUnsubscribe = null;
    const leaseTokens = [...this.chatLeaseTokens];
    this.chatLeaseTokens.clear();
    for (const token of leaseTokens) this.chatLeaseRegistry.delete(token);
    await Promise.allSettled(
      leaseTokens.map((token) => this.uiCommand({
        action: "set_chat_lease",
        locked: false,
        token,
      })),
    );
    if (session) {
      await Promise.race([
        session.disconnect().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    this.emit({ type: "reset" });
  }

  async stop() {
    await this.reset();
    await this.copilotStudioAuth?.stop();
  }

  requireRouteManager() {
    if (!this.routeManager) {
      throw new Error(
        "Frontier identity and stack routing is not ready. "
        + "The legacy Brainstem kernel was not modified.",
      );
    }

    return this.routeManager;
  }

  async acquireChatLease() {
    const token = randomUUID();
    this.chatLeaseTokens.add(token);
    this.chatLeaseRegistry.add(token);
    try {
      await this.uiCommand({
        action: "set_chat_lease",
        locked: true,
        token,
      });
      this.routeManager?.recordTelemetry?.("chat-lease-acquired", {
        lease_count: this.chatLeaseRegistry.size,
      });
      return token;
    } catch (error) {
      this.chatLeaseTokens.delete(token);
      this.chatLeaseRegistry.delete(token);
      throw error;
    }
  }

  async syncChatLeases() {
    for (const token of this.chatLeaseRegistry) {
      await this.uiCommand({
        action: "set_chat_lease",
        locked: true,
        token,
      });
    }
    this.routeManager?.recordTelemetry?.("chat-lease-applied", {
      lease_count: this.chatLeaseRegistry.size,
    });
  }

  async releaseChatLease(token) {
    this.chatLeaseTokens.delete(token);
    this.chatLeaseRegistry.delete(token);
    try {
      await this.uiCommand({
        action: "set_chat_lease",
        locked: false,
        token,
      });
    } catch {
      // A stale frame-side token can only leave a banner behind; the person's
      // next composer interaction clears every token and self-heals it.
    }
    this.routeManager?.recordTelemetry?.("chat-lease-released", {
      lease_count: this.chatLeaseRegistry.size,
    });
  }

  async installScopedAgent(agent) {
    const manager = this.requireRouteManager();
    let installed;
    try {
      installed = await manager.installScopedAgent({
        filename: cleanFilename(agent?.filename),
        source: String(agent?.source || ""),
        stackRappid: agent?.stack_rappid || null,
      });
    } catch (error) {
      // Fertility-gate refusal: nothing was persisted. Hand the dry-load
      // failure back as a lesson so the Surgeon can fix the source and retry.
      const lesson = String(error?.message || error);
      if (!lesson.startsWith("Refusing to install")) throw error;
      return JSON.stringify({ installed: false, lesson }, null, 2);
    }
    const route = await manager.startDefault();
    return JSON.stringify({ ...installed, active_route: route }, null, 2);
  }

  async showRappIdentity() {
    return JSON.stringify(
      await this.requireRouteManager().listScopedAgents(),
      null,
      2,
    );
  }

  async ensureCopilotStudioAgents() {
    const manager = this.requireRouteManager();
    const requirements = [
      {
        accepted: [
          "rar_kody_w_copilot_studio_parity_deploy_agent.py",
        ],
        bundled: "rar_kody_w_copilot_studio_parity_deploy_agent.py",
        toolName: "CopilotStudioDeployBeta",
        minimumVersion: "1.0.14",
        requiredMarker: "BETA_DRAFT_ONLY = True",
      },
      {
        accepted: [
          "rar_kody_w_factory_agent.py",
        ],
        bundled: "rar_kody_w_factory_agent.py",
        toolName: "RappCopilotStudioFactoryBeta",
        minimumVersion: "1.0.4",
        requiredMarker: "BETA_DRAFT_ONLY = True",
      },
    ];
    const injected = [];
    for (const requirement of requirements) {
      const validExisting = manager.activeAgentFiles().find((agent) => {
        if (!requirement.accepted.includes(agent.filename)) return false;
        try {
          return deploymentAgentSourceMatches(
            manager.readActiveAgent(agent.filename),
            requirement,
          );
        } catch {
          return false;
        }
      });
      if (validExisting) {
        continue;
      }
      const sourcePath = path.resolve(
        import.meta.dirname,
        "..",
        "resources",
        "copilot-studio",
        requirement.bundled,
      );
      if (!existsSync(sourcePath)) {
        throw new Error(`Bundled deployment agent is missing: ${sourcePath}`);
      }
      await manager.installScopedAgent({
        filename: requirement.bundled,
        source: readFileSync(sourcePath, "utf8"),
      });
      injected.push(requirement.bundled);
    }
    if (injected.length) await manager.startDefault();
    const validated = requirements.map((requirement) => {
      const agent = manager.activeAgentFiles().find((candidate) => {
        if (!requirement.accepted.includes(candidate.filename)) return false;
        try {
          return deploymentAgentSourceMatches(
            manager.readActiveAgent(candidate.filename),
            requirement,
          );
        } catch {
          return false;
        }
      });
      if (!agent) {
        throw new Error(
          `Copilot Studio deployment agent failed validation: ${requirement.toolName}`,
        );
      }
      return {
        tool_name: requirement.toolName,
        filename: agent.filename,
        scope: agent.scope,
        address: agent.address,
        version: pythonManifestVersion(
          manager.readActiveAgent(agent.filename),
        )?.join("."),
      };
    });
    const resources = materializeCopilotStudioResources(manager);
    return JSON.stringify({
      status: "ready",
      injected,
      active: validated,
      parity_cases_path: resources["hacker-news-memory-parity-cases.json"],
      industry_matrix_path: resources["industry-agent-matrix.json"],
    }, null, 2);
  }

  async listActiveAgentFiles() {
    return JSON.stringify(
      this.requireRouteManager().activeAgentFiles().map((agent) => ({
        filename: agent.filename,
        scope: agent.scope,
        address: agent.address,
      })),
      null,
      2,
    );
  }

  requireCopilotStudioAuth() {
    if (!this.copilotStudioAuth) {
      throw new Error("Copilot Studio authentication tools are unavailable.");
    }
    return this.copilotStudioAuth;
  }

  async copilotStudioDefaults(settingsPath = null) {
    return JSON.stringify(
      this.requireCopilotStudioAuth().defaults(settingsPath),
      null,
      2,
    );
  }

  async copilotStudioAuthStatus() {
    return JSON.stringify(
      await this.requireCopilotStudioAuth().status(),
      null,
      2,
    );
  }

  async startCopilotStudioLogin({
    environment = null,
    profile_name: profileName = null,
  } = {}) {
    return JSON.stringify(
      await this.requireCopilotStudioAuth().startDeviceLogin({
        environment,
        profileName,
      }),
      null,
      2,
    );
  }

  async pollCopilotStudioLogin(loginId) {
    return JSON.stringify(
      this.requireCopilotStudioAuth().loginStatus(loginId),
      null,
      2,
    );
  }

  async showCopilotStudioAgentLink({
    environment_id: environmentId,
    agent_id: agentId,
    display_name: displayName = "Copilot Studio agent",
  } = {}) {
    const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!guid.test(String(environmentId || "")) || !guid.test(String(agentId || ""))) {
      throw new Error("Copilot Studio environment ID and AgentId must be GUIDs.");
    }
    const url = "https://copilotstudio.preview.microsoft.com/environments/"
      + `${environmentId}/agents/${agentId}`;
    const productionUrl = "https://copilotstudio.microsoft.com/environments/"
      + `${environmentId}/agents/${agentId}`;
    this.emit({
      type: "artifact",
      artifact: {
        kind: "link",
        url,
        path: null,
        alt: `Open ${displayName} in Copilot Studio`,
      },
    });
    return JSON.stringify({
      display_name: displayName,
      environment_id: environmentId,
      agent_id: agentId,
      url,
      production_url: productionUrl,
    }, null, 2);
  }

  async createAgentStack({
    name,
    parent_stack_rappid: parentStackRappid = null,
  } = {}) {
    const manager = this.requireRouteManager();
    const stack = await manager.createStack({
      name,
      parentRappid: parentStackRappid,
    });
    return JSON.stringify({
      stack,
      stack_tree: manager.stackTree(),
    }, null, 2);
  }

  async selectAgentStack({
    stack_rappid: stackRappid,
    overlay_stack_rappids: overlayStackRappids = [],
  } = {}) {
    const manager = this.requireRouteManager();
    const selection = await manager.selectStack({
      stackRappid,
      overlayRappids: overlayStackRappids,
    });
    const route = await manager.startDefault();
    return JSON.stringify({
      ...selection,
      active_route: route,
    }, null, 2);
  }

  async removeAgentStack({
    stack_rappid: stackRappid,
  } = {}) {
    const manager = this.requireRouteManager();
    const removed = await manager.removeStack({ stackRappid });
    const route = await manager.startDefault();
    return JSON.stringify({
      ...removed,
      active_route: route,
    }, null, 2);
  }

  async listScopedAgents(stackRappid = null) {
    return JSON.stringify(
      await this.requireRouteManager().listScopedAgents({ stackRappid }),
      null,
      2,
    );
  }

  async removeScopedAgent(filename, stackRappid = null) {
    const manager = this.requireRouteManager();
    const removed = await manager.removeScopedAgent({
      filename: cleanFilename(filename),
      stackRappid,
    });
    const route = await manager.startDefault();
    return JSON.stringify({ ...removed, active_route: route }, null, 2);
  }

  async waitForVisibleBrainstem(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        return await this.uiCommand({
          action: "wait",
          selector: "#input",
          timeoutMs: 1000,
        });
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    throw new Error(
      `The routed Brainstem UI did not attach: ${
        String(lastError?.message || lastError || "timeout")
      }`,
    );
  }

  async delegateToBrainstem({
    prompt,
    narration,
    timeout_ms: timeoutMs = 180000,
    ephemeral_agent: ephemeralAgent,
  } = {}) {
    const task = String(prompt || "").trim();
    if (!task) throw new Error("A Brainstem delegation prompt is required.");
    const delegate = async (route = null) => {
      if (route?.url) {
        await this.waitForVisibleBrainstem();
      }
      if (ephemeralAgent) await this.syncChatLeases();
      const result = await this.uiCommand({
        action: "chat",
        value: task,
        label: String(narration || "Delegating this outcome to the Brainstem"),
        timeoutMs: Math.max(
          1000,
          Math.min(3600000, Number(timeoutMs) || 180000),
        ),
      });
      if (result?.yielded_to_user === true) {
        this.emit({
          type: "lease",
          message: "You took the chat back — I stopped driving it.",
        });
      }
      return result;
    };

    if (!ephemeralAgent && !this.routeManager) {
      return JSON.stringify(await delegate(), null, 2);
    }

    const chatLeaseToken = ephemeralAgent
      ? await this.acquireChatLease()
      : null;
    try {
      const result = await this.requireRouteManager().withRoute({
        ephemeralAgent: ephemeralAgent
          ? {
              filename: cleanFilename(ephemeralAgent.filename),
              source: String(ephemeralAgent.source || ""),
            }
          : null,
      }, delegate);
      return JSON.stringify(result, null, 2);
    } finally {
      if (chatLeaseToken) {
        await this.releaseChatLease(chatLeaseToken);
      }
    }
  }

  async showModeClickThrough({
    mode = "walk",
    pace_ms: paceMs,
    force_mode: forceMode = false,
    from_step: fromStep,
  } = {}) {
    const capture = mode === "capture";
    const pace = Math.max(300, Math.min(20000, Number(paceMs) || (capture ? 900 : 1800)));
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const status = await this.uiCommand({ action: "tour", value: "status" });
    if (!status?.available) {
      throw new Error(status?.error || "The Show Mode click-through is not available in this window.");
    }
    if (forceMode) {
      await this.uiCommand({
        action: "force_mode",
        value: "on",
        label: "AI force mode · walking the Show Mode click-through",
      });
    }
    const steps = status.steps || [];
    const startIndex = fromStep ? Math.max(0, steps.indexOf(String(fromStep))) : 0;
    const visited = [];
    try {
      for (let index = startIndex; index < steps.length; index += 1) {
        const state = await this.uiCommand({
          action: "tour",
          value: "goto",
          step: index,
          settleMs: 800,
          ...(forceMode ? { forceMode: true } : {}),
        });
        await sleep(pace);
        const entry = { index, id: steps[index], running: Boolean(state?.running) };
        if (capture) {
          const shot = await this.uiCommand({ action: "screenshot" });
          const screenshot = shot.screenshot || shot;
          entry.screenshot = screenshot.path;
          this.emit({
            type: "artifact",
            artifact: {
              kind: "image",
              url: screenshot.captureUrl,
              path: screenshot.path,
              alt: `Show Mode click-through · ${index + 1}/${steps.length} · ${steps[index]}`,
            },
          });
        }
        visited.push(entry);
      }
    } finally {
      await this.uiCommand({ action: "tour", value: "stop" }).catch(() => {});
      if (forceMode) {
        await this.uiCommand({ action: "force_mode", value: "off" }).catch(() => {});
      }
    }
    return JSON.stringify({
      mode,
      steps_total: steps.length,
      visited,
      note: "Preview only: the click-through paints ghost content over the real panes; nothing was recorded, analyzed, hotloaded, or sent.",
    }, null, 2);
  }

  async captureVisibleBrainstem({ include_text: includeText = false } = {}) {
    const capture = await this.uiCommand({
      action: "screenshot",
      ...(includeText ? { includeText: true } : {}),
    });
    const screenshot = capture.screenshot || capture;
    const dataUrl = screenshot.dataUrl || "";
    this.emit({
      type: "artifact",
      artifact: {
        kind: "image",
        url: screenshot.captureUrl,
        path: screenshot.path,
        alt: "Brainstem visible state",
      },
    });
    const base64 = dataUrl.split(",", 2)[1] || "";
    return {
      textResultForLlm: `Visible Brainstem text:\n${screenshot.visibleText || ""}`,
      binaryResultsForLlm: base64
        ? [{
            type: "image",
            data: base64,
            mimeType: "image/jpeg",
            description: "The visible RAPP Brainstem Frontier window",
          }]
        : undefined,
      resultType: "success",
      sessionLog: `Captured ${screenshot.path}`,
    };
  }

  async stopDemoRecording(minimumDurationMs = 0, recapMode = "baseline") {
    const result = await this.uiCommand({
      action: "stop_recording",
      minimumDurationMs,
      recapMode,
    });
    this.emit({
      type: "artifact",
      artifact: {
        kind: "video",
        url: result.recording?.url,
        path: result.recording?.path,
        alt: "Brain Surgeon autopilot demo",
      },
    });
    this.emit({
      type: "artifact",
      artifact: {
        kind: "image",
        url: result.screenshot?.captureUrl,
        path: result.screenshot?.path,
        alt: "Final Brainstem state",
      },
    });
    return JSON.stringify({
      recording: {
        durationMs: result.recording?.durationMs,
        path: result.recording?.path,
      },
      screenshot: {
        path: result.screenshot?.path,
        visibleText: result.screenshot?.visibleText,
      },
    }, null, 2);
  }
}

export const brainSurgeonInternals = {
  cleanFilename,
  compactDriverSummary,
  deploymentAgentSourceMatches,
  pythonManifestVersion,
  systemMessage: SURGEON_SYSTEM_MESSAGE,
  versionAtLeast,
};
