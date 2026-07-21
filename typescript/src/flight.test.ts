import { describe, expect, it } from 'vitest';
import { flightInfo, renderFlight } from './flight.js';

describe('flight ring detection', () => {
  it('reads a bare version as the stable production build', () => {
    const info = flightInfo('1.10.0');
    expect(info.ring).toBe('stable');
    expect(info.experimental).toBe(false);
    expect(info.baseVersion).toBe('1.10.0');
  });

  it('detects each pre-release ring from the version string', () => {
    expect(flightInfo('1.11.0-0.canary.a1b2c3d4').ring).toBe('canary');
    expect(flightInfo('1.11.0-1.nightly.20260721').ring).toBe('nightly');
    expect(flightInfo('1.11.0-2.alpha.1').ring).toBe('alpha');
    expect(flightInfo('1.11.0-3.beta.2').ring).toBe('beta');
  });

  it('marks pre-release rings experimental and carries the build detail', () => {
    const info = flightInfo('1.11.0-0.canary.a1b2c3d4');
    expect(info.experimental).toBe(true);
    expect(info.baseVersion).toBe('1.11.0');
    expect(info.detail).toBe('a1b2c3d4');
  });

  it('treats a rank that disagrees with the ring name as stable', () => {
    // 3.canary is not a build this train produced; do not trust the label.
    expect(flightInfo('1.11.0-3.canary.a1b2c3d4').ring).toBe('stable');
  });

  it('renders an experimental banner only for pre-release builds', () => {
    expect(renderFlight(flightInfo('1.11.0-0.canary.a1b2c3d4'))).toContain('experimental');
    expect(renderFlight(flightInfo('1.10.0'))).not.toContain('experimental');
  });
});
