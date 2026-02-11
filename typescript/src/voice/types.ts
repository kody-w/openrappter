/**
 * Voice module types
 */

export interface TTSProvider {
  name: string;
  synthesize(text: string, options?: TTSOptions): Promise<Buffer>;
  getVoices(): Promise<Voice[]>;
  isAvailable(): Promise<boolean>;
}

export interface TTSOptions {
  voice?: string;
  speed?: number;
  pitch?: number;
  format?: 'mp3' | 'wav' | 'ogg' | 'opus';
}

export interface Voice {
  id: string;
  name: string;
  language: string;
  gender?: 'male' | 'female' | 'neutral';
  preview?: string;
}

export interface TranscriptionProvider {
  name: string;
  transcribe(audio: Buffer, options?: TranscriptionOptions): Promise<TranscriptionResult>;
  isAvailable(): Promise<boolean>;
}

export interface TranscriptionOptions {
  language?: string;
  prompt?: string;
  format?: 'text' | 'json' | 'srt' | 'vtt';
  timestamps?: boolean;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
  segments?: TranscriptionSegment[];
}

export interface TranscriptionSegment {
  id: number;
  start: number;
  end: number;
  text: string;
  confidence?: number;
}

export interface VoiceConfig {
  tts: {
    provider: 'elevenlabs' | 'openai' | 'edge' | 'local';
    defaultVoice?: string;
    speed?: number;
    autoTTS?: boolean;
  };
  transcription: {
    provider: 'whisper' | 'openai' | 'local';
    language?: string;
  };
}
