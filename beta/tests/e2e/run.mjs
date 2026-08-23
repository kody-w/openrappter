// `node --test tests/e2e` resolves this package entrypoint; the filename avoids
// default `npm test` discovery, which already finds the six *.e2e.test.mjs files.
import "./ambient-self-report.e2e.test.mjs";
import "./boot.e2e.test.mjs";
import "./dimension-tiles.e2e.test.mjs";
import "./lineage-words.e2e.test.mjs";
import "./store-hatch.e2e.test.mjs";
import "./surgeon-concurrent.e2e.test.mjs";
