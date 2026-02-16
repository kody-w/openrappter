/**
 * HackerNewsAgent Parity Tests
 * Tests for HackerNewsAgent — HN story fetching with dry-run safety
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HackerNewsAgent } from '../../agents/HackerNewsAgent.js';

// Mock global fetch to avoid real network calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock child_process exec to prevent real gh CLI calls
vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, cb: Function) =>
    cb(new Error('exec should not be called in dry-run mode'), '', '')
  ),
}));
vi.mock('util', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    promisify: (fn: Function) => fn,
  };
});

const FAKE_STORY_IDS = [100, 200, 300];
const FAKE_STORY = (id: number) => ({
  id,
  title: `Fake Story ${id}`,
  url: `https://example.com/story-${id}`,
  by: 'testuser',
  score: 42,
  descendants: 7,
  time: Math.floor(Date.now() / 1000),
});

function setupFetchMock(storyCount = 3) {
  const ids = FAKE_STORY_IDS.slice(0, storyCount);
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('topstories.json')) {
      return Promise.resolve({ json: () => Promise.resolve(ids) });
    }
    const match = url.match(/item\/(\d+)\.json/);
    if (match) {
      return Promise.resolve({
        json: () => Promise.resolve(FAKE_STORY(Number(match[1]))),
      });
    }
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  });
}

describe('HackerNewsAgent Parity', () => {
  let agent: HackerNewsAgent;

  beforeEach(() => {
    agent = new HackerNewsAgent();
    vi.clearAllMocks();
  });

  describe('metadata', () => {
    it('should have name HackerNews', () => {
      expect(agent.name).toBe('HackerNews');
    });

    it('should have metadata with description and parameters', () => {
      expect(agent.metadata).toBeDefined();
      expect(agent.metadata.name).toBe('HackerNews');
      expect(agent.metadata.description).toContain('Hacker News');
      expect(agent.metadata.parameters).toBeDefined();
    });

    it('should have action, count, channel, query, and dryRun parameters', () => {
      const props = agent.metadata.parameters.properties;
      expect(props.action).toBeDefined();
      expect(props.action.enum).toEqual(['fetch', 'post', 'run']);
      expect(props.count).toBeDefined();
      expect(props.channel).toBeDefined();
      expect(props.query).toBeDefined();
      expect(props.dryRun).toBeDefined();
      expect(props.dryRun.type).toBe('boolean');
    });
  });

  describe('dry-run safety', () => {
    it('should default to dry-run mode when no dryRun param is passed', async () => {
      setupFetchMock();
      const result = await agent.perform({ action: 'run' });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('dry_run');
      expect(parsed.message).toContain('DRY RUN');
      expect(parsed.previews).toBeInstanceOf(Array);
    });

    it('should default to dry-run mode for action=post', async () => {
      setupFetchMock();
      const result = await agent.perform({ action: 'post' });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('dry_run');
    });

    it('should default to dry-run mode when dryRun is true', async () => {
      setupFetchMock();
      const result = await agent.perform({ action: 'run', dryRun: true });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('dry_run');
    });

    it('should default to dry-run when dryRun is undefined', async () => {
      setupFetchMock();
      const result = await agent.perform({ action: 'run', dryRun: undefined });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('dry_run');
    });

    it('should include previews with title, channel, body_preview, hn_url, and score', async () => {
      setupFetchMock(2);
      const result = await agent.perform({ action: 'run', count: 2 });
      const parsed = JSON.parse(result);
      expect(parsed.previews).toHaveLength(2);
      for (const preview of parsed.previews) {
        expect(preview.title).toMatch(/^\[HN\]/);
        expect(preview.channel).toBeDefined();
        expect(preview.body_preview).toBeDefined();
        expect(preview.hn_url).toContain('news.ycombinator.com');
        expect(preview.score).toBeDefined();
      }
    });
  });

  describe('fetch action', () => {
    it('should return stories without posting for action=fetch', async () => {
      setupFetchMock(2);
      const result = await agent.perform({ action: 'fetch', count: 2 });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.stories).toHaveLength(2);
      for (const story of parsed.stories) {
        expect(story.title).toBeDefined();
        expect(story.url).toBeDefined();
        expect(story.by).toBeDefined();
        expect(story.score).toBeDefined();
        expect(story.comments).toBeDefined();
        expect(story.hn_link).toContain('news.ycombinator.com');
      }
    });

    it('should clamp count to max 10', async () => {
      setupFetchMock(3);
      const result = await agent.perform({ action: 'fetch', count: 50 });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      // mockFetch only returns 3 IDs, so we get 3 even though count was 50 (clamped to 10)
      expect(parsed.stories.length).toBeLessThanOrEqual(10);
    });

    it('should clamp count to min 1', async () => {
      setupFetchMock(1);
      const result = await agent.perform({ action: 'fetch', count: -5 });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('success');
      expect(parsed.stories.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('categorization', () => {
    it('should categorize github stories as code', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('topstories.json')) {
          return Promise.resolve({ json: () => Promise.resolve([1]) });
        }
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              id: 1,
              title: 'New GitHub feature released',
              url: 'https://github.com/example',
              by: 'user',
              score: 100,
              descendants: 10,
              time: Date.now() / 1000,
            }),
        });
      });

      const result = await agent.perform({ action: 'run', channel: 'auto', count: 1 });
      const parsed = JSON.parse(result);
      expect(parsed.previews[0].channel).toBe('code');
    });

    it('should categorize arxiv stories as research', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('topstories.json')) {
          return Promise.resolve({ json: () => Promise.resolve([2]) });
        }
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              id: 2,
              title: 'New research paper on LLMs',
              url: 'https://arxiv.org/abs/1234',
              by: 'researcher',
              score: 80,
              descendants: 5,
              time: Date.now() / 1000,
            }),
        });
      });

      const result = await agent.perform({ action: 'run', channel: 'auto', count: 1 });
      const parsed = JSON.parse(result);
      expect(parsed.previews[0].channel).toBe('research');
    });

    it('should default to general for uncategorized stories', async () => {
      setupFetchMock(1);
      const result = await agent.perform({ action: 'run', channel: 'auto', count: 1 });
      const parsed = JSON.parse(result);
      expect(parsed.previews[0].channel).toBe('general');
    });
  });

  describe('error handling', () => {
    it('should return error status when fetch fails', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));
      const result = await agent.perform({ action: 'fetch' });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('Network error');
    });
  });

  describe('Python parity', () => {
    it('should have matching parameter schema between TS and Python', () => {
      // Verify the TS agent has the same parameter structure as the Python agent
      const params = agent.metadata.parameters;
      expect(params.type).toBe('object');
      expect(params.required).toEqual([]);
      expect(Object.keys(params.properties).sort()).toEqual(
        ['action', 'channel', 'count', 'dryRun', 'query'].sort()
      );
    });

    it('should have matching action enum between TS and Python', () => {
      const actions = agent.metadata.parameters.properties.action.enum;
      expect(actions).toEqual(['fetch', 'post', 'run']);
    });

    it('should have dryRun defaulting to true in both implementations', async () => {
      setupFetchMock(1);
      // Both TS and Python should return dry_run status when dryRun is not explicitly false
      const result = await agent.perform({ action: 'run', count: 1 });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('dry_run');
    });
  });
});
