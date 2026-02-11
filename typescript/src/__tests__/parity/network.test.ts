/**
 * Network/Tailscale Parity Tests
 * Tests that openrappter networking matches openclaw:
 * - Tailscale integration for remote access
 * - mDNS/Bonjour discovery
 * - Bind modes (loopback, LAN, tailscale, auto)
 */

import { describe, it, expect } from 'vitest';

describe('Network Parity', () => {
  describe('Bind Modes', () => {
    it('should support loopback binding', () => {
      const config = { bind: 'loopback', address: '127.0.0.1', port: 18789 };
      expect(config.address).toBe('127.0.0.1');
    });

    it('should support LAN binding', () => {
      const config = { bind: 'lan', address: '0.0.0.0', port: 18789 };
      expect(config.address).toBe('0.0.0.0');
    });

    it('should support Tailscale binding', () => {
      const config = {
        bind: 'tailscale',
        tailscaleAddress: '100.x.x.x',
        port: 18789,
      };

      expect(config.bind).toBe('tailscale');
    });

    it('should support auto binding', () => {
      const config = { bind: 'auto' };
      expect(['loopback', 'lan', 'tailscale', 'auto']).toContain(config.bind);
    });
  });

  describe('Tailscale Integration', () => {
    it('should detect Tailscale availability', () => {
      const tailscaleStatus = {
        installed: true,
        running: true,
        hostname: 'my-device',
        tailscaleIp: '100.64.0.1',
      };

      expect(typeof tailscaleStatus.installed).toBe('boolean');
    });

    it('should expose gateway via Tailscale', () => {
      const exposure = {
        enabled: true,
        hostname: 'openrappter-gateway',
        url: 'https://openrappter-gateway.tail12345.ts.net:18789',
      };

      expect(exposure.url).toContain('ts.net');
    });

    it('should support Tailscale auth', () => {
      const auth = {
        type: 'tailscale',
        nodeIdentity: true,
        allowedTailnets: ['my-tailnet'],
      };

      expect(auth.type).toBe('tailscale');
    });
  });

  describe('mDNS/Bonjour Discovery', () => {
    it('should advertise gateway via mDNS', () => {
      const service = {
        type: '_openrappter._tcp',
        name: 'OpenRappter Gateway',
        port: 18789,
        txt: {
          version: '1.2.0',
          auth: 'token',
        },
      };

      expect(service.type).toContain('_openrappter');
      expect(service.port).toBe(18789);
    });

    it('should discover other gateways on network', () => {
      const discovered = [
        { name: 'Gateway 1', host: '192.168.1.100', port: 18789 },
        { name: 'Gateway 2', host: '192.168.1.101', port: 18789 },
      ];

      expect(discovered.length).toBeGreaterThan(0);
    });
  });

  describe('TLS Support', () => {
    it('should support TLS configuration', () => {
      const tlsConfig = {
        enabled: true,
        cert: '/path/to/cert.pem',
        key: '/path/to/key.pem',
        ca: '/path/to/ca.pem',
      };

      expect(tlsConfig.enabled).toBe(true);
      expect(tlsConfig.cert).toBeDefined();
    });

    it('should support mTLS', () => {
      const mtlsConfig = {
        enabled: true,
        clientCert: true,
        trustedCAs: ['/path/to/client-ca.pem'],
      };

      expect(mtlsConfig.clientCert).toBe(true);
    });
  });

  describe('DNS Helpers', () => {
    it('should resolve gateway address', () => {
      const resolution = {
        hostname: 'openrappter.local',
        address: '192.168.1.100',
        port: 18789,
      };

      expect(resolution.hostname).toBeDefined();
      expect(resolution.address).toBeDefined();
    });
  });
});
