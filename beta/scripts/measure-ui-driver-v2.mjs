import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createUiDriverHelpers } from "../electron/ui-driver-helpers.mjs";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const betaDir = path.resolve(dirname, "..");
const shellPath = path.join(betaDir, "ui", "index.html");
const agentPath = path.join(betaDir, "scripts", "brainstem_ui_driver_agent.py");
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);
const INTERACTIVE_TAGS = new Set(["a", "button", "input", "select", "textarea"]);

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function parseAttributes(source) {
  const attributes = {};
  const body = source.replace(/^<\s*[^\s/>]+/, "").replace(/\/?\s*>$/, "");
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of body.matchAll(pattern)) {
    attributes[match[1].toLowerCase()] = decodeEntities(
      match[2] ?? match[3] ?? match[4] ?? "",
    );
  }
  return attributes;
}

function parseShellMarkup(html) {
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const source = bodyMatch?.[1] || html;
  const root = { attrs: {}, children: [], parent: null, tag: "body", text: [] };
  const stack = [root];
  const tokens = source.match(/<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>|[^<]+/g) || [];
  for (const token of tokens) {
    if (token.startsWith("<!--")) continue;
    if (token.startsWith("</")) {
      const tag = token.match(/^<\/\s*([^\s>]+)/)?.[1]?.toLowerCase();
      while (stack.length > 1) {
        const current = stack.pop();
        if (current.tag === tag) break;
      }
      continue;
    }
    if (token.startsWith("<")) {
      const tag = token.match(/^<\s*([^\s/>]+)/)?.[1]?.toLowerCase();
      if (!tag) continue;
      const parent = stack[stack.length - 1];
      const node = {
        attrs: parseAttributes(token),
        children: [],
        parent,
        tag,
        text: [],
      };
      parent.children.push(node);
      if (!VOID_TAGS.has(tag) && !token.endsWith("/>")) stack.push(node);
      continue;
    }
    const current = stack[stack.length - 1];
    if (!["script", "style", "svg", "template"].includes(current.tag)) {
      current.text.push(decodeEntities(token));
    }
  }
  return root;
}

function walk(node, output = []) {
  for (const child of node.children || []) {
    output.push(child);
    walk(child, output);
  }
  return output;
}

function nodeText(node) {
  if (["script", "style", "svg", "template"].includes(node.tag)) return "";
  return [
    ...(node.text || []),
    ...(node.children || []).map((child) => nodeText(child)),
  ].join(" ");
}

function normalizedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function oldSelectorFor(node) {
  if (node.attrs.id) return `#${node.attrs.id}`;
  const parts = [];
  let current = node;
  while (current && current.tag !== "body" && parts.length < 5) {
    let part = current.tag;
    const siblings = (current.parent?.children || [])
      .filter((candidate) => candidate.tag === current.tag);
    if (siblings.length > 1) {
      part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }
    parts.unshift(part);
    current = current.parent;
  }
  return parts.join(" > ");
}

function isInteractive(node) {
  return INTERACTIVE_TAGS.has(node.tag)
    || ["button", "menuitem"].includes(node.attrs.role)
    || Object.hasOwn(node.attrs, "tabindex");
}

function fixtureName(node) {
  return normalizedText(
    node.attrs["aria-label"]
    || node.attrs.title
    || node.attrs.value
    || nodeText(node),
  );
}

function fixtureRole(node) {
  if (node.attrs.role) return node.attrs.role;
  if (node.tag === "a") return "link";
  if (node.tag === "button") return "button";
  if (["input", "textarea"].includes(node.tag)) return "textbox";
  if (node.tag === "select") return "combobox";
  return "group";
}

