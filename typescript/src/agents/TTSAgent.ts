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
import { exec } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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
      const { createTTSService } = await import('../voice/tts.js');
      this.ttsService = createTTSService({
        elevenlabsKey: process.env.ELEVENLABS_API_KEY,
        openaiKey: process.env.OPENAI_API_KEY,
        useEdge: true, // Free, no API key needed
      });
    }
    return this.ttsService;
  }

  private playAudio(filePath: string): Promise<void> {
    return new Promise((resolve) => {
      // macOS: afplay, Linux: aplay/paplay/mpv, Windows: start
      const cmd = process.platform === 'darwin'
        ? `afplay "${filePath}"`
        : process.platform === 'win32'
          ? `start "" "${filePath}"`
          : `mpv --no-video "${filePath}" 2>/dev/null || aplay "${filePath}" 2>/dev/null || paplay "${filePath}" 2>/dev/null`;

      exec(cmd, () => {
        // Clean up temp file after playback
        try { unlinkSync(filePath); } catch {}
        resolve();
      });
    });
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
          const audio = await tts.synthesize(text, { voice, format });
          // Save to temp file and play it
          const tmpPath = join(tmpdir(), `openrappter-tts-${Date.now()}.${format}`);
          writeFileSync(tmpPath, audio);
          await this.playAudio(tmpPath);
          return JSON.stringify({
            status: 'success',
            action: 'speak',
            text: text.slice(0, 100),
            voice,
            format,
            played: true,
          });

        case 'voices':
          const voices = await tts.getVoices();
          return JSON.stringify({
            status: 'success',
            action: 'voices',
            voices,
            count: voices.length,
          });

        case 'status':
          const availableVoices = await tts.getVoices();
          const providers = [...new Set(availableVoices.map((v: { provider: string }) => v.provider))];
          return JSON.stringify({
            status: 'success',
            action: 'status',
            providers,
            voiceCount: availableVoices.length,
            available: providers.length > 0,
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
