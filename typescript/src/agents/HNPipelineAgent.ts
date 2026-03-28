import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';
import { HackerNewsAgent } from './HackerNewsAgent.js';

interface Highlight { title: string; url: string; score: number; relevance_keyword: string; }

export class HNPipelineAgent extends BasicAgent {
  private hnAgent: BasicAgent;
  constructor(hnAgent?: BasicAgent) {
    const metadata: AgentMetadata = { name: 'HNPipeline', description: 'Fetches top Hacker News stories, filters by project-relevant keywords, and returns highlights.', parameters: { type: 'object', properties: { keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to filter stories by' }, count: { type: 'integer', description: 'Number of stories to fetch (1-10)' }, query: { type: 'string', description: 'Natural language query' } }, required: [] } };
    super('HNPipeline', metadata);
    this.hnAgent = hnAgent || new HackerNewsAgent();
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const keywords = (kwargs.keywords as string[]) || ['ai', 'agent', 'typescript', 'framework', 'llm'];
    const count = Math.min(Math.max((kwargs.count as number) || 5, 1), 10);
    try {
      const hnResult = await this.hnAgent.execute({ action: 'fetch', count, dryRun: true });
      const parsed = JSON.parse(hnResult);
      if (parsed.status === 'error') return JSON.stringify({ status: 'error', message: `HN fetch failed: ${parsed.message}`, data_slush: { source_agent: 'HNPipeline', highlight_count: 0 } });
      const stories = (parsed.stories || []) as Array<{ title: string; url: string; score: number; hn_link: string }>;
      const highlights: Highlight[] = [];
      for (const story of stories) { const tl = (story.title || '').toLowerCase(); const ul = (story.url || '').toLowerCase(); for (const kw of keywords) { if (tl.includes(kw.toLowerCase()) || ul.includes(kw.toLowerCase())) { highlights.push({ title: story.title, url: story.url || story.hn_link, score: story.score, relevance_keyword: kw }); break; } } }
      const finalHighlights = highlights.length > 0 ? highlights : stories.slice(0, 3).map(s => ({ title: s.title, url: s.url || s.hn_link, score: s.score, relevance_keyword: '(general)' }));
      const keywordsMatched = [...new Set(finalHighlights.map(h => h.relevance_keyword).filter(k => k !== '(general)'))];
      return JSON.stringify({ status: 'success', total_fetched: stories.length, filtered_count: highlights.length, highlights: finalHighlights, data_slush: { source_agent: 'HNPipeline', highlight_count: finalHighlights.length, top_highlight: finalHighlights[0]?.title || null, keywords_matched: keywordsMatched } });
    } catch (err) { return JSON.stringify({ status: 'error', message: `HN pipeline failed: ${(err as Error).message}`, data_slush: { source_agent: 'HNPipeline', highlight_count: 0 } }); }
  }
}
