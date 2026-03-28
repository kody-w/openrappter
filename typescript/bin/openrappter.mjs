#!/usr/bin/env node
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Check if running from source or installed
const distPath = join(__dirname, '..', 'dist', 'index.js');
const srcPath = join(__dirname, '..', 'src', 'index.ts');

if (existsSync(distPath)) {
  // Production: run compiled JS
  import(distPath);
} else if (existsSync(srcPath)) {
  // Development: use tsx
  const tsx = spawn('npx', ['tsx', srcPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: join(__dirname, '..'),
  });
  tsx.on('exit', (code) => process.exit(code ?? 0));
} else {
  console.error('Error: Could not find openrappter source files');
  process.exit(1);
}
