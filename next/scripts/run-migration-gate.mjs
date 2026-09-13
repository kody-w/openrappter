import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runObservedMigration } from '../test/migration-harness.mjs';
import { migrationReplayHtml } from './migration-replay.mjs';
import { verifyMigrationReplay } from './verify-migration-replay.mjs';

const run = await runObservedMigration();
const replay = path.join(run.base, 'migration-replay.html');
await writeFile(replay, migrationReplayHtml(run.evidence, run.record.displays));
const browser = await verifyMigrationReplay(replay, run.base, run.fixture.plan.expected);
const report = {
  ...run.evidence, replay: path.basename(replay), browser,
  fixtureReleaseGate: 'observed-migration-and-display-passed',
  liveReleaseGate: 'not-run; final integration approval and adopted live bindings required',
};
await writeFile(path.join(run.base, 'release-gate.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
