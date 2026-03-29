import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata, AgentResult } from './types.js';
import { AgentGraph } from './graph.js';
import { DocScannerAgent } from './DocScannerAgent.js';
import { HNPipelineAgent } from './HNPipelineAgent.js';
import { NotesIntakeAgent } from './NotesIntakeAgent.js';
import { MemoryAgent } from './MemoryAgent.js';

class ReportAssemblerAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = { name: 'ReportAssembler', description: 'Assembles a unified productivity report from parallel agent results.', parameters: { type: 'object', properties: {}, required: [] } };
    super('ReportAssembler', metadata);
  }
  async perform(_kwargs: Record<string, unknown>): Promise<string> {
    const upstream = (this.context?.upstream_slush ?? {}) as Record<string, Record<string, unknown>>;
    const docScan = upstream['docScan'] ?? {};
    const hnPipeline = upstream['hnPipeline'] ?? {};
    const notesIntake = upstream['notesIntake'] ?? {};
    const report = {
      generated_at: new Date().toISOString(),
      workspace: { total_files: docScan['total_files'] ?? 0, todo_count: docScan['todo_count'] ?? 0, recent_files: docScan['recent_files'] ?? [], file_types: docScan['file_types'] ?? {} },
      hacker_news: { highlight_count: hnPipeline['highlight_count'] ?? 0, top_highlight: hnPipeline['top_highlight'] ?? null, keywords_matched: hnPipeline['keywords_matched'] ?? [] },
      notes: { action_item_count: notesIntake['action_item_count'] ?? 0, completed_count: notesIntake['completed_count'] ?? 0, high_urgency_count: notesIntake['high_urgency_count'] ?? 0, tags_found: notesIntake['tags_found'] ?? [], notes_scanned: notesIntake['notes_scanned'] ?? 0 }
    };
    const summary = `${report.workspace.total_files} files scanned, ${report.workspace.todo_count} TODOs found. ${report.hacker_news.highlight_count} HN highlights. ${report.notes.action_item_count} action items (${report.notes.high_urgency_count} urgent).`;
    return JSON.stringify({ status: 'success', report, summary, data_slush: { source_agent: 'ReportAssembler', report, summary } });
  }
}

class ReportStorageAgent extends BasicAgent {
  private memoryAgent: BasicAgent;
  constructor(memoryAgent?: BasicAgent) {
    const metadata: AgentMetadata = { name: 'ReportStorage', description: 'Stores the productivity report in memory.', parameters: { type: 'object', properties: {}, required: [] } };
    super('ReportStorage', metadata);
    this.memoryAgent = memoryAgent || new MemoryAgent();
  }
  async perform(_kwargs: Record<string, unknown>): Promise<string> {
    const upstream = (this.context?.upstream_slush ?? {}) as Record<string, Record<string, unknown>>;
    const reportSlush = upstream['report'] ?? {};
    const summary = (reportSlush['summary'] as string) || 'Productivity report (no summary)';
    const result = await this.memoryAgent.execute({ action: 'remember', message: `Productivity Report: ${summary}`, theme: 'productivity_report', tags: ['productivity', 'daily'], importance: 3 });
    return JSON.stringify({ status: 'success', stored: true, memory_result: result });
  }
}

export class ProductivityStackAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = { name: 'ProductivityStack', description: 'Runs workspace doc scan, HN pipeline, and notes intake in parallel, assembles a unified productivity report, and stores it in memory.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['run', 'status'], description: 'Action to perform' }, docsPath: { type: 'string', description: 'Directory to scan for docs' }, notesPath: { type: 'string', description: 'Obsidian vault or notes directory' }, keywords: { type: 'array', items: { type: 'string' }, description: 'HN filter keywords' }, hnCount: { type: 'integer', description: 'Number of HN stories to fetch' }, query: { type: 'string', description: 'Natural language query' } }, required: [] } };
    super('ProductivityStack', metadata);
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const action = (kwargs.action as string) || 'run';
    if (action === 'status') return JSON.stringify({ status: 'success', message: 'ProductivityStack is available. Actions: run, status.' });
    const docsPath = (kwargs.docsPath as string) || '.';
    const notesPath = (kwargs.notesPath as string) || '.';
    const keywords = (kwargs.keywords as string[]) || ['ai', 'agent', 'typescript', 'framework', 'llm'];
    const hnCount = (kwargs.hnCount as number) || 5;
    const graph = new AgentGraph()
      .addNode({ name: 'docScan', agent: new DocScannerAgent(), kwargs: { path: docsPath } })
      .addNode({ name: 'hnPipeline', agent: new HNPipelineAgent(), kwargs: { keywords, count: hnCount } })
      .addNode({ name: 'notesIntake', agent: new NotesIntakeAgent(), kwargs: { path: notesPath } })
      .addNode({ name: 'report', agent: new ReportAssemblerAgent(), dependsOn: ['docScan', 'hnPipeline', 'notesIntake'] })
      .addNode({ name: 'store', agent: new ReportStorageAgent(), dependsOn: ['report'] });
    const result = await graph.run();
    const reportNode = result.nodes.get('report');
    let report = null; let summary = '';
    if (reportNode?.status === 'success' && reportNode.result) {
      const ar = reportNode.result as AgentResult & { report?: unknown; summary?: string };
      report = ar.report ?? null; summary = ar.summary ?? '';
    }
    return JSON.stringify({ status: result.status, report, summary, execution_order: result.executionOrder, total_duration_ms: result.totalDurationMs, node_statuses: Object.fromEntries(Array.from(result.nodes.entries()).map(([n, nd]) => [n, nd.status])), data_slush: { source_agent: 'ProductivityStack', report, summary, duration_ms: result.totalDurationMs } });
  }
}
