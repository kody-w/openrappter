import type { LLMProvider, Message, ChatOptions, ProviderResponse } from './types.js';

export class CopilotProvider implements LLMProvider {
  readonly id = 'copilot';
  readonly name = 'GitHub Copilot';
  private clientId = 'Iv1.b507a08c87ecfe98';

  async chat(
    messages: Message[],
    options?: ChatOptions
  ): Promise<ProviderResponse> {
    // Check if Copilot SDK is available
    try {
      // Try to import the SDK dynamically
      const copilotSdk = await import('@github/copilot-sdk');

      // If we get here, SDK is available but implementation is not yet complete
      throw new Error('Copilot SDK integration not yet implemented');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
        throw new Error('Copilot SDK not available - install @github/copilot-sdk to use this provider');
      }
      throw error;
    }
  }

  async isAvailable(): Promise<boolean> {
    return !!process.env.GITHUB_TOKEN;
  }
}

export function createCopilotProvider(): LLMProvider {
  return new CopilotProvider();
}
