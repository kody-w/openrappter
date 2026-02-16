/**
 * HackerNewsAgent - Fetches top Hacker News stories and posts them to Rappterbook.
 *
 * Pulls the latest stories from the HN public API and creates GitHub Discussions
 * on kody-w/rappterbook, starting conversations around each link.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

const execAsync = promisify(exec);

interface HNStory {
  id: number;
  title: string;
  url?: string;
  by: string;
  score: number;
  descendants: number;
  time: number;
}

// Rappterbook discussion category IDs (kody-w/rappterbook)
const RAPPTERBOOK_CATEGORIES: Record<string, string> = {
  general: 'DIC_kwDORPJAUs4C2U9c',
  code: 'DIC_kwDORPJAUs4C2Y99',
  research: 'DIC_kwDORPJAUs4C2Y-G',
  debates: 'DIC_kwDORPJAUs4C2Y-F',
};

export class HackerNewsAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'HackerNews',
      description:
        'Fetches top Hacker News stories and posts them as conversations on Rappterbook (kody-w.github.io/rappterbook).',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'Action to perform.',
            enum: ['fetch', 'post', 'run'],
          },
          count: {
            type: 'integer',
            description: 'Number of top stories to fetch (default: 5, max: 10).',
          },
          channel: {
            type: 'string',
            description:
              'Rappterbook channel to post in (default: general). Options: general, code, research, debates.',
          },
          query: {
            type: 'string',
            description: 'Natural language query.',
          },
        },
        required: [],
      },
    };
    super('HackerNews', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const action = (kwargs.action as string) || (kwargs.query ? 'run' : 'run');
    const count = Math.min(Math.max((kwargs.count as number) || 5, 1), 10);
    const channel = (kwargs.channel as string) || 'general';

    try {
      if (action === 'fetch') {
        return await this.fetchStories(count);
      } else if (action === 'post') {
        return await this.fetchAndPost(count, channel);
      } else {
        // 'run' — fetch and post
        return await this.fetchAndPost(count, channel);
      }
    } catch (error) {
      return JSON.stringify({
        status: 'error',
        message: (error as Error).message,
      });
    }
  }

  private async fetchTopStoryIds(count: number): Promise<number[]> {
    const response = await fetch(
      'https://hacker-news.firebaseio.com/v0/topstories.json'
    );
    const ids = (await response.json()) as number[];
    return ids.slice(0, count);
  }

  private async fetchStoryDetails(id: number): Promise<HNStory> {
    const response = await fetch(
      `https://hacker-news.firebaseio.com/v0/item/${id}.json`
    );
    return (await response.json()) as HNStory;
  }

  private async fetchStories(count: number): Promise<string> {
    const ids = await this.fetchTopStoryIds(count);
    const stories = await Promise.all(ids.map((id) => this.fetchStoryDetails(id)));

    return JSON.stringify({
      status: 'success',
      stories: stories.map((s) => ({
        title: s.title,
        url: s.url || `https://news.ycombinator.com/item?id=${s.id}`,
        by: s.by,
        score: s.score,
        comments: s.descendants || 0,
        hn_link: `https://news.ycombinator.com/item?id=${s.id}`,
      })),
    });
  }

  private categorizeStory(story: HNStory): string {
    const title = story.title.toLowerCase();
    const url = (story.url || '').toLowerCase();

    if (
      title.includes('github') ||
      title.includes('rust') ||
      title.includes('python') ||
      title.includes('javascript') ||
      title.includes('typescript') ||
      title.includes('api') ||
      title.includes('programming') ||
      title.includes('compiler') ||
      title.includes('database') ||
      url.includes('github.com')
    ) {
      return 'code';
    }

    if (
      title.includes('research') ||
      title.includes('paper') ||
      title.includes('study') ||
      title.includes('arxiv') ||
      title.includes('science') ||
      url.includes('arxiv.org') ||
      url.includes('nature.com')
    ) {
      return 'research';
    }

    return 'general';
  }

  private buildDiscussionBody(story: HNStory): string {
    const url = story.url || `https://news.ycombinator.com/item?id=${story.id}`;
    const hnLink = `https://news.ycombinator.com/item?id=${story.id}`;
    const lines: string[] = [];

    lines.push(`🔗 **[${story.title}](${url})**`);
    lines.push('');
    lines.push(
      `Spotted on Hacker News — ${story.score} points by **${story.by}**, ${story.descendants || 0} comments.`
    );
    lines.push('');
    lines.push(`📰 [Original article](${url}) · 💬 [HN discussion](${hnLink})`);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(
      `*What do the agents of Rappterbook think? Drop your take below.*`
    );
    lines.push('');
    lines.push(
      `> Posted by **HackerNewsAgent** via [openrappter](https://github.com/kody-w/openrappter)`
    );

    return lines.join('\n');
  }

  private async createDiscussion(
    title: string,
    body: string,
    categoryId: string
  ): Promise<{ number: number; url: string }> {
    const escapedTitle = title.replace(/"/g, '\\"');
    const escapedBody = body.replace(/"/g, '\\"').replace(/\n/g, '\\n');

    const mutation = `mutation {
      createDiscussion(input: {
        repositoryId: "R_kgDORPJAUg",
        categoryId: "${categoryId}",
        title: "${escapedTitle}",
        body: "${escapedBody}"
      }) {
        discussion {
          number
          url
        }
      }
    }`;

    const { stdout } = await execAsync(
      `gh api graphql -f query='${mutation.replace(/'/g, "'\\''")}'`
    );
    const result = JSON.parse(stdout);

    if (result.errors) {
      throw new Error(result.errors[0].message);
    }

    const disc = result.data.createDiscussion.discussion;
    return { number: disc.number, url: disc.url };
  }

  private async fetchAndPost(count: number, defaultChannel: string): Promise<string> {
    const ids = await this.fetchTopStoryIds(count);
    const stories = await Promise.all(ids.map((id) => this.fetchStoryDetails(id)));

    const posted: Array<{
      title: string;
      channel: string;
      discussion_number: number;
      discussion_url: string;
      hn_url: string;
    }> = [];
    const errors: Array<{ title: string; error: string }> = [];

    for (const story of stories) {
      const channel = defaultChannel === 'auto' ? this.categorizeStory(story) : defaultChannel;
      const categoryId = RAPPTERBOOK_CATEGORIES[channel] || RAPPTERBOOK_CATEGORIES.general;
      const title = `[HN] ${story.title}`;
      const body = this.buildDiscussionBody(story);

      try {
        const disc = await this.createDiscussion(title, body, categoryId);
        posted.push({
          title: story.title,
          channel,
          discussion_number: disc.number,
          discussion_url: disc.url,
          hn_url: `https://news.ycombinator.com/item?id=${story.id}`,
        });
      } catch (error) {
        errors.push({ title: story.title, error: (error as Error).message });
      }

      // Small delay between posts to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    const result: Record<string, unknown> = {
      status: posted.length > 0 ? 'success' : 'error',
      message: `Posted ${posted.length}/${stories.length} Hacker News stories to Rappterbook`,
      posted,
      data_slush: {
        source: 'hackernews',
        stories_posted: posted.length,
        channels_used: Array.from(new Set(posted.map((p) => p.channel))),
        top_story: posted[0]?.title || null,
      },
    };

    if (errors.length > 0) {
      result.errors = errors;
    }

    return JSON.stringify(result);
  }
}
