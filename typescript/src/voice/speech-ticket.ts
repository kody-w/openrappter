import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

const MAX_TEXT_CHARACTERS = 5_000;
const MAX_TICKET_CHARACTERS = 12_000;
const RUN_ID_PATTERN = /^run_[A-Za-z0-9_-]{1,120}$/;

interface TicketPayload {
  v: 1;
  runId: string;
  text: string;
  exp: number;
}

export interface SpeechTicketInput {
  runId: string;
  text: string;
  key: string;
  now?: number;
  ttlMs?: number;
}

function sign(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

export function createSpeechTicket(input: SpeechTicketInput): string {
  if (!RUN_ID_PATTERN.test(input.runId)) throw new Error('Invalid speech run id.');
  const text = input.text.trim();
  if (!text || text.length > MAX_TEXT_CHARACTERS) {
    throw new Error('Speech text is empty or too long.');
  }
  if (input.key.length < 32 || input.key.length > 256) {
    throw new Error('Invalid speech ticket key.');
  }
  const payload: TicketPayload = {
    v: 1,
    runId: input.runId,
    text,
    exp: (input.now ?? Date.now()) + (input.ttlMs ?? 60_000),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${sign(encoded, input.key)}`;
}

export function verifySpeechTicket(
  ticket: string,
  key: string,
  now = Date.now(),
): { runId: string; text: string } {
  if (
    typeof ticket !== 'string'
    || ticket.length > MAX_TICKET_CHARACTERS
    || key.length < 32
  ) {
    throw new Error('Invalid speech ticket.');
  }
  const parts = ticket.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('Invalid speech ticket.');
  }
  const expected = Buffer.from(sign(parts[0], key), 'utf8');
  const actual = Buffer.from(parts[1], 'utf8');
  if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) {
    throw new Error('Invalid speech ticket.');
  }
  let payload: TicketPayload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as TicketPayload;
  } catch {
    throw new Error('Invalid speech ticket.');
  }
  if (
    payload.v !== 1
    || !RUN_ID_PATTERN.test(payload.runId)
    || typeof payload.text !== 'string'
    || !payload.text.trim()
    || payload.text.length > MAX_TEXT_CHARACTERS
  ) {
    throw new Error('Invalid speech ticket.');
  }
  if (!Number.isSafeInteger(payload.exp) || payload.exp < now) {
    throw new Error('Speech ticket expired.');
  }
  return { runId: payload.runId, text: payload.text };
}