export function shellFixture(html = readFileSync(shellPath, "utf8")) {
  const root = parseShellMarkup(html);
  const nodes = walk(root);
  const interactive = nodes.filter(isInteractive);
  const bodyText = normalizedText(nodeText(root));
  const title = decodeEntities(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "OpenRappter");
  return {
    bodyText,
    interactive: interactive.map((node) => ({
      disabled: Object.hasOwn(node.attrs, "disabled"),
      h: node.attrs["data-drive"]
        ? `@${node.attrs["data-drive"]}`
        : oldSelectorFor(node),
      name: fixtureName(node),
      oldSelector: oldSelectorFor(node),
      role: fixtureRole(node),
      state: Object.hasOwn(node.attrs, "disabled") ? "disabled" : (
        ["input", "textarea"].includes(node.tag) ? "empty" : "enabled"
      ),
      tag: node.tag,
    })),
    title: normalizedText(title),
  };
}

export function shellInspectMeasurements(fixture = shellFixture()) {
  const helpers = createUiDriverHelpers();
  const before = {
    title: fixture.title,
    url: pathToFileURL(shellPath).href,
    interactive: fixture.interactive.map((item) => ({
      selector: item.oldSelector,
      tag: item.tag,
      text: item.name.slice(0, 180),
      disabled: item.disabled,
    })),
    text: fixture.bodyText.slice(0, 4000),
  };
  const after = helpers.buildOutline(fixture.interactive, { frame: "shell" });
  return {
    after,
    afterBytes: helpers.byteLength(JSON.stringify(after)),
    before,
    beforeBytes: helpers.byteLength(JSON.stringify(before)),
  };
}

function currentAgentOverhead() {
  const python = [
    "import importlib.util,json,sys,types",
    "basic=types.ModuleType('agents.basic_agent')",
    "agents=types.ModuleType('agents')",
    "class BasicAgent:",
    "  def __init__(self): pass",
    "basic.BasicAgent=BasicAgent",
    "sys.modules['agents']=agents",
    "sys.modules['agents.basic_agent']=basic",
    `spec=importlib.util.spec_from_file_location('driver',${JSON.stringify(agentPath)})`,
    "module=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "agent=module.BrainstemUiDriver()",
    "schema=json.dumps({'type':'function','function':agent.metadata},separators=(',',':'),ensure_ascii=True)",
    "context=agent.system_context()",
    "print(json.dumps({'schema':len(schema.encode()),'context':len(context.encode())}))",
  ].join("\n");
  const result = spawnSync("python3", ["-c", python], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Could not measure the Python driver: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout);
}

export function measureUiDriver() {
  const helpers = createUiDriverHelpers();
  const fixture = shellFixture();
  const inspect = shellInspectMeasurements(fixture);
  const caption = helpers.capText(`${fixture.title} · @shell.enter`, 300);
  const overhead = currentAgentOverhead();
  return {
    inspect: {
      after: inspect.afterBytes,
      before: inspect.beforeBytes,
      target: 2000,
      unit: "bytes",
    },
    overhead: {
      after: overhead.schema + overhead.context,
      before: 3776 + 919,
      detail: overhead,
      target: 1200,
      unit: "bytes",
    },
    read: {
      after: Math.min(fixture.bodyText.length, helpers.caps.readMax),
      before: Math.min(fixture.bodyText.length, 12000),
      target: helpers.caps.readMax,
      unit: "characters",
    },
    screenshot: {
      after: caption.length,
      before: Math.min(fixture.bodyText.length, 12000),
      target: helpers.caps.screenshotTextDefault,
      unit: "characters",
    },
  };
}

function printTable(metrics) {
  console.log("| Metric | Before | After | Target |");
  console.log("|---|---:|---:|---:|");
  for (const [name, values] of Object.entries(metrics)) {
    console.log(
      `| ${name} (${values.unit}) | ${values.before} | ${values.after} | ≤ ${values.target} |`,
    );
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const fixture = shellFixture();
  if (process.argv.includes("--inspect-json")) {
    console.log(JSON.stringify(shellInspectMeasurements(fixture).after));
  } else if (process.argv.includes("--fixture-json")) {
    console.log(JSON.stringify(fixture, null, 2));
  } else if (process.argv.includes("--json")) {
    console.log(JSON.stringify(measureUiDriver(), null, 2));
  } else {
    printTable(measureUiDriver());
  }
}
