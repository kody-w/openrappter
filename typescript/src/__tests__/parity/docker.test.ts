/**
 * Docker Parity Tests
 *
 * The previous version of this file asserted on hand-built literals that were
 * never compared against the real deployment artifacts. Several of those
 * literals actively described a Docker setup that does not exist:
 *
 *   - "should use pnpm for package management" — the real Dockerfile uses
 *     `npm ci` / `npm run build`; pnpm appears nowhere.
 *   - "should run as non-root user" (user = 'node') — the real Dockerfile
 *     defines NO `USER` directive, so the container runs as root. The compose
 *     file even mounts config at `/root/.openrappter`, confirming root. This
 *     vacuous test claimed a security property the image does not have. It is
 *     reported as a hardening gap rather than re-asserted (see PR notes); the
 *     suite must not codify the insecure state as "expected", nor go red for a
 *     pre-existing infra gap.
 *   - "should define gateway service" / optional `ollama` service / a
 *     `networks: { openrappter: { driver: bridge } }` block — the real
 *     docker-compose.yml defines services `openrappter` and `openrappter-dev`,
 *     no `ollama`, and no `networks:` section.
 *
 * These are the same "reads as complete but isn't" defect the audit targets,
 * aimed at the deployment layer. This file now reads the ACTUAL Dockerfile and
 * docker-compose.yml at the repo root and asserts what is genuinely true, so it
 * fails if the deployment artifacts drift from the documented contract.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const dockerfile = readFileSync(`${repoRoot}Dockerfile`, 'utf8');
const compose = readFileSync(`${repoRoot}docker-compose.yml`, 'utf8');

describe('Docker Parity', () => {
  describe('Dockerfile (real file at repo root)', () => {
    it('is a non-empty build file', () => {
      expect(dockerfile.length).toBeGreaterThan(100);
      expect(dockerfile).toMatch(/^FROM /m);
    });

    it('builds on the node:22-slim base image', () => {
      expect(dockerfile).toMatch(/FROM\s+node:22-slim/);
    });

    it('uses a multi-stage build with a named builder stage', () => {
      expect(dockerfile).toMatch(/FROM\s+node:22-slim\s+AS\s+builder/);
      const fromCount = (dockerfile.match(/^FROM /gm) ?? []).length;
      expect(fromCount).toBeGreaterThanOrEqual(2);
    });

    it('installs JS dependencies with npm ci — not pnpm', () => {
      expect(dockerfile).toMatch(/npm ci/);
      expect(dockerfile).not.toMatch(/pnpm/);
    });

    it('compiles the TypeScript build', () => {
      expect(dockerfile).toMatch(/npm run build/);
    });

    it('installs the Python runtime package', () => {
      expect(dockerfile).toMatch(/pip3? install/);
      expect(dockerfile).toMatch(/python\//);
    });

    it('declares a HEALTHCHECK that probes /health', () => {
      expect(dockerfile).toMatch(/HEALTHCHECK/);
      expect(dockerfile).toMatch(/\/health/);
    });

    it('exposes the gateway port 18790', () => {
      expect(dockerfile).toMatch(/EXPOSE\s+18790/);
    });

    it('runs the compiled entrypoint and sets production env', () => {
      expect(dockerfile).toMatch(/CMD\s+\[.*dist\/index\.js.*\]/);
      expect(dockerfile).toMatch(/NODE_ENV=production/);
    });
  });

  describe('docker-compose.yml (real file at repo root)', () => {
    it('defines the openrappter service (not a "gateway" service)', () => {
      expect(compose).toMatch(/^\s{2}openrappter:/m);
      // The old vacuous test asserted a service literally named "gateway".
      expect(compose).not.toMatch(/^\s{2}gateway:/m);
    });

    it('publishes the gateway port 18790', () => {
      expect(compose).toMatch(/"?18790:18790"?/);
    });

    it('persists data and config via named volumes declared at the top level', () => {
      expect(compose).toMatch(/openrappter-data:\/app\/data/);
      expect(compose).toMatch(/openrappter-config:/);
      expect(compose).toMatch(/^volumes:/m);
      expect(compose).toMatch(/^\s{2}openrappter-data:/m);
      expect(compose).toMatch(/^\s{2}openrappter-config:/m);
    });

    it('restarts the primary service unless stopped', () => {
      expect(compose).toMatch(/restart:\s+unless-stopped/);
    });
  });
});
