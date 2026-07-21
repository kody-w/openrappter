#!/usr/bin/env node
/**
 * openrappter morning decisions → rapp-tower control tower.
 *
 * Runs each morning, asks the openrappter agent what decisions it wants Kody to
 * sign off on, and writes them (in rapp-tower's item shape) to
 * ~/.openrappter/tower-decisions.json. The tower console (tools/decisions.py,
 * http://localhost:7788) shows them as cards; a click queues the chosen action.
 *
 * Usage:  node morning-decisions.mjs
 * Env:    OPENRAPPTER_GATEWAY (default ws://127.0.0.1:18790)
 */

import { writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const GATEWAY = process.env.OPENRAPPTER_GATEWAY || 'ws://127.0.0.1:18790';
const OUT = join(homedir(), '.openrappter', 'tower-decisions.json');

const PROMPT = `You are openrappter, Kody's local AI agent. It's morning. Produce the short list of
decisions you want Kody to sign off on today — concrete actions you would take on his behalf
IF he approves. Only include things that genuinely need a human yes/no.

Respond with ONLY a JSON array (no prose, no code fence). Each element:
{
  "id": "kebab-case-unique",
  "title": "one-line what you want to do",
  "ctx": "one or two sentences of why / what's at stake",
  "opts": [
    {"label": "Do it", "rec": true, "action": "the exact instruction to execute if approved"},
    {"label": "Not now", "action": "what to do if declined"}
  ]
}
Return 1 to 4 items. If you truly have nothing that needs his sign-off, return [].`;

function extractJsonArray(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function seed() {
  // A real, safe fallback decision so the tower is never empty on a bad LLM day.
  return [{
    id: 'openrappter-daily-check',
    title: 'Confirm openrappter should keep watching your channels today',
    ctx: 'The agent is running and connected. Approve to let it keep monitoring and drafting replies for your sign-off; decline to have it stay quiet.',
    opts: [
      { label: 'Keep watching', rec: true, action: 'openrappter continues monitoring channels and queuing drafts for approval.' },
      { label: 'Stay quiet today', action: 'openrappter pauses proactive monitoring for the day.' },
    ],
  }];
}

function write(items) {
  mkdirSync(join(homedir(), '.openrappter'), { recursive: true });
  const payload = { source: 'openrappter', generatedAt: new Date().toISOString(), items };
  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${items.length} decision(s) → ${OUT}`);
}

async function ask() {
  return await new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { ws.close(); } catch {} resolve(v); } };
    const timer = setTimeout(() => done(null), 90_000);
    const ws = new WebSocket(GATEWAY);
    ws.addEventListener('open', () => ws.send(JSON.stringify({
      type: 'req', id: 'c', method: 'connect',
      params: { client: { id: 'morning-decisions', version: '1.0.0', platform: 'node', mode: 'local' } },
    })));
    ws.addEventListener('message', (ev) => {
      let f; try { f = JSON.parse(ev.data); } catch { return; }
      if (f.type === 'res' && f.id === 'c') {
        ws.send(JSON.stringify({ type: 'req', id: 'm', method: 'chat.send', params: { message: PROMPT, sessionKey: 'morning-decisions' } }));
      } else if (f.type === 'event' && f.event === 'chat') {
        const p = f.payload || {};
        if (p.state === 'final') { clearTimeout(timer); done(p.message?.content?.[0]?.text || ''); }
        else if (p.state === 'error') { clearTimeout(timer); done(null); }
      }
    });
    ws.addEventListener('error', () => done(null));
  });
}

const reply = await ask();
const parsed = reply ? extractJsonArray(reply) : null;
const items = Array.isArray(parsed) && parsed.every(i => i && i.id && i.opts) ? parsed : seed();
write(items);
