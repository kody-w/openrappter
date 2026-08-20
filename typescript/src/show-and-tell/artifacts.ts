import { openrappterPath } from '../infra/openrappter-home.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  assertPrivateDirectory,
  hardenPrivatePath,
  syncParentDirectory,
} from '../flight-recorder/permissions.js';
import {
  artifactContainsSensitiveText,
  hasSecretFindings,
  privacyReducedUrl,
  sanitizeShowAndTellText,
  scanSensitivePayload,
} from './privacy.js';
import {
  marketplaceContentHash,
  renderMarketplaceExport,
  renderMarketplaceSkill,
  renderSkillDescription,
  validateMarketplaceExport,
  writeMarketplaceExport,
  type MarketplaceExport,
  type MarketplaceExportInput,
  type MarketplaceFile,
} from './marketplace.js';
import type { ShowAndTellStore } from './store.js';
import {
  SHOW_AND_TELL_AUTOMATION_SCHEMA,
  type ShowAndTellAnalysis,
  type ShowAndTellArtifact,
  type ShowAndTellArtifactKind,
  type ShowAndTellSkillPlan,
} from './types.js';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '') || 'recorded-workflow';
}

function privateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Artifact destination is not a directory: ${directory}`);
  }
  hardenPrivatePath(directory, true);
  assertPrivateDirectory(directory);
}

function writePrivate(file: string, content: string): void {
  if (existsSync(file)) {
    const linked = lstatSync(file);
    if (linked.isSymbolicLink() || !linked.isFile()) {
      throw new Error(`Artifact destination is not a regular file: ${file}`);
    }
  }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    hardenPrivatePath(temporary);
    if (process.platform === 'win32' && existsSync(file)) unlinkSync(file);
    renameSync(temporary, file);
    hardenPrivatePath(file);
    syncParentDirectory(path.dirname(file));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // The successful rename consumed the temporary file.
    }
  }
}

function toolList(analysis: ShowAndTellAnalysis): string[] {
  return [...new Set(analysis.steps.map((step) => step.tool).filter(Boolean))];
}

/** The atomic, mode-0600 artifact write, exposed for the marketplace export. */
export function writePrivateArtifact(file: string, content: string): void {
  writePrivate(file, content);
}

export function renderShowAndTellSkill(
  analysis: ShowAndTellAnalysis,
  name: string,
): string {
  const tools = toolList(analysis);
  const lines = [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(analysis.intent)}`,
    'metadata:',
    `  source: ${JSON.stringify('openrappter-show-and-tell')}`,
    `  session: ${JSON.stringify(analysis.sessionId)}`,
  ];
  if (tools.length) {
    lines.push('allowed-tools:');
    for (const tool of tools) lines.push(`  - ${JSON.stringify(tool)}`);
  }
  lines.push(
    '---',
    '',
    `# ${analysis.title}`,
    '',
    '## Goal',
    '',
    analysis.intent,
    '',
    '## Procedure',
    '',
  );
  analysis.steps.forEach((step, index) => {
    lines.push(
      `${index + 1}. **${step.title}** — ${step.detail}` +
        `${step.tool ? ` Prefer \`${step.tool}\`.` : ''}` +
        `${privacyReducedUrl(step.url)
          ? ` Destination: ${privacyReducedUrl(step.url)}`
          : ''}`,
    );
  });
  lines.push(
    '',
    '## Execution rules',
    '',
    '- Prefer a native API, CLI, filesystem, or browser tool over replaying screen coordinates.',
    '- Treat UI automation as a fallback and re-locate controls by meaning, not by recorded pixels.',
    '- Ask before destructive, financial, publishing, or message-sending actions.',
    '- Never request, persist, or echo credentials from the demonstration.',
    '',
  );
  return lines.join('\n');
}

function skillManifest(
  analysis: ShowAndTellAnalysis,
  name: string,
  plan?: ShowAndTellSkillPlan | null,
): string {
  return `${JSON.stringify({
    id: `show-and-tell/${name}`,
    name,
    version: '1.0.0',
    description: plan ? renderSkillDescription(plan) : analysis.intent,
    tags: ['show-and-tell', 'recorded-workflow'],
    sourceSessionId: analysis.sessionId,
    sourceAnalysisRevision: analysis.revision,
    ...(plan
      ? {
          sourcePlanRevision: plan.revision,
          values: plan.values.map((value) => ({
            id: value.id,
            kind: value.kind,
            label: value.label,
            required: value.required,
          })),
          requiresConfirmation: plan.steps.some(
            (step) => step.requiresConfirmation,
          ),
        }
      : {}),
    generatedBy: 'OpenRappter Show-and-Tell',
  }, null, 2)}\n`;
}

function renderAutomation(
  analysis: ShowAndTellAnalysis,
  name: string,
  plan?: ShowAndTellSkillPlan | null,
): string {
  const steps = plan
    ? plan.steps.map((step, index) => ({
        id: step.id || `s${index + 1}`,
        label: step.title,
        prompt:
          `${step.detail}` +
          `${step.tool ? ` Prefer ${step.tool}.` : ''}` +
          `${step.url ? ` Use ${step.url}.` : ''}`,
        values: step.values,
        requiresConfirmation: step.requiresConfirmation,
        riskCategories: step.riskCategories,
      }))
    : analysis.steps.map((step, index) => ({
        id: step.id || `s${index + 1}`,
        label: step.title,
        prompt:
          `${step.detail}` +
          `${step.tool ? ` Prefer ${step.tool}.` : ''}` +
          `${privacyReducedUrl(step.url)
            ? ` Use ${privacyReducedUrl(step.url)}.`
            : ''}`,
      }));
  return `${JSON.stringify({
    schema: SHOW_AND_TELL_AUTOMATION_SCHEMA,
    name,
    description: analysis.intent,
    enabled: false,
    trigger: { type: 'manual' },
    sourceSessionId: analysis.sessionId,
    sourceAnalysisRevision: analysis.revision,
    ...(plan
      ? {
          sourcePlanRevision: plan.revision,
          values: plan.values,
        }
      : {}),
    steps,
  }, null, 2)}\n`;
}

function existingSourceSession(
  directory: string,
  kind: ShowAndTellArtifactKind,
): string | null {
  const metadataFile = path.join(
    directory,
    kind === 'skill' ? 'manifest.json' : 'automation.json',
  );
  if (!existsSync(metadataFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(metadataFile, 'utf8')) as {
      sourceSessionId?: unknown;
    };
    return typeof parsed.sourceSessionId === 'string'
      ? parsed.sourceSessionId
      : null;
  } catch {
    return null;
  }
}

function destination(
  root: string,
  baseName: string,
  sessionId: string,
  kind: ShowAndTellArtifactKind,
): string {
  privateDirectory(root);
  let candidate = path.join(root, baseName);
  const candidateIsSafeDirectory =
    !existsSync(candidate) ||
    (!lstatSync(candidate).isSymbolicLink() && lstatSync(candidate).isDirectory());
  if (
    existsSync(candidate) &&
    (!candidateIsSafeDirectory ||
      existingSourceSession(candidate, kind) !== sessionId)
  ) {
    let index = 2;
    while (existsSync(path.join(root, `${baseName}-${index}`))) index += 1;
    candidate = path.join(root, `${baseName}-${index}`);
  }
  privateDirectory(candidate);
  return candidate;
}

export async function buildShowAndTellArtifacts(
  store: ShowAndTellStore,
  analysis: ShowAndTellAnalysis,
  target: 'skill' | 'automation' | 'all',
  plan: ShowAndTellSkillPlan | null = null,
  roots: { skills?: string; automations?: string } = {},
): Promise<ShowAndTellArtifact[]> {
  if (!analysis.approved) {
    throw new Error('Approve the Show-and-Tell analysis before building artifacts.');
  }
  if (plan) {
    if (!plan.approved) {
      throw new Error('Approve the Show-and-Tell plan before building artifacts.');
    }
    if (plan.analysisRevision !== analysis.revision) {
      throw new Error(
        `The approved plan was reviewed against analysis revision ${plan.analysisRevision}, but the current analysis is revision ${analysis.revision}. Propose the plan again.`,
      );
    }
    if (hasSecretFindings(plan.privacy.findings)) {
      throw new Error(
        'The approved plan still carries secret-shaped text. Re-record or edit it before building.',
      );
    }
  }
  const name = slugify((plan ?? analysis).title || analysis.intent);
  const built: ShowAndTellArtifact[] = [];
  if (target === 'skill' || target === 'all') {
    const root = path.resolve(
      roots.skills ??
        process.env.OPENRAPPTER_SKILLS_DIR ??
        openrappterPath('skills'),
    );
    const directory = destination(root, name, analysis.sessionId, 'skill');
    const markdown = plan
      ? renderMarketplaceSkill(plan, path.basename(directory))
      : renderShowAndTellSkill(analysis, path.basename(directory));
    const manifest = skillManifest(analysis, path.basename(directory), plan);
    if (artifactContainsSensitiveText(markdown)) {
      throw new Error('Privacy scan rejected the generated SKILL.md.');
    }
    if (artifactContainsSensitiveText(manifest)) {
      throw new Error('Privacy scan rejected the generated skill manifest.');
    }
    if (hasSecretFindings(scanSensitivePayload(markdown, 'SKILL.md'))) {
      throw new Error('Privacy scan rejected the generated SKILL.md.');
    }
    const skillFile = path.join(directory, 'SKILL.md');
    writePrivate(skillFile, markdown);
    writePrivate(path.join(directory, 'manifest.json'), manifest);
    built.push(
      await store.recordArtifact({
        sessionId: analysis.sessionId,
        kind: 'skill',
        name: path.basename(directory),
        path: skillFile,
        contentHash: createHash('sha256')
          .update(markdown)
          .update('\0')
          .update(manifest)
          .digest('hex'),
      }),
    );
  }
  if (target === 'automation' || target === 'all') {
    const root = path.resolve(
      roots.automations ??
        process.env.OPENRAPPTER_AUTOMATIONS_DIR ??
        openrappterPath('automations'),
    );
    const directory = destination(root, name, analysis.sessionId, 'automation');
    const content = renderAutomation(analysis, path.basename(directory), plan);
    if (artifactContainsSensitiveText(content)) {
      throw new Error('Privacy scan rejected the generated automation.');
    }
    const file = path.join(directory, 'automation.json');
    writePrivate(file, content);
    built.push(
      await store.recordArtifact({
        sessionId: analysis.sessionId,
        kind: 'automation',
        name: path.basename(directory),
        path: file,
        contentHash: createHash('sha256').update(content).digest('hex'),
      }),
    );
  }
  return built;
}

/**
 * Packages an approved plan into a marketplace layout and records it as an
 * artifact. The RAPPID dimension flow and any publish step read `path` and
 * `contentHash` from the returned artifact; this function attaches nothing
 * anywhere itself.
 */
export async function exportShowAndTellMarketplace(
  store: ShowAndTellStore,
  plan: ShowAndTellSkillPlan,
  options: Omit<MarketplaceExportInput, 'plan'> = {},
): Promise<{ artifact: ShowAndTellArtifact; export: MarketplaceExport }> {
  if (!plan.approved) {
    throw new Error('Approve the Show-and-Tell plan before exporting it.');
  }
  if (hasSecretFindings(plan.privacy.findings)) {
    throw new Error(
      'The approved plan still carries secret-shaped text. Re-record or edit it before exporting.',
    );
  }
  const exported = writeMarketplaceExport({ ...options, plan }, writePrivate);
  const validation = validateMarketplaceExport(exported.root);
  if (!validation.ok) {
    const failures = validation.checks
      .filter((check) => !check.ok)
      .map((check) => `${check.name}: ${check.detail}`)
      .join('; ');
    throw new Error(`The exported marketplace failed validation: ${failures}`);
  }
  const artifact = await store.recordArtifact({
    sessionId: plan.sessionId,
    kind: 'marketplace',
    name: exported.pluginName,
    path: exported.marketplacePath,
    contentHash: exported.contentHash,
  });
  return { artifact, export: exported };
}

/** Renders the export without writing it, for review before submission. */
export function previewShowAndTellMarketplace(
  plan: ShowAndTellSkillPlan,
  options: Omit<MarketplaceExportInput, 'plan'> = {},
): { files: string[]; contentHash: string } {
  const rendered = renderMarketplaceExport({ ...options, plan });
  return {
    files: rendered.files.map((file) => file.path),
    contentHash: marketplaceContentHash(rendered.files),
  };
}

function recordedMarketplaceFiles(
  artifact: ShowAndTellArtifact,
): MarketplaceFile[] {
  const marketplaceDirectory = path.dirname(path.dirname(artifact.path));
  const pluginDirectory = path.join(
    marketplaceDirectory,
    'plugins',
    artifact.name,
  );
  const pluginPath = path.join(pluginDirectory, '.claude-plugin', 'plugin.json');
  const plugin = JSON.parse(readFileSync(pluginPath, 'utf8')) as {
    skills?: unknown;
  };
  if (
    !Array.isArray(plugin.skills)
    || plugin.skills.length !== 1
    || typeof plugin.skills[0] !== 'string'
    || !/^\.\/skills\/[a-z0-9][a-z0-9-]{0,62}$/.test(plugin.skills[0])
  ) {
    throw new Error('Marketplace plugin does not name exactly one safe skill directory.');
  }
  const skillPath = path.resolve(pluginDirectory, plugin.skills[0], 'SKILL.md');
  const relativeSkill = path.relative(pluginDirectory, skillPath);
  if (relativeSkill.startsWith('..') || path.isAbsolute(relativeSkill)) {
    throw new Error('Marketplace skill path escapes its plugin directory.');
  }
  return [artifact.path, pluginPath, skillPath].map((file) => ({
    path: file,
    content: readFileSync(file, 'utf8'),
  }));
}

export async function testShowAndTellArtifacts(
  store: ShowAndTellStore,
  sessionId: string,
): Promise<{
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}> {
  const analysis = await store.getAnalysis(sessionId);
  const plan = await store.getPlan(sessionId);
  const artifacts = await store.artifacts(sessionId);
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [
    {
      name: 'analysis-approved',
      ok: analysis?.approved === true,
      detail: analysis?.approved ? 'Analysis is approved.' : 'Analysis is not approved.',
    },
    {
      name: 'artifacts-exist',
      ok: artifacts.length > 0,
      detail: `${artifacts.length} artifact(s) recorded.`,
    },
  ];
  if (plan) {
    checks.push({
      name: 'plan-approved',
      ok: plan.approved,
      detail: plan.approved
        ? `Plan revision ${plan.revision} is approved.`
        : `Plan revision ${plan.revision} is proposed but not approved.`,
    });
    checks.push({
      name: 'plan-privacy',
      ok: !hasSecretFindings(plan.privacy.findings),
      detail: hasSecretFindings(plan.privacy.findings)
        ? 'The plan carries secret-shaped text.'
        : `Plan privacy scan recorded ${plan.privacy.findings.length} masked finding(s); no raw frames were shared.`,
    });
  }
  for (const artifact of artifacts) {
    if (artifact.kind === 'marketplace') {
      const marketplaceDirectory = path.dirname(path.dirname(artifact.path));
      const validation = validateMarketplaceExport(marketplaceDirectory);
      checks.push(
        ...validation.checks.map((check) => ({
          name: `marketplace-${check.name}`,
          ok: check.ok,
          detail: check.detail,
        })),
      );
      let digest = '';
      try {
        digest = marketplaceContentHash(recordedMarketplaceFiles(artifact));
      } catch {
        digest = '';
      }
      checks.push({
        name: 'marketplace-integrity',
        ok: digest === artifact.contentHash,
        detail:
          digest === artifact.contentHash
            ? 'Marketplace content hash matches.'
            : 'Marketplace content hash changed or its files are unreadable.',
      });
      continue;
    }
    let content = '';
    try {
      content = readFileSync(artifact.path, 'utf8');
      checks.push({
        name: `${artifact.kind}-exists`,
        ok: true,
        detail: artifact.path,
      });
    } catch {
      checks.push({
        name: `${artifact.kind}-exists`,
        ok: false,
        detail: `Missing ${artifact.path}`,
      });
      continue;
    }
    let digest = createHash('sha256').update(content).digest('hex');
    let privacySafe = !artifactContainsSensitiveText(content);
    if (artifact.kind === 'skill') {
      const manifestPath = path.join(path.dirname(artifact.path), 'manifest.json');
      try {
        const manifest = readFileSync(manifestPath, 'utf8');
        const parsed = JSON.parse(manifest) as {
          sourceSessionId?: unknown;
          sourceAnalysisRevision?: unknown;
          sourcePlanRevision?: unknown;
          name?: unknown;
        };
        const manifestOk =
          parsed.sourceSessionId === sessionId &&
          parsed.name === artifact.name &&
          !artifactContainsSensitiveText(manifest);
        checks.push({
          name: 'skill-manifest',
          ok: manifestOk,
          detail: manifestOk
            ? 'Manifest matches the recorded session and skill.'
            : 'Manifest is missing, changed, or belongs to another session.',
        });
        const revisionOk =
          parsed.sourceAnalysisRevision === analysis?.revision;
        checks.push({
          name: 'skill-analysis-revision',
          ok: revisionOk,
          detail: revisionOk
            ? 'Skill matches the current analysis revision.'
            : 'Skill was built from an older analysis revision.',
        });
        privacySafe = privacySafe && !artifactContainsSensitiveText(manifest);
        digest = createHash('sha256')
          .update(content)
          .update('\0')
          .update(manifest)
          .digest('hex');
        if (plan) {
          const planRevisionOk = parsed.sourcePlanRevision === plan.revision;
          checks.push({
            name: 'skill-plan-revision',
            ok: planRevisionOk,
            detail: planRevisionOk
              ? 'Skill matches the approved plan revision.'
              : 'Skill was built from a different plan revision.',
          });
        }
      } catch {
        checks.push({
          name: 'skill-manifest',
          ok: false,
          detail: `Missing or invalid ${manifestPath}`,
        });
      }
    }
    checks.push({
      name: `${artifact.kind}-integrity`,
      ok: digest === artifact.contentHash,
      detail: digest === artifact.contentHash ? 'Content hash matches.' : 'Content hash changed.',
    });
    checks.push({
      name: `${artifact.kind}-privacy`,
      ok: privacySafe,
      detail: 'Artifact contains no secret-shaped text.',
    });
    if (artifact.kind === 'automation') {
      try {
        const parsed = JSON.parse(content) as {
          schema?: unknown;
          enabled?: unknown;
          sourceAnalysisRevision?: unknown;
        };
        checks.push({
          name: 'automation-shape',
          ok:
            parsed.schema === SHOW_AND_TELL_AUTOMATION_SCHEMA &&
            parsed.enabled === false,
          detail: 'Automation is versioned and disabled by default.',
        });
        const revisionOk =
          parsed.sourceAnalysisRevision === analysis?.revision;
        checks.push({
          name: 'automation-analysis-revision',
          ok: revisionOk,
          detail: revisionOk
            ? 'Automation matches the current analysis revision.'
            : 'Automation was built from an older analysis revision.',
        });
      } catch {
        checks.push({
          name: 'automation-shape',
          ok: false,
          detail: 'Automation is not valid JSON.',
        });
      }
    }
  }
  return { ok: checks.every((check) => check.ok), checks };
}

export function replayPlan(analysis: ShowAndTellAnalysis): {
  mode: 'dry-run';
  intent: string;
  steps: Array<{ number: number; title: string; tool: string; action: string }>;
  warning: string;
} {
  return {
    mode: 'dry-run',
    intent: sanitizeShowAndTellText(analysis.intent, 1200),
    steps: analysis.steps.map((step, index) => ({
      number: index + 1,
      title: step.title,
      tool: step.tool,
      action: step.detail,
    })),
    warning:
      'Dry run only. Show-and-Tell never blindly replays recorded coordinates or submits side effects.',
  };
}
