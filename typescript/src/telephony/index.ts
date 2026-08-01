/**
 * Telephony — give the agent a phone line.
 *
 * Outbound calls with a goal and hard limits, negotiation against those limits,
 * an approval gate that a language model cannot talk its way past, a PIN-gated
 * inbound hotline, and every step recorded in the RAPP Second Brain.
 *
 *   import { CallAgent, SimulationProvider, SecondBrain } from './telephony/index.js';
 *
 * The approval gate has two implementations of one interface: `PhoneApprover`
 * rings a human, `EvidenceApprover` runs a check. Same loop, human optional.
 */

export * from './types.js';
export * from './constraints.js';
export * from './extract.js';
export * from './brain.js';
export * from './hotline.js';
export * from './call-agent.js';
export * from './approver.js';
export { SimulationProvider } from './providers/simulation.js';
export type { ScriptedPeer, SimulationOptions } from './providers/simulation.js';
export { RetellProvider } from './providers/retell.js';
export { TwilioProvider } from './providers/twilio.js';
export { GoogleVoiceProvider, GOOGLE_VOICE_SMS, GOOGLE_VOICE_HANDOFF, smsSpeaker } from './providers/google-voice.js';
export type { GoogleVoiceDriver, GoogleVoiceOptions } from './providers/google-voice.js';
export { MacNativeProvider, MAC_SMS, MAC_HANDOFF, buildSendScript, osaEscape } from './providers/macos.js';
export { resolveProvider, NoProviderError, speakerModality } from './providers/resolve.js';
export type { ResolveOptions, Resolution } from './providers/resolve.js';
