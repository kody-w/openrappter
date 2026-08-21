import { writeFile } from 'node:fs/promises';

import { buildRappidCardVectorDocument } from '../dist/rappid-card/index.js';

const output = new URL('../../tests/rappid-card-vectors.json', import.meta.url);
const vectors = await buildRappidCardVectorDocument();
await writeFile(output, `${JSON.stringify(vectors, null, 2)}\n`, 'utf8');
console.log(`wrote ${vectors.fixtures.length} RAPPID card vectors to ${output.pathname}`);
