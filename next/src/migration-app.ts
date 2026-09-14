#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJson, sha256 } from './canonical.js';
import { fixtureSigners } from './fixtures.js';
import { migrationPlan } from './migration-contract.js';
import { openMigrationService } from './migration-bootstrap.js';
import { MigrationEndpoint, serveMigration } from './migration-endpoint.js';
import { BoundedWriter } from './bounded-stdio.js';
import { publicError, Refusal, requireThat } from './errors.js';

async function main(args: string[]): Promise<void> {
  let directory: string | undefined, manifest: string | undefined, approval: string | undefined, interruptRoot: string | undefined;
  let fixture = false;
  if (args.includes('--help')) {
    console.log('NEW RAPP Work greenfield migration application\nnode next/dist/migration-app.js --fixture --store <empty-isolated-profile> --manifest <approved-plan> --approval <signed-approval>\nRAPP_WORK_MIGRATION_CAPABILITY is supplied through protected environment.\nControlled-local execution is available only to a trusted host that injects registry, signer and domain/closure/Hive authority through openMigrationService; this CLI accepts fixture authority only.');
    return;
  }
  while (args.length) {
    const flag = args.shift();
    if (flag === '--fixture') fixture = true;
    else if (flag === '--store') directory = args.shift();
    else if (flag === '--manifest') manifest = args.shift();
    else if (flag === '--approval') approval = args.shift();
    else if (flag === '--fixture-interrupt-root') interruptRoot = args.shift();
    else throw new Refusal('migration-cli', 'Unknown migration application option.');
  }
  requireThat(fixture, 'migration-adoption-unavailable', 'Live local migration requires final approval and adopted canonical domain/closure bindings. The fixture authority cannot authorize live profiles.');
  requireThat(directory && manifest && approval, 'migration-cli', 'Choose an isolated profile and the exact approved source manifest/approval.');
  const capability = process.env.RAPP_WORK_MIGRATION_CAPABILITY;
  requireThat(capability && /^[A-Za-z0-9_-]{43}$/u.test(capability), 'migration-unauthorized', 'The operator must supply an independent migration capability.');
  const plan = migrationPlan(parseJson(await readFile(manifest)));
  const approvalBytes = await readFile(approval, 'utf8');
  const keys = fixtureSigners(plan.roots.length);
  requireThat(interruptRoot === undefined || plan.roots.includes(interruptRoot), 'migration-fixture', 'Fault injection is limited to a selected fixture root.');
  let interrupted = false;
  const { service } = await openMigrationService({
    directory, plan, approvalBytes, authority: { registry: keys.registry, signers: keys.signers },
    capabilityHash: sha256(capability),
    ...(interruptRoot ? { migrationFault: (point: 'frame-materialized' | 'before-root-publish', root: string) => {
      if (!interrupted && point === 'frame-materialized' && root === interruptRoot) {
        interrupted = true;
        throw new Refusal('fixture-materialization-interrupted', 'Controlled fixture interruption after one unpublished canonical file; active roots remain unchanged.');
      }
    } } : {}),
  });
  const writer = new BoundedWriter(process.stdout);
  const endpoint = new MigrationEndpoint(service, capability, message => writer.send(message));
  console.error('NEW greenfield migration application: isolated fixture authority only; current profiles are untouched.');
  let stopping = false;
  const stop = (): void => { stopping = true; process.stdin.destroy(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try { await serveMigration(endpoint, process.stdin, writer); }
  catch (error) { if (!stopping) throw error; }
  finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify(publicError(error))); process.exitCode = 1; });
}
