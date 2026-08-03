/**
 * The organism, read as anatomy rather than as a directory listing.
 *
 * The bones window used to answer *what files exist*. That is inventory, and
 * Kody's verdict on it was blunt and correct: "it needs to not be just the raw
 * files... that is the openclaw slop pattern." Anatomy answers a different
 * question — **what this creature is, which parts are alive, and what it can
 * do.** Files are the substance underneath, not the presentation.
 *
 * So every organ here reports three things:
 *
 *   - a **state**: alive / degraded / absent
 *   - a **reading**: the one value worth seeing, live where it can be live
 *   - a **consequence**: what it means for you, in plain language
 *
 * "SOUL.md — 0 B" is inventory. "This organism has no name; it will sound like
 * every other assistant until you give it one" is anatomy.
 *
 * Two refusals carried over from `BonesInspector` and deliberately preserved:
 *
 *   1. `.env` and anything credential-shaped is **never read**. It is presented
 *      as the Vault, sealed — a better framing of the same refusal, not a
 *      weakening of it. Contents never enter this payload, so they can never
 *      reach a DOM that might be screenshotted or shared.
 *   2. A missing file is **shown as missing**, never silently dropped, because
 *      "you have no SOUL.md" is the useful answer to why it sounds generic.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

export type OrganState = 'alive' | 'degraded' | 'absent' | 'sealed';

export interface OrganFile {
  name: string;
  path: string;
  bytes: number;
  missing: boolean;
  /** True for credential-shaped files. Their contents are never read. */
  secret: boolean;
}

export interface Organ {
  /** Stable id, also the SVG region id it is wired to. */
  id: string;
  /** The anatomical name — the museum specimen label. */
  anatomical: string;
  /** The plain-English name for the same thing. */
  plain: string;
  state: OrganState;
  /** The single value worth reading, right now. */
  reading: string;
  /** What this means for the person, in a sentence. */
  consequence: string;
  /** Capabilities or contents — named by what they DO, not what they are called. */
  detail: { label: string; sub?: string }[];
  /** The real files underneath, one level down. Drillable, never the headline. */
  files: OrganFile[];
}

export interface VitalSigns {
  awake: boolean;
  /** Chosen rung of the backend ladder, and why. */
  backend: string;
  backendReason: string;
  uptime: string;
  agentCount: number;
  /** The organism's own name, or null when it has never been given one. */
  name: string | null;
  version: string;
  heartbeat: string;
}

export interface Anatomy {
  home: string;
  generatedAt: string;
  vitals: VitalSigns;
  organs: Organ[];
}

/** Files whose contents must never be read, whatever the caller asks for. */
export function isSecretFile(p: string): boolean {
  const name = path.basename(p).toLowerCase();
  return (
    name === '.env' ||
    name.startsWith('.env.') ||
    name.includes('credential') ||
    name.includes('token') ||
    name.includes('secret') ||
    name === 'auth-profiles.json'
  );
}

function stat(p: string): { bytes: number; missing: boolean; mtime: number } {
  try {
    const s = fs.statSync(p);
    return { bytes: s.size, missing: false, mtime: s.mtimeMs };
  } catch {
    return { bytes: 0, missing: true, mtime: 0 };
  }
}

function fileOf(dir: string, name: string): OrganFile {
  const full = path.join(dir, name);
  const s = stat(full);
  return { name, path: full, bytes: s.bytes, missing: s.missing, secret: isSecretFile(full) };
}

function listDir(dir: string, exts: string[]): OrganFile[] {
  try {
    return fs
      .readdirSync(dir)
      .filter(f => exts.some(e => f.endsWith(e)))
      .sort()
      .map(f => fileOf(dir, f));
  } catch {
    return [];
  }
}

function readJson<T>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as T; } catch { return null; }
}

function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function relativeTime(ms: number): string {
  if (!ms) return 'never';
  const delta = Date.now() - ms;
  if (delta < 0) return 'in ' + humanDuration(-delta);
  if (delta < 60_000) return 'just now';
  return humanDuration(delta) + ' ago';
}

