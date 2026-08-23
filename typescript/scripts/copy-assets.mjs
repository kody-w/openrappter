import { cpSync, copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist/agents/python', { recursive: true });
copyFileSync('src/agents/python/runner.py', 'dist/agents/python/runner.py');
mkdirSync('dist/voice', { recursive: true });
copyFileSync('src/voice/local-speech.js', 'dist/voice/local-speech.js');
mkdirSync('dist/rappid-card/test-vectors', { recursive: true });
cpSync(
  '../tests/vectors/rapp-1-2167c34/rappid-card',
  'dist/rappid-card/test-vectors',
  { recursive: true },
);
