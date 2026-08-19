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
  privacyReducedUrl,
  sanitizeShowAndTellText,
} from './privacy.js';
import type { ShowAndTellStore } from './store.js';
import {
  SHOW_AND_TELL_AUTOMATION_SCHEMA,
  type ShowAndTellAnalysis,
  type ShowAndTellArtifact,
  type ShowAndTellArtifactKind,
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
): string {
  return `${JSON.stringify({
    id: `show-and-tell/${name}`,
    name,
    version: '1.0.0',
    description: analysis.intent,
    tags: ['show-and-tell', 'recorded-workflow'],
    sourceSessionId: analysis.sessionId,
    sourceAnalysisRevision: analysis.revision,
    generatedBy: 'OpenRappter Show-and-Tell',
  }, null, 2)}\n`;
}

function renderAutomation(analysis: ShowAndTellAnalysis, name: string): string {
  return `${JSON.stringify({
    schema: SHOW_AND_TELL_AUTOMATION_SCHEMA,
    name,
    description: analysis.intent,
    enabled: false,
    trigger: { type: 'manual' },
    sourceSessionId: analysis.sessionId,
    sourceAnalysisRevision: analysis.revision,
    steps: analysis.steps.map((step, index) => ({
      id: step.id || `s${index + 1}`,
      label: step.title,
      prompt:
        `${step.detail}` +
        `${step.tool ? ` Prefer ${step.tool}.` : ''}` +
        `${privacyReducedUrl(step.url)
          ? ` Use ${privacyReducedUrl(step.url)}.`
          : ''}`,
    })),
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
): Promise<ShowAndTellArtifact[]> {
  if (!analysis.approved) {
    throw new Error('Approve the Show-and-Tell analysis before building artifacts.');
  }
  const name = slugify(analysis.title || analysis.intent);
  const built: ShowAndTellArtifact[] = [];
  if (target === 'skill' || target === 'all') {
    const root = path.resolve(
      process.env.OPENRAPPTER_SKILLS_DIR ??
        openrappterPath('skills'),
    );
    const directory = destination(root, name, analysis.sessionId, 'skill');
    const markdown = renderShowAndTellSkill(analysis, path.basename(directory));
    const manifest = skillManifest(analysis, path.basename(directory));
    if (artifactContainsSensitiveText(markdown)) {
      throw new Error('Privacy scan rejected the generated SKILL.md.');
    }
    if (artifactContainsSensitiveText(manifest)) {
      throw new Error('Privacy scan rejected the generated skill manifest.');
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
      process.env.OPENRAPPTER_AUTOMATIONS_DIR ??
        openrappterPath('automations'),
    );
    const directory = destination(root, name, analysis.sessionId, 'automation');
    const content = renderAutomation(analysis, path.basename(directory));
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

export async function testShowAndTellArtifacts(
  store: ShowAndTellStore,
  sessionId: string,
): Promise<{
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}> {
  const analysis = await store.getAnalysis(sessionId);
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
  for (const artifact of artifacts) {
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