/** Live signals the gateway can supply. Absent when the daemon is asleep. */
export interface LiveSignals {
  awake: boolean;
  backend?: { kind: string; reason: string };
  startedAt?: number;
  agents?: { name: string; description?: string }[];
  connections?: number;
  port?: number;
  version?: string;
  cron?: { name: string; agentId?: string; nextRun?: string | null; lastRun?: string | null; enabled?: boolean }[];
  channels?: { type: string; connected: boolean }[];
}

export function readAnatomy(
  home: string = path.join(os.homedir(), '.openrappter'),
  live: LiveSignals = { awake: false },
): Anatomy {
  const organs: Organ[] = [];

  // ── Skull — the soul ───────────────────────────────────────────────────────
  const identityNames = ['SOUL.md', 'IDENTITY.md', 'USER.md', 'BOOTSTRAP.md'];
  const identityFiles = identityNames.map(n => fileOf(home, n));
  const presentIdentity = identityFiles.filter(f => !f.missing && f.bytes > 0);
  const soulName = (() => {
    const soul = path.join(home, 'SOUL.md');
    try {
      const first = fs.readFileSync(soul, 'utf-8').split('\n').find(l => l.trim().length > 0);
      return first ? first.replace(/^#+\s*/, '').trim().slice(0, 60) : null;
    } catch { return null; }
  })();
  organs.push({
    id: 'skull',
    anatomical: 'Cranium',
    plain: 'Soul',
    state: presentIdentity.length > 0 ? 'alive' : 'absent',
    reading: presentIdentity.length > 0 ? `${presentIdentity.length} of 4 written` : 'unwritten',
    consequence: presentIdentity.length > 0
      ? 'It knows who it is. This is read into every prompt it sends.'
      : 'This organism has no name. It will sound like every other assistant until you give it one.',
    detail: identityFiles.map(f => ({
      label: f.name.replace('.md', ''),
      sub: f.missing ? 'missing' : `${f.bytes} B`,
    })),
    files: identityFiles,
  });

  // ── Brain — the model it thinks with ───────────────────────────────────────
  const backendKind = live.backend?.kind ?? 'unknown';
  organs.push({
    id: 'brain',
    anatomical: 'Cerebrum',
    plain: 'Mind',
    state: !live.awake ? 'absent' : backendKind === 'none' ? 'degraded' : 'alive',
    reading: live.awake ? backendKind : 'asleep',
    consequence: !live.awake
      ? 'No daemon running, so nothing is thinking. The body is intact; it is asleep.'
      : backendKind === 'none'
        ? 'No backend can answer right now. It can still read its own files, but it cannot talk.'
        : live.backend?.reason ?? 'A backend is answering.',
    detail: [
      { label: backendKind === 'none' ? 'no backend' : backendKind, sub: live.backend?.reason },
    ],
    files: [],
  });

  // ── Spine — the build it stands on ─────────────────────────────────────────
  const releasePath = path.join(os.homedir(), '.local', 'share', 'openrappter', 'current');
  let spineTarget: string | null = null;
  try { spineTarget = fs.readlinkSync(releasePath); } catch { spineTarget = null; }
  organs.push({
    id: 'spine',
    anatomical: 'Vertebrae',
    plain: 'Skeleton',
    state: spineTarget ? 'alive' : 'degraded',
    reading: spineTarget ? path.basename(spineTarget) : 'no release link',
    consequence: !spineTarget
      ? 'No release symlink. The daemon may run a different checkout than the one you edit.'
      : live.awake
        ? 'The daemon runs a released build, so what is in git is what is on this machine.'
        : 'A released build is in place and ready. Nothing is standing on it right now.',
    detail: [
      { label: live.version ? `v${live.version}` : 'version unknown' },
      { label: spineTarget ? path.basename(spineTarget) : 'unlinked', sub: 'current release' },
    ],
    files: [],
  });

  // ── Heart — the pulse ──────────────────────────────────────────────────────
  const cronFile = path.join(home, 'cron.json');
  const cronOnDisk = readJson<{ name?: string; schedule?: string; agentId?: string }[]>(cronFile) ?? [];
  const cronJobs: NonNullable<LiveSignals['cron']> =
    live.cron ?? cronOnDisk.map(j => ({ name: j.name ?? 'job', agentId: j.agentId, nextRun: null, lastRun: null }));
  const nextFire = cronJobs
    .map(j => (j.nextRun ? Date.parse(j.nextRun) : 0))
    .filter(t => t > 0)
    .sort((a, b) => a - b)[0];
  organs.push({
    id: 'heart',
    anatomical: 'Cardium',
    plain: 'Pulse',
    state: !live.awake ? 'absent' : cronJobs.length === 0 ? 'degraded' : 'alive',
    reading: !live.awake
      ? 'no pulse'
      : nextFire
        ? `next beat ${relativeTime(nextFire)}`
        : `${cronJobs.length} job${cronJobs.length === 1 ? '' : 's'}`,
    consequence: !live.awake
      ? 'Nothing is scheduled to wake it. Start the daemon and the pulse resumes.'
      : cronJobs.length === 0
        ? 'Nothing is scheduled. It only acts when you talk to it.'
        : 'It wakes itself on a schedule, without you asking.',
    detail: cronJobs.map(j => ({
      label: j.name ?? 'job',
      sub: j.nextRun ? `next ${relativeTime(Date.parse(j.nextRun))}` : (j.enabled === false ? 'disabled' : 'not scheduled'),
    })),
    files: [fileOf(home, 'cron.json')],
  });

  // ── Bloodstream — the gateway ──────────────────────────────────────────────
  organs.push({
    id: 'blood',
    anatomical: 'Circulation',
    plain: 'Gateway',
    state: live.awake ? 'alive' : 'absent',
    reading: live.awake ? `:${live.port ?? 18790} · ${live.connections ?? 0} connected` : 'closed',
    consequence: live.awake
      ? 'Everything that talks to it — the menu bar, the browser, your phone — comes through here.'
      : 'The port is closed. Nothing can reach it until the daemon starts.',
    detail: [
      { label: `port ${live.port ?? 18790}`, sub: live.awake ? 'listening' : 'closed' },
      { label: `${live.connections ?? 0} live connection${live.connections === 1 ? '' : 's'}` },
      { label: live.startedAt ? `up ${humanDuration(Date.now() - live.startedAt)}` : 'not running' },
    ],
    files: [],
  });

  // ── Senses — how it perceives and speaks ───────────────────────────────────
  const channels = live.channels ?? [];
  const connectedChannels = channels.filter(c => c.connected);
  const gvState = fileOf(home, 'google-voice-watch.json');
  organs.push({
    id: 'senses',
    anatomical: 'Sensoria',
    plain: 'Senses',
    state: !live.awake ? 'absent' : connectedChannels.length > 0 ? 'alive' : 'degraded',
    reading: !live.awake
      ? 'closed'
      : connectedChannels.length > 0
        ? `${connectedChannels.length} open`
        : 'chat only',
    consequence: connectedChannels.length > 0
      ? 'It can hear and answer on these without you opening an app.'
      : 'It only hears you when you type. No phone, no chat apps connected.',
    detail: channels.length > 0
      ? channels.map(c => ({ label: c.type, sub: c.connected ? 'connected' : 'disconnected' }))
      : [{ label: 'chat', sub: 'the only way in right now' }],
    files: [gvState],
  });

  // ── Claws — what it can actually DO ────────────────────────────────────────
  //
  // Named by capability, not by filename. `morning_brief_agent.js` is not the
  // interesting fact; "Morning Brief — summarises your day" is.
  const agentsDir = path.join(home, 'agents');
  const agentFiles = listDir(agentsDir, ['.py', '.js', '.ts']);
  const liveAgents = live.agents ?? [];
  organs.push({
    id: 'claws',
    anatomical: 'Manus',
    plain: 'Hands',
    state: liveAgents.length > 0 || agentFiles.length > 0 ? 'alive' : 'absent',
    reading: live.awake
      ? `${liveAgents.length} capabilit${liveAgents.length === 1 ? 'y' : 'ies'}`
      : `${agentFiles.length} on disk`,
    consequence: liveAgents.length > 0
      ? 'These are the things it can do beyond talking. Drop a .py file on this window to add one.'
      : agentFiles.length > 0
        ? 'These are on disk but nothing has loaded them — it is asleep. They come back with the daemon.'
        : 'It can talk, but it cannot act. Drop an agent file on this window to give it a hand.',
    detail: liveAgents.length > 0
      ? liveAgents.map(a => ({ label: a.name, sub: a.description || undefined }))
      : agentFiles.map(f => ({ label: f.name, sub: 'on disk, not loaded' })),
    files: agentFiles,
  });

  // ── Gut — memory ───────────────────────────────────────────────────────────
  const memoryFile = fileOf(home, 'memory.json');
  const sessionsFile = fileOf(home, 'sessions.json');
  const memory = readJson<unknown>(path.join(home, 'memory.json'));
  const memoryCount = Array.isArray(memory)
    ? memory.length
    : memory && typeof memory === 'object'
      ? Object.keys(memory as Record<string, unknown>).length
      : 0;
  organs.push({
    id: 'gut',
    anatomical: 'Viscera',
    plain: 'Memory',
    state: memoryCount > 0 ? 'alive' : 'absent',
    reading: memoryCount > 0 ? `${memoryCount} kept` : 'empty',
    consequence: memoryCount > 0
      ? 'It remembers these across restarts. This is what makes it yours and not a fresh session.'
      : 'It remembers nothing yet. Every conversation starts from zero.',
    detail: [
      { label: 'remembered', sub: memoryCount > 0 ? `${memoryCount} entries` : 'nothing yet' },
      { label: 'conversations', sub: sessionsFile.missing ? 'none' : `${(sessionsFile.bytes / 1024).toFixed(1)} KB of history` },
    ],
    files: [memoryFile, sessionsFile],
  });

  // ── Vault — the GOD layer, sealed ──────────────────────────────────────────
  //
  // Names and sizes only. Contents are never read, so they cannot appear in this
  // payload, in the DOM, or in a screenshot of it.
  const vaultFiles = [fileOf(home, '.env'), fileOf(home, 'auth-profiles.json'), fileOf(home, 'config.json')];
  const sealedCount = vaultFiles.filter(f => !f.missing && f.secret).length;
  organs.push({
    id: 'vault',
    anatomical: 'Cavum',
    plain: 'Vault',
    state: 'sealed',
    reading: sealedCount > 0 ? `${sealedCount} sealed` : 'nothing stored',
    consequence: 'Credentials live here, on this machine only. This page never reads their contents — only that they exist.',
    detail: vaultFiles.map(f => ({
      label: f.name,
      sub: f.missing ? 'not present' : f.secret ? 'sealed' : `${f.bytes} B`,
    })),
    files: vaultFiles.map(f => ({ ...f, path: f.secret ? '' : f.path })),
  });

  // ── Hide — the public surface (DOG) ────────────────────────────────────────
  const skillsDir = path.join(home, 'skills');
  let skillCount = 0;
  try { skillCount = fs.readdirSync(skillsDir).length; } catch { skillCount = 0; }
  const logFile = fileOf(home, 'daemon.log');
  organs.push({
    id: 'hide',
    anatomical: 'Integument',
    plain: 'Surface',
    state: skillCount > 0 || !logFile.missing ? 'alive' : 'absent',
    reading: skillCount > 0 ? `${skillCount} skill${skillCount === 1 ? '' : 's'}` : 'bare',
    consequence: 'What it emits outward — logs, skills, anything shareable. Nothing private crosses this boundary.',
    detail: [
      { label: 'skills', sub: skillCount > 0 ? `${skillCount} installed` : 'none installed' },
      { label: 'daemon log', sub: logFile.missing ? 'no log' : `${(logFile.bytes / 1024 / 1024).toFixed(1)} MB` },
    ],
    files: [logFile],
  });

  const vitals: VitalSigns = {
    awake: live.awake,
    backend: live.awake ? backendKind : 'asleep',
    backendReason: live.backend?.reason ?? 'no daemon is running',
    uptime: live.startedAt ? humanDuration(Date.now() - live.startedAt) : '—',
    agentCount: liveAgents.length || agentFiles.length,
    name: soulName,
    version: live.version ?? 'unknown',
    heartbeat: nextFire ? relativeTime(nextFire) : (live.awake ? 'no schedule' : 'none'),
  };

  return { home, generatedAt: new Date().toISOString(), vitals, organs };
}
