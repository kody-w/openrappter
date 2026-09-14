import { object, text } from './contract.js';
import { type JsonObject } from './canonical.js';
import { discoveryEvidence, type NativePointer, type NativeProvider } from './estate.js';
import { requireThat } from './errors.js';

// Explicit selected metadata in, pointer out; no filesystem, profile discovery or content import.
export function nativeMetadataPointer(provider: NativeProvider, value: unknown): NativePointer {
  const input = object(value);
  let title: string, locator: string, nativeShape: string;
  const handle = (value: unknown): string => {
    const s = text(value, 100);
    requireThat(/^[A-Za-z0-9_-]+$/u.test(s), 'native-handle', 'A safe opaque native identifier is required.');
    return s;
  };
  if (provider === 'copilot') {
    object(input, ['session_id', 'title', 'cwd_reference']);
    title = text(input.title, 120); text(input.cwd_reference, 200);
    locator = `native://copilot/session/${handle(input.session_id)}`;
    nativeShape = 'Copilot session_id + cwd_reference; native session is not copied';
  } else if (provider === 'claude') {
    object(input, ['project_key', 'session']);
    const session = object(input.session, ['uuid', 'title']);
    title = text(session.title, 120);
    locator = `native://claude/project/${handle(input.project_key)}/session/${handle(session.uuid)}`;
    nativeShape = 'Claude project_key + session UUID; project encoding remains native';
  } else if (provider === 'hermes') {
    object(input, ['session']);
    const session = object(input.session, ['id', 'title', 'workspace_reference']);
    title = text(session.title, 120); text(session.workspace_reference, 200);
    locator = `native://hermes/session/${handle(session.id)}`;
    nativeShape = 'Hermes native session object and workspace reference; no database normalization';
  } else if (provider === 'scout') {
    object(input, ['workspace', 'conversation_key']);
    const workspace = object(input.workspace, ['key', 'title']);
    title = text(workspace.title, 120);
    locator = `native://scout/workspace/${handle(workspace.key)}/conversation/${handle(input.conversation_key)}`;
    nativeShape = 'Scout workspace key + conversation key; native shape remains a pointer';
  } else {
    requireThat(provider === 'grokbot', 'native-provider', 'Unknown native metadata adapter.');
    object(input, ['workspaceId', 'threadId', 'label']);
    title = text(input.label, 120);
    locator = `native://grokbot/workspace/${handle(input.workspaceId)}/thread/${handle(input.threadId)}`;
    nativeShape = 'Grokbot workspaceId + threadId; no private thread import';
  }
  const pointer: JsonObject = { id: `native-${provider}`, provider, title, nativeShape, locator };
  return discoveryEvidence({ origin: 'sanitized-fixture', observedUtc: '2026-09-13T00:00:00.000Z', historical: true, pointers: [pointer] }).pointers[0]!;
}
