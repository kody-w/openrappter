/**
 * `openrappter twin` — build and inspect your digital twin.
 *
 * Everything here writes to the device vault and nothing here sends anything
 * anywhere. The one command that produces shareable output (`shape`) emits
 * counts, never values, and `soul --audience public` exists so you can read
 * exactly what a stranger would get before you ever expose it.
 */

import chalk from 'chalk';
import type { Command } from 'commander';

import { TwinVault, toShape } from './vault.js';
import { DEFAULT_HUB, httpLoader, inherit, resolveArchetype } from './archetype.js';
import { renderPublicSoul, renderSoul } from './soul.js';
import type { TwinProfile } from './types.js';

const BRAIN = '🧠';

function vaultFrom(options: { home?: string }): TwinVault {
  return new TwinVault({ dir: options.home });
}

/** Commander nests options on the parent command; this keeps that noise in one place. */
function vaultFor(command: { parent?: { opts(): { home?: string } } }): TwinVault {
  return vaultFrom(command.parent?.opts() ?? {});
}

/** Vault errors are user-facing guidance, not stack traces. */
function guard(action: () => void | Promise<void>) {
  return async () => {
    try {
      await action();
    } catch (error) {
      console.error(chalk.red(`\n  ${(error as Error).message}\n`));
      process.exit(1);
    }
  };
}

function summarise(profile: TwinProfile): string {
  const lines = [
    `${BRAIN} ${chalk.bold(profile.identity.name)}${profile.identity.shortName ? chalk.dim(` (${profile.identity.shortName})`) : ''}`,
  ];

  for (const role of profile.roles) {
    lines.push(chalk.dim(`   ${role.title}${role.org ? ` at ${role.org}` : ''}`));
  }

  const counts = [
    ['voice', profile.voice.tone.length + profile.voice.avoid.length + profile.voice.signatures.length],
    ['projects', profile.context.projects.length],
    ['people', profile.context.people.length],
    ['facts', profile.context.facts.length],
    ['accounts', Object.keys(profile.accounts).length],
  ] as const;

  lines.push('');
  for (const [label, count] of counts) {
    const marker = count > 0 ? chalk.green('●') : chalk.dim('○');
    lines.push(`   ${marker} ${label.padEnd(9)} ${count > 0 ? count : chalk.dim('none yet')}`);
  }

  return lines.join('\n');
}

/** Turn repeated `--x a --x b` flags into a list, tolerating commas. */
function list(value: string[] | undefined): string[] {
  return (value ?? []).flatMap((entry) => entry.split(',').map((part) => part.trim())).filter(Boolean);
}

