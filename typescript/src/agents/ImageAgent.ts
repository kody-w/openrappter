/**
 * ImageAgent - Image analysis and processing agent.
 *
 * Analyzes images from URLs or file paths and processes web images
 * with SSRF protection. Integrates with media processor service.
 *
 * Actions: analyze, process_url
 */

import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

export class ImageAgent extends BasicAgent {
  private mediaProcessor: any = null;

  constructor() {
    const metadata: AgentMetadata = {
      name: 'Image',
      description: 'Analyze and process images. Extract information from image URLs or local files with SSRF protection.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'The image action to perform.',
            enum: ['analyze', 'process_url'],
          },
          url: {
            type: 'string',
            description: "Image URL (for 'analyze' or 'process_url' actions).",
          },
          path: {
            type: 'string',
            description: "Local file path (for 'analyze' action).",
          },
          query: {
            type: 'string',
            description: "Analysis query or prompt (for 'analyze' action).",
          },
        },
        required: [],
      },
    };
    super('Image', metadata);
  }

  private async getMediaProcessor() {
    if (!this.mediaProcessor) {
      const { MediaProcessor } = await import('../media/processor.js');
      this.mediaProcessor = new MediaProcessor();
    }
    return this.mediaProcessor;
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const action = kwargs.action as string | undefined;
    const url = kwargs.url as string | undefined;
    const path = kwargs.path as string | undefined;
    const query = kwargs.query as string | undefined;

    if (!action) {
      return JSON.stringify({
        status: 'error',
        message: 'No action specified. Use: analyze or process_url',
      });
    }

    try {
      const media = await this.getMediaProcessor();

      switch (action) {
        case 'analyze':
          if (!url && !path) {
            return JSON.stringify({ status: 'error', message: 'url or path required for analyze action' });
          }
          const source = url || path || '';

          // Validate URL for SSRF if it's a URL
          if (url) {
            this.validateUrl(url);
          }

          const analysis = await media.analyze(source, query);
          return JSON.stringify({
            status: 'success',
            action: 'analyze',
            source,
            query,
            analysis,
          });

        case 'process_url':
          if (!url) {
            return JSON.stringify({ status: 'error', message: 'url required for process_url action' });
          }

          this.validateUrl(url);

          const processed = await media.processUrl(url);
          return JSON.stringify({
            status: 'success',
            action: 'process_url',
            url,
            processed,
          });

        default:
          return JSON.stringify({
            status: 'error',
            message: `Unknown action: ${action}`,
          });
      }
    } catch (error) {
      return JSON.stringify({
        status: 'error',
        action,
        message: (error as Error).message,
      });
    }
  }

  private validateUrl(url: string): void {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    // Block private IP ranges (SSRF protection)
    const privatePatterns = [
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[01])\./,
      /^192\.168\./,
      /^127\./,
      /^0\./,
      /^169\.254\./,
      /^::1$/,
      /^fc00:/,
      /^fe80:/,
    ];

    for (const pattern of privatePatterns) {
      if (pattern.test(hostname)) {
        throw new Error(`Access to private IP range blocked: ${hostname}`);
      }
    }

    // Block localhost
    if (hostname === 'localhost' || hostname.endsWith('.local')) {
      throw new Error(`Access to localhost blocked: ${hostname}`);
    }
  }
}
