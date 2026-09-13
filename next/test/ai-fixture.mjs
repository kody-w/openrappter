import { AI_RIGHTS, VIEW_SCHEMA } from '../dist/ai-contract.js';

export function issue(h, root, name, rights = AI_RIGHTS, scope = 'root', extra = {}) {
  return h.runtime.ai.authority.grant(root, {
    name, provider: name.toLowerCase().replaceAll(' ', '-'), scope, rights: [...rights], ttlSeconds: 3_600, ...extra,
  }, `issue-${name.toLowerCase().replaceAll(' ', '-')}`);
}
export function view(focus = 'root', emphasis = 'conversation', cards = [], extra = {}) {
  return { schema: VIEW_SCHEMA, focus, emphasis, cards, progress: null, screenArtifact: null, ...extra };
}
export function publish(kind, content, hint, parents = [], causes = []) {
  return { kind, content, causes, ...(hint === undefined ? {} : { view: hint, viewParents: parents }) };
}