export function registerTwinCommands(program: Command): void {
  const twin = program
    .command('twin')
    .description('Your digital twin — local-first, never leaves this machine')
    .option('--home <dir>', 'vault directory (default ~/.rapp/twin, or $RAPP_TWIN_HOME)');

  twin
    .command('init')
    .description('Create your twin')
    .argument('<name>', 'your name')
    .action(async (name: string, _options, command) =>
      guard(() => {
        const vault = vaultFor(command);

        if (vault.exists()) {
          console.log(chalk.yellow(`\n  A twin already exists at ${vault.dir}`));
          console.log(chalk.dim('  Use `openrappter twin set` to edit it.\n'));
          return;
        }

        const profile = vault.init(name);

        console.log(`\n${BRAIN} Created your twin at ${chalk.bold(vault.dir)}`);
        console.log(chalk.dim('   Owner-only permissions. Outside every git repo, on purpose.\n'));
        console.log('   It knows your name and nothing else yet. Teach it:\n');
        console.log(chalk.dim('     openrappter twin set voice --tone direct --tone dry'));
        console.log(chalk.dim('     openrappter twin set role --title Founder --org "Your Co"'));
        console.log(chalk.dim('     openrappter twin add project --name X --what "what it is"'));
        console.log(chalk.dim('     openrappter twin add fact "I prefer evening meetings"'));
        console.log(chalk.dim(`\n   Then: openrappter twin soul   (id ${profile.id})\n`));
      })(),
    );

  twin
    .command('show')
    .description('What your twin knows')
    .option('--json', 'raw profile (contains personal details)')
    .action(async (options, command) => {
      const vault = vaultFor(command);
      try {
        const profile = vault.load();
        if (options.json) {
          console.log(JSON.stringify(profile, null, 2));
          return;
        }
        console.log(`\n${summarise(profile)}`);
        console.log(chalk.dim(`\n   ${vault.dir}${vault.isPrivate() ? '' : chalk.red('  (permissions are too open!)')}\n`));
      } catch (error) {
        console.error(chalk.red(`\n  ${(error as Error).message}\n`));
        process.exit(1);
      }
    });

  /**
   * Speak to a peer. #100.
   *
   * Until this existed a rappter could be spoken to as a twin and could not
   * speak — every member of the neighborhood could listen and none could
   * initiate. The peer is addressed by base URL because that is what a twin on
   * this device actually is: another instance on another port.
   */
  twin
    .command('say')
    .description('Say something to another rappter, brainstem or person over /twin')
    .option('--to <url>', 'peer base URL, e.g. http://127.0.0.1:19901')
    .option('--to-instance <name>', 'a hatched twin on THIS device, addressed by name')
    .requiredOption('--text <text>', 'what to say')
    .option('--owner <owner>', 'owner handle for this device\'s rappid', 'kody-w')
    .option('--as <slug>', 'which rappter is speaking', 'alpha')
    .option('--to-slug <slug>', 'the peer\'s slug, for its rappid', 'peer')
    .action(async (opts: {
      to?: string; toInstance?: string; text: string; owner: string; as: string; toSlug: string;
    }) => {
      const { deviceRappid, sendTwin } = await import('./send.js');
      const { urlForInstance } = await import('../infra/roster.js');
      const { canonicalInstanceKey } = await import('../infra/gateway-lock.js');

      if (!opts.to && !opts.toInstance) {
        console.error('\n  Say it to whom? Pass --to <url> for any peer, or --to-instance <name> for a twin on this device.\n');
        process.exitCode = 1;
        return;
      }

      // Resolved the same way `openrappter twins` resolves it: the address the
      // twin RECORDED, falling back to the one its name implies. Deriving here
      // instead meant a twin hatched with an explicit --port could be SEEN by
      // name and not SPOKEN to by name — `twins` found archivist on :19950
      // while this tried :19591 and failed. #107
      const url = opts.to ?? urlForInstance(opts.toInstance);
      if (!url) {
        // A twin with no endpoint record never owned a port, so there is no
        // address to send to. Deriving one here is what let a message addressed
        // to `thicket` be answered by `tender` on the port they share, with the
        // reply attributed to `thicket`. Refusing is the only honest option:
        // the alternative is quietly talking to someone else. #114
        console.error(
          `\n  No rappter named "${opts.toInstance}" has ever started on this device.`,
        );
        console.error('  Check `openrappter twins`, or address a peer directly with --to <url>.\n');
        process.exitCode = 1;
        return;
      }
      // When a peer is named, that name IS its slug; defaulting to "peer" would
      // address a twin by a rappid it does not answer to. Canonicalised so the
      // rappid matches the name the twin knows itself by. #111
      const peerSlug = opts.to
        ? opts.toSlug
        : canonicalInstanceKey(opts.toInstance!);

      const from = deviceRappid(opts.owner, opts.as);
      const to = deviceRappid(opts.owner, peerSlug);
      console.log(`\n  ${opts.as} → ${opts.toInstance ?? opts.to}`);
      try {
        const out = await sendTwin({ to: url, fromRappid: from, toRappid: to, text: opts.text });
        if (out.status === 200 && out.said) {
          console.log(`  ${peerSlug}: ${out.said}\n`);
        } else {
          // Never print a reply that was not one. A refusal is information.
          console.log(`  peer answered ${out.status}: ${JSON.stringify(out.body).slice(0, 300)}\n`);
          process.exitCode = 1;
        }
      } catch (e) {
        console.log(`  could not reach ${url}: ${(e as Error).message}\n`);
        process.exitCode = 1;
      }
    });

  const set = twin.command('set').description('Set part of your twin');

  set
    .command('identity')
    .option('--name <name>')
    .option('--short-name <name>', 'what it should call you')
    .option('--pronouns <pronouns>')
    .option('--timezone <tz>')
    .action(async (options, command) => {
      const vault = vaultFor(command.parent!);
      const profile = vault.load();

      if (options.name) profile.identity.name = options.name;
      if (options.shortName) profile.identity.shortName = options.shortName;
      if (options.pronouns) profile.identity.pronouns = options.pronouns;
      if (options.timezone) profile.identity.timezone = options.timezone;

      vault.save(profile);
      console.log(chalk.green(`\n  Updated identity.\n`));
    });

  set
    .command('voice')
    .description('How you sound')
    .option('--tone <word...>', 'e.g. direct, dry, concise')
    .option('--avoid <habit...>', 'e.g. hedging, corporate filler')
    .option('--signature <phrase...>', 'turns of phrase that are recognisably you')
    .option('--replace', 'replace instead of appending')
    .action(async (options, command) => {
      const vault = vaultFor(command.parent!);
      const profile = vault.load();

      const merge = (existing: string[], incoming: string[]) =>
        options.replace ? incoming : [...new Set([...existing, ...incoming])];

      if (options.tone) profile.voice.tone = merge(profile.voice.tone, list(options.tone));
      if (options.avoid) profile.voice.avoid = merge(profile.voice.avoid, list(options.avoid));
      if (options.signature) profile.voice.signatures = merge(profile.voice.signatures, list(options.signature));

      vault.save(profile);
      console.log(chalk.green(`\n  Voice: ${profile.voice.tone.join(', ') || '(none)'}\n`));
    });

  set
    .command('role')
    .option('--title <title>', 'required')
    .option('--org <org>')
    .option('--focus <focus>', 'what you actually spend time on')
    .action(async (options, command) => {
      if (!options.title) {
        console.error(chalk.red('\n  --title is required\n'));
        process.exit(1);
      }
      const vault = vaultFor(command.parent!);
      const profile = vault.load();
      profile.roles.push({ title: options.title, org: options.org, focus: options.focus });
      vault.save(profile);
      console.log(chalk.green(`\n  Added role: ${options.title}\n`));
    });

  set
    .command('account')
    .description('A handle or address the twin may USE but never mention')
    .argument('<key>', 'e.g. email, phone, github')
    .argument('<value>')
    .action(async (key: string, value: string, _options, command) => {
      const vault = vaultFor(command.parent!);
      const profile = vault.load();
      profile.accounts[key] = value;
      vault.save(profile);
      // Never echo the value back — terminals scroll into screenshots.
      console.log(chalk.green(`\n  Stored ${key}.`));
      console.log(chalk.dim('  Accounts are never placed in the prompt or any export.\n'));
    });

  const add = twin.command('add').description('Add to your twin');

  add
    .command('project')
    .option('--name <name>', 'required')
    .option('--what <what>', 'required')
    .option('--where <where>', 'repo, folder or URL')
    .action(async (options, command) => {
      if (!options.name || !options.what) {
        console.error(chalk.red('\n  --name and --what are required\n'));
        process.exit(1);
      }
      const vault = vaultFor(command.parent!);
      const profile = vault.load();
      const entry = { name: options.name, what: options.what, where: options.where };
      // Re-running a command should correct the entry, not duplicate it — a
      // twin that says the same thing twice reads as broken in the prompt.
      const existing = profile.context.projects.findIndex(
        (p) => p.name.toLowerCase() === options.name.toLowerCase(),
      );
      const updated = existing >= 0;
      if (updated) profile.context.projects[existing] = entry;
      else profile.context.projects.push(entry);
      vault.save(profile);
      console.log(chalk.green(`\n  ${updated ? 'Updated' : 'Added'} project: ${options.name}\n`));
    });

  add
    .command('person')
    .option('--name <name>', 'required')
    .option('--relationship <rel>', 'required')
    .option('--notes <notes>')
    .action(async (options, command) => {
      if (!options.name || !options.relationship) {
        console.error(chalk.red('\n  --name and --relationship are required\n'));
        process.exit(1);
      }
      const vault = vaultFor(command.parent!);
      const profile = vault.load();
      const entry = { name: options.name, relationship: options.relationship, notes: options.notes };
      const existing = profile.context.people.findIndex(
        (p) => p.name.toLowerCase() === options.name.toLowerCase(),
      );
      const updated = existing >= 0;
      if (updated) profile.context.people[existing] = entry;
      else profile.context.people.push(entry);
      vault.save(profile);
      console.log(chalk.green(`\n  ${updated ? 'Updated' : 'Added'} person: ${options.name}`));
      console.log(chalk.dim('  People are shared with you only — never with anyone else.\n'));
    });

  add
    .command('fact')
    .description('Something the twin should never have to be told twice')
    .argument('<text>')
    .action(async (text: string, _options, command) => {
      const vault = vaultFor(command.parent!);
      const profile = vault.load();
      if (profile.context.facts.some((f) => f.toLowerCase() === text.toLowerCase())) {
        console.log(chalk.dim('\n  Already knew that.\n'));
        return;
      }
      profile.context.facts.push(text);
      vault.save(profile);
      console.log(chalk.green(`\n  Remembered.\n`));
    });

  add
    .command('boundary')
    .description('What the twin may do, must ask about, or must never do')
    .argument('<kind>', 'may | ask | never')
    .argument('<text>')
    .action(async (kind: string, text: string, _options, command) => {
      const vault = vaultFor(command.parent!);
      const profile = vault.load();

      const bucket = { may: 'mayDo', ask: 'mustAsk', never: 'neverDo' }[kind] as
        | 'mayDo'
        | 'mustAsk'
        | 'neverDo'
        | undefined;

      if (!bucket) {
        console.error(chalk.red('\n  kind must be one of: may, ask, never\n'));
        process.exit(1);
      }

      profile.boundaries[bucket].push(text);
      vault.save(profile);
      console.log(chalk.green(`\n  Added to "${kind}".\n`));
    });

  twin
    .command('soul')
    .description('The persona your twin actually runs with')
    .option('-a, --audience <who>', 'owner | trusted | public', 'owner')
    .action(async (options, command) => {
      const vault = vaultFor(command);
      if (!vault.exists()) {
        console.log(renderPublicSoul());
        return;
      }

      const audience = options.audience as 'owner' | 'trusted' | 'public';
      if (audience !== 'owner') {
        // The point of this command is to let you verify the boundary yourself.
        console.log(chalk.dim(`# what a ${audience} audience sees\n`));
      }
      console.log(renderSoul(vault.load(), { audience }));
    });

  twin
    .command('shape')
    .description('The only safe thing to share: counts, never values')
    .action(async (_options, command) => {
      const vault = vaultFor(command);
      console.log(JSON.stringify(toShape(vault.load()), null, 2));
    });

  twin
    .command('inherit')
    .description('Adopt an archetype from the twin hub — how a twin behaves, never who it is')
    .argument('[id]', 'archetype id, e.g. base, founder, engineer, operator')
    .option('--hub <url>', 'archetype hub', DEFAULT_HUB)
    .option('--dry-run', 'show what would change without writing')
    .option('--json', 'machine-readable')
    .action(async (id: string | undefined, options, command) => {
      // `inherit` is a direct child of `twin`, like init/show — so the shared
      // --home option lives one level up from *this* command, not two.
      const vault = vaultFor(command);

      if (!id) {
        console.log(`\n  Archetypes live at ${options.hub}\n`);
        console.log('    base      honest about being an AI, and unable to commit you to anything');
        console.log('    founder   runs a small company and answers for it');
        console.log('    engineer  reasons from the code that exists');
        console.log('    operator  schedules, suppliers, quotes and follow-ups\n');
        console.log(chalk.dim('    openrappter twin inherit founder\n'));
        return;
      }

      try {
        const resolved = await resolveArchetype(id, httpLoader(options.hub));
        const result = inherit(vault.load(), resolved);

        if (options.dryRun) {
          console.log(JSON.stringify({ lineage: result.lineage, changed: result.changed, counts: result.counts }, null, 2));
          return;
        }

        vault.save(result.profile);

        if (options.json) {
          console.log(JSON.stringify({ lineage: result.lineage, changed: result.changed, counts: result.counts }, null, 2));
          return;
        }

        console.log(`\n  ${result.changed ? 'Inherited' : 'Already had'} ${chalk.bold(result.lineage.join(' → '))}`);
        console.log(chalk.dim(`  voice ${JSON.stringify(result.counts.voice)}`));
        console.log(chalk.dim(`  boundaries ${JSON.stringify(result.counts.boundaries)}`));
        console.log(chalk.dim('\n  Added to your twin. Your name, people and accounts were not touched.'));
        console.log(chalk.dim('  Nothing left this machine.\n'));
      } catch (error) {
        console.error(chalk.red(`\n  ${(error as Error).message}\n`));
        process.exit(1);
      }
    });

  twin
    .command('where')
    .description('Where your twin lives, and whether it is safe there')
    .action(async (_options, command) => {
      const vault = vaultFor(command);
      console.log(`\n  ${vault.dir}`);
      console.log(`  exists:  ${vault.exists() ? chalk.green('yes') : chalk.dim('not yet')}`);

      if (vault.exists()) {
        console.log(`  private: ${vault.isPrivate() ? chalk.green('yes (0600)') : chalk.red('NO — fix with chmod 600')}`);
      }

      try {
        vault.assertSafeLocation();
        console.log(`  in a repo: ${chalk.green('no')}\n`);
      } catch {
        console.log(`  in a repo: ${chalk.red('YES — this is unsafe')}\n`);
      }
    });
}
