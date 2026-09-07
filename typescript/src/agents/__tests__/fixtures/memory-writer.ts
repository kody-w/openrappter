import fs from 'node:fs';
import path from 'node:path';
import { MemoryAgent } from '../../MemoryAgent.js';
import { withMemoryTransaction } from '../../../memory/json-store.js';

const [directory, mode, prefix = 'child', count = '1'] = process.argv.slice(2);
const report = (value: unknown) => fs.writeSync(1, `${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
const agent = new MemoryAgent(directory);
report('ready');
await new Promise<void>(resolve => {
  process.stdin.once('data', () => resolve());
});
report('attempting');

if (mode === 'hold') {
  await withMemoryTransaction(path.join(directory, 'memory.json'), () => {
    report('locked');
    pause();
  });
} else {
  const rename = fs.renameSync;
  if (mode === 'before-replace' || mode === 'after-replace') {
    fs.renameSync = (source, target) => {
      if (mode === 'before-replace') {
        report(mode);
        pause();
      }
      rename(source, target);
      if (mode === 'after-replace') {
        report(mode);
        pause();
      }
    };
  }
  const results = [];
  for (let index = 0; index < Number(count); index++) {
    results.push(JSON.parse(await agent.perform({ action: 'remember', message: `${prefix}-${index}` })));
  }
  report(results);
  if (mode === 'acknowledged') pause();
}
