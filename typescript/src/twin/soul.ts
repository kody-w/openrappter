/**
 * Composing the twin's soul.
 *
 * This is where a profile on disk becomes the rappter's persona. Two rules
 * shape everything below:
 *
 *   The twin speaks AS you, to you. It does not speak as you, to the world.
 *
 *   Account handles and personal details are loaded so the twin can ACT, and
 *   are never placed in the prompt, because anything in the prompt is one
 *   clever question away from being repeated back.
 *
 * `renderSoul` builds the persona. `renderPublicSoul` is what a stranger gets:
 * the same machinery, none of the person.
 */

import type { TwinProfile } from './types.js';

export interface SoulOptions {
  /**
   * Who is on the other end.
   *
   * 'owner'    — you. Full context.
   * 'trusted'  — someone you have vouched for. Context, no accounts, no people.
   * 'public'   — anyone else. Shape only: the twin will not disclose details.
   */
  audience?: 'owner' | 'trusted' | 'public';
  /** Extra instructions appended after the persona. */
  extra?: string;
}

function bullets(items: string[], indent = '  '): string {
  return items.map((item) => `${indent}- ${item}`).join('\n');
}

function section(title: string, body: string): string {
  return body.trim() ? `${title}\n${body}` : '';
}

/**
 * The non-negotiable part of every twin prompt.
 *
 * Kept separate from the persona so it cannot be edited away by a profile:
 * a twin whose boundaries live in user-editable text is a twin with no
 * boundaries at all.
 */
export function disclosureRules(audience: 'owner' | 'trusted' | 'public'): string {
  const shared = [
    'You are an AI acting as this person\'s twin. If anyone asks, say so plainly. Never claim to be human.',
    'Never invent a fact about the owner. If you do not know, say you do not know and offer to ask them.',
    'You may act within "You may" below. Anything under "Ask first" needs their explicit yes before you do it, and a pending question is not a yes.',
  ];

  if (audience === 'owner') {
    return [
      ...shared,
      'You are talking to the owner, so speak freely about their own context.',
    ].join('\n');
  }

  if (audience === 'trusted') {
    return [
      ...shared,
      'You are talking to someone the owner trusts, but not the owner.',
      'Do not disclose contact details, account handles, addresses, phone numbers, or anything about third parties.',
      'Share project context only when it is plainly relevant to what was asked.',
    ].join('\n');
  }

  return [
    ...shared,
    'You are talking to a stranger. Assume everything you say may become public.',
    'Do not disclose ANY personal detail about the owner: no contact details, no account handles, no addresses, no phone numbers, no schedule, no relationships, no client or customer names.',
    'If asked for something personal, decline plainly and offer to pass the message on. Do not hint at what you are withholding.',
  ].join('\n');
}

/** The persona, from a profile. */
export function renderSoul(profile: TwinProfile, options: SoulOptions = {}): string {
  const audience = options.audience ?? 'owner';
  const { identity, voice, context, boundaries } = profile;
  const name = identity.name;
  const parts: string[] = [];

  parts.push(
    `You are ${name}'s digital twin — a rappter that thinks and writes the way ${identity.shortName ?? name} does.`,
  );

  const who: string[] = [];
  if (identity.pronouns) who.push(`Pronouns: ${identity.pronouns}`);
  if (identity.timezone) who.push(`Timezone: ${identity.timezone}`);
  for (const role of profile.roles) {
    // A stranger gets the job title and nothing that identifies an employer,
    // a client, or what the owner is actually doing. `org` and `focus` are
    // routinely a customer name.
    who.push(
      audience === 'public'
        ? role.title
        : `${role.title}${role.org ? ` at ${role.org}` : ''}${role.focus ? ` — ${role.focus}` : ''}`,
    );
  }
  if (who.length) parts.push(section('# Who they are', bullets(who)));

  const style: string[] = [];
  if (voice.tone.length) style.push(`Sound: ${voice.tone.join(', ')}.`);
  if (voice.avoid.length) style.push(`Never: ${voice.avoid.join(', ')}.`);
  if (voice.signatures.length) {
    style.push(`Recognisably them: ${voice.signatures.map((s) => `"${s}"`).join(', ')}.`);
  }
  if (style.length) parts.push(section('# How they sound', bullets(style)));

  // A stranger has no business knowing what the owner is working on or who
  // they know, so context is withheld entirely rather than summarised.
  if (audience !== 'public') {
    const working: string[] = [];
    for (const project of context.projects) {
      working.push(`${project.name} — ${project.what}${project.where ? ` (${project.where})` : ''}`);
    }
    if (context.tools.length) working.push(`Tools: ${context.tools.join(', ')}.`);
    if (working.length) parts.push(section('# What they are working on', bullets(working)));

    if (context.facts.length) parts.push(section('# Standing facts', bullets(context.facts)));

    if (audience === 'owner' && context.people.length) {
      const people = context.people.map((p) => `${p.name} — ${p.relationship}${p.notes ? `. ${p.notes}` : ''}`);
      parts.push(section('# People', bullets(people)));
    }
  }

  const mandate: string[] = [];
  if (boundaries.mayDo.length) mandate.push(`You may:\n${bullets(boundaries.mayDo, '    ')}`);
  if (boundaries.mustAsk.length) mandate.push(`Ask first:\n${bullets(boundaries.mustAsk, '    ')}`);
  if (boundaries.neverDo.length) mandate.push(`Never:\n${bullets(boundaries.neverDo, '    ')}`);
  if (mandate.length) parts.push(section('# Your mandate', bullets(mandate)));

  parts.push(section('# Always', disclosureRules(audience)));

  if (options.extra?.trim()) parts.push(options.extra.trim());

  return parts.filter(Boolean).join('\n\n');
}

/**
 * The soul for someone with no twin, and the fallback whenever a profile
 * cannot be loaded. Says what the twin *would* be, without being anyone.
 */
export function renderPublicSoul(): string {
  return [
    'You are a rappter — a local-first AI agent running on this person\'s own machine.',
    '',
    'You have no digital twin loaded, so you do not know whose machine this is.',
    'Do not guess, and do not invent a personality for them.',
    '',
    '# Always',
    disclosureRules('public'),
    '',
    'If they want you to become their twin, tell them: `openrappter twin init`.',
  ].join('\n');
}

/**
 * A compact block for injecting into another agent's system prompt, in the same
 * shape the Second Brain uses so a harness can treat them alike.
 */
export function renderTwinContext(profile: TwinProfile, audience: SoulOptions['audience'] = 'owner'): string {
  return ['<twin>', renderSoul(profile, { audience }), '</twin>'].join('\n');
}
