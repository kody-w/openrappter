import { describe, it, expect } from 'vitest';
import { BasicAgent } from '../../agents/BasicAgent.js';
import { AgentGraph } from '../../agents/graph.js';
import type { AgentMetadata } from '../../agents/types.js';

class MockDocScannerAgent extends BasicAgent {
  constructor() { super('DocScanner', { name: 'DocScanner', description: 'Mock doc scanner', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path' } }, required: ['path'] } } as AgentMetadata); }
  async perform(): Promise<string> { return JSON.stringify({ status: 'success', summary: { total_files: 12, file_types: { '.md': 8, '.txt': 3, '.pdf': 1 }, recent_files: [{ name: 'README.md' }, { name: 'notes.md' }], todos: [{ file: 'README.md', line: '5', match: 'TODO: update install docs' }, { file: 'notes.md', line: '12', match: 'FIXME: broken link' }] }, data_slush: { source_agent: 'DocScanner', total_files: 12, todo_count: 2, recent_files: ['README.md', 'notes.md'], file_types: { '.md': 8, '.txt': 3, '.pdf': 1 } } }); }
}

class MockHNPipelineAgent extends BasicAgent {
  constructor() { super('HNPipeline', { name: 'HNPipeline', description: 'Mock HN pipeline', parameters: { type: 'object', properties: {}, required: [] } } as AgentMetadata); }
  async perform(): Promise<string> { return JSON.stringify({ status: 'success', total_fetched: 5, filtered_count: 2, highlights: [{ title: 'New AI Agent Framework', url: 'https://example.com/1', score: 300, relevance_keyword: 'agent' }, { title: 'TypeScript 6.0 Release', url: 'https://example.com/2', score: 200, relevance_keyword: 'typescript' }], data_slush: { source_agent: 'HNPipeline', highlight_count: 2, top_highlight: 'New AI Agent Framework', keywords_matched: ['agent', 'typescript'] } }); }
}

class MockNotesIntakeAgent extends BasicAgent {
  constructor() { super('NotesIntake', { name: 'NotesIntake', description: 'Mock notes intake', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path' } }, required: ['path'] } } as AgentMetadata); }
  async perform(): Promise<string> { return JSON.stringify({ status: 'success', notes_scanned: 15, action_items: [{ text: 'Fix auth flow 2026-03-28', file: 'Roadmap.md', line: 3, urgency: 'high', date: '2026-03-28', tags: ['urgent'] }, { text: 'Write tests', file: 'Roadmap.md', line: 7, urgency: 'low', tags: [] }, { text: 'Review PR #42', file: 'Tasks.md', line: 1, urgency: 'medium', tags: ['important'] }], completed_count: 8, reminders: [{ text: 'Fix auth flow', urgency: 'high' }], tags: ['important', 'project', 'urgent'], data_slush: { source_agent: 'NotesIntake', action_item_count: 3, completed_count: 8, high_urgency_count: 1, tags_found: ['important', 'project', 'urgent'], notes_scanned: 15 } }); }
}

class MockReportAssemblerAgent extends BasicAgent {
  constructor() { super('ReportAssembler', { name: 'ReportAssembler', description: 'Assembles report', parameters: { type: 'object', properties: {}, required: [] } } as AgentMetadata); }
  async perform(): Promise<string> {
    const upstream = (this.context?.upstream_slush ?? {}) as Record<string, Record<string, unknown>>;
    const d = upstream['docScan'] ?? {}, h = upstream['hnPipeline'] ?? {}, n = upstream['notesIntake'] ?? {};
    const report = { workspace: { total_files: d['total_files'] ?? 0, todo_count: d['todo_count'] ?? 0 }, hacker_news: { highlight_count: h['highlight_count'] ?? 0, top_highlight: h['top_highlight'] ?? null }, notes: { action_item_count: n['action_item_count'] ?? 0, high_urgency_count: n['high_urgency_count'] ?? 0 } };
    const summary = `${report.workspace.total_files} files scanned, ${report.workspace.todo_count} TODOs found. ${report.hacker_news.highlight_count} HN highlights. ${report.notes.action_item_count} action items (${report.notes.high_urgency_count} urgent).`;
    return JSON.stringify({ status: 'success', report, summary, data_slush: { source_agent: 'ReportAssembler', report, summary } });
  }
}

class FailingAgent extends BasicAgent {
  constructor(name: string) { super(name, { name, description: 'Always fails', parameters: { type: 'object', properties: {}, required: [] } } as AgentMetadata); }
  async perform(): Promise<string> { throw new Error('Agent failed'); }
}

describe('ProductivityStack', () => {
  describe('Metadata', () => {
    it('DocScanner has correct metadata', () => { expect(new MockDocScannerAgent().name).toBe('DocScanner'); });
    it('HNPipeline has correct metadata', () => { expect(new MockHNPipelineAgent().name).toBe('HNPipeline'); });
    it('NotesIntake has correct metadata', () => { expect(new MockNotesIntakeAgent().name).toBe('NotesIntake'); });
  });

  describe('AgentGraph integration', () => {
    it('runs 3 feature agents in parallel and report last', async () => {
      const graph = new AgentGraph().addNode({ name: 'docScan', agent: new MockDocScannerAgent(), kwargs: { path: '/docs' } }).addNode({ name: 'hnPipeline', agent: new MockHNPipelineAgent(), kwargs: {} }).addNode({ name: 'notesIntake', agent: new MockNotesIntakeAgent(), kwargs: { path: '/notes' } }).addNode({ name: 'report', agent: new MockReportAssemblerAgent(), dependsOn: ['docScan', 'hnPipeline', 'notesIntake'] });
      const result = await graph.run();
      expect(result.status).toBe('success');
      expect(result.executionOrder).toHaveLength(4);
      expect(result.executionOrder.indexOf('report')).toBe(3);
    });

    it('report receives merged upstream_slush from all 3 sources', async () => {
      const graph = new AgentGraph().addNode({ name: 'docScan', agent: new MockDocScannerAgent(), kwargs: { path: '/docs' } }).addNode({ name: 'hnPipeline', agent: new MockHNPipelineAgent(), kwargs: {} }).addNode({ name: 'notesIntake', agent: new MockNotesIntakeAgent(), kwargs: { path: '/notes' } }).addNode({ name: 'report', agent: new MockReportAssemblerAgent(), dependsOn: ['docScan', 'hnPipeline', 'notesIntake'] });
      const result = await graph.run();
      const rn = result.nodes.get('report')!;
      expect(rn.status).toBe('success');
      const ar = rn.result as unknown as Record<string, unknown>;
      const report = ar.report as Record<string, Record<string, unknown>>;
      expect(report.workspace.total_files).toBe(12);
      expect(report.hacker_news.highlight_count).toBe(2);
      expect(report.notes.action_item_count).toBe(3);
    });

    it('produces unified summary string', async () => {
      const graph = new AgentGraph().addNode({ name: 'docScan', agent: new MockDocScannerAgent(), kwargs: { path: '/docs' } }).addNode({ name: 'hnPipeline', agent: new MockHNPipelineAgent(), kwargs: {} }).addNode({ name: 'notesIntake', agent: new MockNotesIntakeAgent(), kwargs: { path: '/notes' } }).addNode({ name: 'report', agent: new MockReportAssemblerAgent(), dependsOn: ['docScan', 'hnPipeline', 'notesIntake'] });
      const result = await graph.run();
      const summary = (result.nodes.get('report')!.result as unknown as Record<string, unknown>).summary as string;
      expect(summary).toContain('12 files scanned');
      expect(summary).toContain('2 HN highlights');
      expect(summary).toContain('3 action items');
      expect(summary).toContain('1 urgent');
    });

    it('handles partial failure: one agent fails, report skipped', async () => {
      const graph = new AgentGraph().addNode({ name: 'docScan', agent: new MockDocScannerAgent(), kwargs: { path: '/docs' } }).addNode({ name: 'hnPipeline', agent: new FailingAgent('HNPipeline'), kwargs: {} }).addNode({ name: 'notesIntake', agent: new MockNotesIntakeAgent(), kwargs: { path: '/notes' } }).addNode({ name: 'report', agent: new MockReportAssemblerAgent(), dependsOn: ['docScan', 'hnPipeline', 'notesIntake'] });
      const result = await graph.run();
      expect(result.status).toBe('partial');
      expect(result.nodes.get('hnPipeline')?.status).toBe('error');
      expect(result.nodes.get('report')?.status).toBe('skipped');
    });
  });

  describe('data_slush flow', () => {
    it('each feature agent produces data_slush with source_agent', async () => {
      const d = JSON.parse(await new MockDocScannerAgent().execute({ path: '/docs' }));
      const h = JSON.parse(await new MockHNPipelineAgent().execute({}));
      const n = JSON.parse(await new MockNotesIntakeAgent().execute({ path: '/notes' }));
      expect(d.data_slush.source_agent).toBe('DocScanner');
      expect(h.data_slush.source_agent).toBe('HNPipeline');
      expect(n.data_slush.source_agent).toBe('NotesIntake');
    });

    it('report assembler produces data_slush with full report', async () => {
      const graph = new AgentGraph().addNode({ name: 'docScan', agent: new MockDocScannerAgent(), kwargs: { path: '/docs' } }).addNode({ name: 'hnPipeline', agent: new MockHNPipelineAgent(), kwargs: {} }).addNode({ name: 'notesIntake', agent: new MockNotesIntakeAgent(), kwargs: { path: '/notes' } }).addNode({ name: 'report', agent: new MockReportAssemblerAgent(), dependsOn: ['docScan', 'hnPipeline', 'notesIntake'] });
      const result = await graph.run();
      const rn = result.nodes.get('report')!;
      expect(rn.dataSlush?.source_agent).toBe('ReportAssembler');
      expect(rn.dataSlush?.report).toBeDefined();
      expect(rn.dataSlush?.summary).toContain('12 files');
    });
  });

  describe('DocScanner unit', () => {
    it('returns correct file type breakdown', async () => { const p = JSON.parse(await new MockDocScannerAgent().execute({ path: '/test' })); expect(p.summary.file_types['.md']).toBe(8); expect(p.summary.total_files).toBe(12); });
    it('returns TODOs', async () => { const p = JSON.parse(await new MockDocScannerAgent().execute({ path: '/test' })); expect(p.summary.todos).toHaveLength(2); expect(p.summary.todos[0].match).toContain('TODO'); });
  });

  describe('NotesIntake unit', () => {
    it('returns action items with urgency', async () => { const p = JSON.parse(await new MockNotesIntakeAgent().execute({ path: '/notes' })); expect(p.action_items).toHaveLength(3); expect(p.action_items[0].urgency).toBe('high'); });
    it('returns extracted tags', async () => { const p = JSON.parse(await new MockNotesIntakeAgent().execute({ path: '/notes' })); expect(p.tags).toContain('urgent'); });
  });
});
