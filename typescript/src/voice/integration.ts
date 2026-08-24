import type { VoiceProviderId } from './types.js';
import type {
  GrailVoiceSettings,
} from './grail-adapter.js';
import type {
  VoiceConversationSnapshot,
} from './conversation.js';

/**
 * Typed audio seam shared by the current desktop and future organism shells.
 * Egg sound assets are referenced by opaque ids; this module never imports an
 * asset tree or depends on the unmerged organism implementation.
 */
export type VoiceAudioDescriptor =
  | {
      kind: 'generated-speech';
      provider: VoiceProviderId;
      mimeType: string;
      sha256: string;
      durationSeconds: number;
    }
  | {
      kind: 'organism-sound';
      assetId: string;
      purpose: 'egg' | 'hatch' | 'state-change';
    };

export interface VoiceSurfaceState {
  provider: VoiceProviderId;
  enabled: boolean;
  speaking: boolean;
  errorCode?: string;
}

/** XPedition/Grail surfaces can implement this without changing their shells. */
export interface VoiceSurfaceAdapter {
  readonly settings?: GrailVoiceSettings;
  setVoiceState(state: VoiceSurfaceState): void;
  setConversationState?(state: VoiceConversationSnapshot): void;
  playVoiceAudio(descriptor: VoiceAudioDescriptor, audio: Uint8Array): Promise<void>;
  stopVoiceAudio(): void;
}
