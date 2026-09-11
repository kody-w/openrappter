import type { WorkAgent, WorkApproval, WorkMessage, WorkThread, WorkWorkspace } from './work.js';

// These examples never enter gateway calls, persistent storage, or the live approval queue.
const agents: WorkAgent[] = [
  { id: 'example-finance', name: 'Finance', description: 'Reporting & financial analysis', presence: 'active' },
  { id: 'example-operations', name: 'Operations', description: 'Processes & delivery', presence: 'idle' },
  { id: 'example-research', name: 'Research', description: 'Sources & market intelligence', presence: 'active' },
];

const workspaces: WorkWorkspace[] = agents.map((agent) => ({
  id: `${agent.id}-workspace`,
  agentId: agent.id,
  name: `${agent.name} workspace`,
  rootPath: `~/workspaces/${agent.name.toLowerCase()}/files`,
  memoryPath: `~/workspaces/${agent.name.toLowerCase()}/memory`,
  isolation: 'dedicated',
  status: agent.presence,
}));

const threads: WorkThread[] = [
  {
    id: 'example-review', agentId: 'example-finance', title: 'September operating review',
    messageCount: 3, createdAt: '2026-09-11T13:40:00Z', updatedAt: '2026-09-11T13:44:00Z',
  },
  {
    id: 'example-handoff', agentId: 'example-operations', title: 'Client handoff checklist',
    messageCount: 2, createdAt: '2026-09-11T12:00:00Z', updatedAt: '2026-09-11T12:05:00Z',
  },
  {
    id: 'example-research-brief', agentId: 'example-research', title: 'Supplier comparison brief',
    messageCount: 2, createdAt: '2026-09-11T13:20:00Z', updatedAt: '2026-09-11T13:24:00Z',
  },
];

const messages: Record<string, WorkMessage[]> = {
  'example-review': [
    {
      id: 'example-brief', role: 'user', timestamp: '2026-09-11T13:40:00Z',
      content: 'Prepare the September operating review. Compare actuals to plan, flag material variances, and draft a one-page summary. Don’t email anyone or change the source files.',
    },
    {
      id: 'example-sources', role: 'assistant', timestamp: '2026-09-11T13:42:00Z',
      content: 'I reviewed the two local source files. Revenue is 4.2% above plan; contractor spend is the largest cost variance. I’ll separate observed results from assumptions.',
      citations: [
        {
          id: 'example-actuals', title: 'September actuals.csv', source: 'finance/files/september-actuals.csv · rows 12–28',
          excerpt: 'Example data: revenue $248,000; planned revenue $238,000.',
        },
        {
          id: 'example-plan', title: 'Operating plan.md', source: 'finance/files/operating-plan.md · § Cost assumptions',
          excerpt: 'Example assumption: contractor costs exclude the one-time migration.',
        },
      ],
    },
    {
      id: 'example-draft', role: 'assistant', timestamp: '2026-09-11T13:44:00Z',
      content: 'The review is ready to draft. I’ve included the cost variance, its source, and the question that still needs an owner. Saving the draft requires your approval.',
    },
  ],
  'example-handoff': [
    { id: 'example-handoff-brief', role: 'user', timestamp: '2026-09-11T12:00:00Z', content: 'Build a reusable checklist for the client handoff. Keep account credentials out of the document.' },
    { id: 'example-handoff-response', role: 'assistant', timestamp: '2026-09-11T12:05:00Z', content: 'The checklist covers delivery owners, acceptance criteria, and the support handoff. It stays in the Operations workspace.' },
  ],
  'example-research-brief': [
    { id: 'example-research-input', role: 'user', timestamp: '2026-09-11T13:20:00Z', content: 'Compare the three supplier proposals. Cite the proposals and call out missing information.' },
    { id: 'example-research-response', role: 'assistant', timestamp: '2026-09-11T13:24:00Z', content: 'I’m comparing price, delivery windows, and support terms. Two proposals do not state renewal pricing; that is an open question, not a confirmed cost.' },
  ],
};

const approvals: WorkApproval[] = [{
  id: 'example-save-review',
  agentId: 'example-finance',
  command: 'Save finance/files/september-review.md',
  description: 'Create one review draft in the Finance workspace. Do not modify source files or send a message.',
  status: 'pending',
}];

export const LOCAL_WORK_DEMO = { agents, workspaces, threads, messages, approvals };
