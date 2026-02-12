/**
 * TTSAgent - Text-to-speech agent.
 *
 * Converts text to speech audio using the voice synthesis service.
 * Returns base64-encoded audio or voice metadata.
 *
 * Actions: speak, voices, status
 */

import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

export class TTSAgent extends BasicAgent {
  private ttsService: any = null;

  constructor() {
    const metadata: AgentMetadata = {
      name: 'TTS',
      description: 'Text-to-speech synthesis. Convert text to spoken audio with multiple voice options.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'The TTS action to perform.',
            enum: ['speak', 'voices', 'status'],
          },
          text: {
            type: 'string',
            description: "Text to convert to speech (for 'speak' action).",
          },
          voice: {
            type: 'string',
            description: "Voice ID or name to use (for 'speak' action).",
          },
          format: {
            type: 'string',
            description: "Audio format: mp3, wav, ogg (for 'speak' action).",
          },
        },
        required: [],
      },
    };
    super('TTS', metadata);
  }

  private async getTTSService() {
    if (!this.ttsService) {
      const { TTSService } = await import('../voice/tts.js');
      this.ttsService = new TTSService();
    }
    return this.ttsService;
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const action = kwargs.action as string | undefined;
    const text = kwargs.text as string | undefined;
    const voice = kwargs.voice as string | undefined;
    const format = (kwargs.format as string | undefined) || 'mp3';

    if (!action) {
      return JSON.stringify({
        status: 'error',
        message: 'No action specified. Use: speak, voices, or status',
      });
    }

    try {
      const tts = await this.getTTSService();

      switch (action) {
        case 'speak':
          if (!text) {
            return JSON.stringify({ status: 'error', message: 'Text required for speak action' });
          }
          const audio = await tts.speak(text, { voice, format });
          return JSON.stringify({
            status: 'success',
            action: 'speak',
            text: text.slice(0, 100),
            voice,
            format,
            audio: audio.toString('base64'),
            size: audio.length,
          });

        case 'voices':
          const voices = await tts.listVoices();
          return JSON.stringify({
            status: 'success',
            action: 'voices',
            voices,
            count: voices.length,
          });

        case 'status':
          const status = await tts.getStatus();
          return JSON.stringify({
            status: 'success',
            action: 'status',
            ...status,
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
}
