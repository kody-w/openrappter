#!/usr/bin/env node

if (process.argv[2] === 'clever-girl') {
  const { runCleverGirlCli } = await import('./clever-girl.mjs');
  process.exitCode = await runCleverGirlCli(process.argv.slice(3));
} else {
  const [
    { fileURLToPath, pathToFileURL },
    { dirname, join },
    { spawn },
    { existsSync },
  ] = await Promise.all([
    import('node:url'),
    import('node:path'),
    import('node:child_process'),
    import('node:fs'),
  ]);
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const distPath = join(__dirname, '..', 'dist', 'index.js');
  const srcPath = join(__dirname, '..', 'src', 'index.ts');

  if (existsSync(distPath)) {
    await import(pathToFileURL(distPath).href);
  } else if (existsSync(srcPath)) {
    const tsx = spawn('npx', ['tsx', srcPath, ...process.argv.slice(2)], {
      stdio: 'inherit',
      cwd: join(__dirname, '..'),
    });
    tsx.on("exit", (code) => process.exit(code ?? 0));
  } else {
    console.error('Error: Could not find openrappter source files');
    process.exit(1);
  }
}
