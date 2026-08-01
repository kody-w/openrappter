/**
 * Twilio provider.
 *
 * Twilio gives you the phone number and the media; the speaking and listening
 * are driven by TwiML. This adapter dials via the REST API and reads the other
 * party from a transcript source that the gateway feeds from Twilio's
 * `<Gather input="speech">` webhook, so the shape matches every other provider.
 *
 * Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER.
 */

import type { CallHandle, CallProvider, DialRequest } from '../types.js';

export interface TwilioOptions {
  accountSid?: string;
  authToken?: string;
  fromNumber?: string;
  /** Public URL of the openrappter gateway that serves TwiML for this call. */
  webhookBase?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  transcriptSource?: (callSid: string, timeoutMs: number) => Promise<string | null>;
  digitSource?: (callSid: string, timeoutMs: number) => Promise<string | null>;
  /** Queue a line for the gateway to render as TwiML `<Say>`. */
  saySink?: (callSid: string, text: string) => Promise<void> | void;
}

export class TwilioProvider implements CallProvider {
  readonly name = 'twilio';

  private readonly accountSid?: string;
  private readonly authToken?: string;
  private readonly fromNumber?: string;
  private readonly webhookBase?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly options: TwilioOptions;

  constructor(options: TwilioOptions = {}) {
    this.accountSid = options.accountSid ?? process.env.TWILIO_ACCOUNT_SID;
    this.authToken = options.authToken ?? process.env.TWILIO_AUTH_TOKEN;
    this.fromNumber = options.fromNumber ?? process.env.TWILIO_FROM_NUMBER;
    this.webhookBase = options.webhookBase ?? process.env.OPENRAPPTER_PUBLIC_URL;
    this.baseUrl = options.baseUrl ?? 'https://api.twilio.com';
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.options = options;
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.accountSid && this.authToken && this.fromNumber && this.fetchImpl);
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`;
  }

  async dial(request: DialRequest): Promise<CallHandle> {
    if (!this.accountSid || !this.authToken) throw new Error('Twilio credentials are not set');

    const form = new URLSearchParams({
      To: request.to,
      From: request.from ?? this.fromNumber ?? '',
      Url: `${this.webhookBase ?? ''}/telephony/twiml`,
      StatusCallback: `${this.webhookBase ?? ''}/telephony/status`,
    });

    const response = await this.fetchImpl(`${this.baseUrl}/2010-04-01/Accounts/${this.accountSid}/Calls.json`, {
      method: 'POST',
      headers: { Authorization: this.authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });

    if (!response.ok) throw new Error(`twilio dial failed: ${response.status} ${await response.text()}`);

    const payload = (await response.json()) as { sid?: string };
    const sid = payload.sid ?? `twilio_${Date.now()}`;
    return { id: sid, provider: this.name, to: request.to, direction: 'outbound', externalId: sid };
  }

  async say(handle: CallHandle, text: string): Promise<void> {
    if (!this.options.saySink) {
      throw new Error('TwilioProvider needs a saySink so the gateway can render TwiML <Say>');
    }
    await this.options.saySink(handle.externalId ?? handle.id, text);
  }

  async listen(handle: CallHandle, timeoutMs = 30_000): Promise<string | null> {
    if (!this.options.transcriptSource) {
      throw new Error('TwilioProvider needs a transcriptSource wired to the <Gather> webhook');
    }
    return this.options.transcriptSource(handle.externalId ?? handle.id, timeoutMs);
  }

  async readDigits(handle: CallHandle, count: number, timeoutMs = 20_000): Promise<string | null> {
    if (!this.options.digitSource) return null;
    const digits = await this.options.digitSource(handle.externalId ?? handle.id, timeoutMs);
    return digits ? digits.slice(0, count) : null;
  }

  async hangup(handle: CallHandle): Promise<void> {
    if (!this.accountSid) return;
    await this.fetchImpl(`${this.baseUrl}/2010-04-01/Accounts/${this.accountSid}/Calls/${handle.externalId ?? handle.id}.json`, {
      method: 'POST',
      headers: { Authorization: this.authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ Status: 'completed' }).toString(),
    });
  }
}

/** Escape text for inclusion in a TwiML document. */
export function twimlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Build the TwiML for one agent turn: speak, then listen. */
export function buildTwiml(options: { say?: string; gather?: 'speech' | 'dtmf'; numDigits?: number; action?: string }): string {
  const parts: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<Response>'];

  if (options.gather) {
    const attrs = [
      `input="${options.gather === 'dtmf' ? 'dtmf' : 'speech'}"`,
      options.numDigits ? `numDigits="${options.numDigits}"` : '',
      options.action ? `action="${twimlEscape(options.action)}"` : '',
      'speechTimeout="auto"',
    ]
      .filter(Boolean)
      .join(' ');
    parts.push(`<Gather ${attrs}>`);
    if (options.say) parts.push(`<Say>${twimlEscape(options.say)}</Say>`);
    parts.push('</Gather>');
  } else if (options.say) {
    parts.push(`<Say>${twimlEscape(options.say)}</Say>`);
  }

  parts.push('</Response>');
  return parts.join('');
}
