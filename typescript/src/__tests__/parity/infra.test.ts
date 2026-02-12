import { describe, it, expect, vi, afterEach } from 'vitest';
import { withRetry } from '../../infra/retry.js';
import { HeartbeatService } from '../../infra/heartbeat.js';
import { SystemEventBus } from '../../infra/system-events.js';
import { UsageTracker } from '../../infra/provider-usage.js';
import { validateUrlForSSRF } from '../../infra/ssrf.js';
import { getSystemInfo } from '../../infra/os-info.js';

describe('Retry', () => {
  it('should succeed on first try', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await withRetry(fn, { maxRetries: 3, baseDelay: 10 });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure then succeed', async () => {
    let attempt = 0;
    const result = await withRetry(
      async () => {
        attempt++;
        if (attempt < 3) throw new Error('fail');
        return 'ok';
      },
      { maxRetries: 3, baseDelay: 10 }
    );
    expect(result).toBe('ok');
    expect(attempt).toBe(3);
  });

  it('should throw after max retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    await expect(
      withRetry(fn, { maxRetries: 1, baseDelay: 10 })
    ).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(2); // initial + 1 retry
  });
});

describe('Heartbeat', () => {
  let heartbeat: HeartbeatService;

  afterEach(() => {
    if (heartbeat && heartbeat.isRunning()) {
      heartbeat.stop();
    }
  });

  it('should not be running initially', () => {
    heartbeat = new HeartbeatService();
    expect(heartbeat.isRunning()).toBe(false);
  });

  it('should start and stop', () => {
    heartbeat = new HeartbeatService();
    const callback = vi.fn();

    heartbeat.start(100, callback);
    expect(heartbeat.isRunning()).toBe(true);

    heartbeat.stop();
    expect(heartbeat.isRunning()).toBe(false);
  });
});

describe('System Events', () => {
  it('should emit and receive events', () => {
    const bus = new SystemEventBus();
    let received = false;

    bus.on('error', () => {
      received = true;
    });

    bus.emit('error', { message: 'test' });
    expect(received).toBe(true);
  });

  it('should support typed events', () => {
    const bus = new SystemEventBus();
    const events: string[] = [];

    // Test various event types
    bus.on('agent:start', () => events.push('agent:start'));
    bus.on('agent:end', () => events.push('agent:end'));
    bus.on('message:in', () => events.push('message:in'));
    bus.on('message:out', () => events.push('message:out'));
    bus.on('error', () => events.push('error'));
    bus.on('config:change', () => events.push('config:change'));

    bus.emit('agent:start', { agentName: 'test' });
    bus.emit('agent:end', { agentName: 'test' });
    bus.emit('message:in', { channel: 'test' });
    bus.emit('message:out', { channel: 'test' });
    bus.emit('error', { message: 'test' });
    bus.emit('config:change', {});

    expect(events).toEqual([
      'agent:start',
      'agent:end',
      'message:in',
      'message:out',
      'error',
      'config:change',
    ]);
  });
});

describe('Usage Tracker', () => {
  it('should record and get totals', () => {
    const tracker = new UsageTracker();

    tracker.record({
      provider: 'anthropic',
      model: 'claude-3-opus',
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.015,
      timestamp: Date.now(),
    });

    tracker.record({
      provider: 'anthropic',
      model: 'claude-3-opus',
      inputTokens: 200,
      outputTokens: 100,
      cost: 0.03,
      timestamp: Date.now(),
    });

    const totals = tracker.getTotal();
    expect(totals.inputTokens).toBe(300);
    expect(totals.outputTokens).toBe(150);
    expect(totals.totalCost).toBeCloseTo(0.045);
    expect(totals.count).toBe(2);
  });

  it('should get by provider', () => {
    const tracker = new UsageTracker();

    tracker.record({
      provider: 'anthropic',
      model: 'claude-3-opus',
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.015,
      timestamp: Date.now(),
    });

    tracker.record({
      provider: 'openai',
      model: 'gpt-4',
      inputTokens: 200,
      outputTokens: 100,
      cost: 0.06,
      timestamp: Date.now(),
    });

    const byProvider = tracker.getByProvider();
    expect(byProvider).toHaveProperty('anthropic');
    expect(byProvider).toHaveProperty('openai');
    expect(byProvider.anthropic.inputTokens).toBe(100);
    expect(byProvider.openai.inputTokens).toBe(200);
  });

  it('should get cost breakdown', () => {
    const tracker = new UsageTracker();

    tracker.record({
      provider: 'openai',
      model: 'gpt-4',
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.06,
      timestamp: Date.now(),
    });

    tracker.record({
      provider: 'anthropic',
      model: 'claude-3-opus',
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.015,
      timestamp: Date.now(),
    });

    const breakdown = tracker.getCostBreakdown();
    expect(breakdown).toHaveLength(2);
    // Should be sorted by cost desc
    expect(breakdown[0].cost).toBeGreaterThan(breakdown[1].cost);
    expect(breakdown[0].provider).toBe('openai');
    expect(breakdown[1].provider).toBe('anthropic');
  });

  it('should filter by since', () => {
    const tracker = new UsageTracker();
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;

    tracker.record({
      provider: 'anthropic',
      model: 'claude-3-opus',
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.015,
      timestamp: oneHourAgo,
    });

    tracker.record({
      provider: 'anthropic',
      model: 'claude-3-opus',
      inputTokens: 200,
      outputTokens: 100,
      cost: 0.03,
      timestamp: now,
    });

    // Get only entries from last 30 minutes
    const thirtyMinutesAgo = now - 30 * 60 * 1000;
    const totals = tracker.getTotal(thirtyMinutesAgo);
    expect(totals.inputTokens).toBe(200); // Only the recent entry
    expect(totals.totalCost).toBeCloseTo(0.03);
  });
});

describe('SSRF Validation', () => {
  it('should allow public URLs', () => {
    const result = validateUrlForSSRF('https://example.com');
    expect(result.safe).toBe(true);
  });

  it('should block localhost', () => {
    const result = validateUrlForSSRF('http://localhost:8080');
    expect(result.safe).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('should block private IPs', () => {
    const privateIPs = [
      'http://127.0.0.1',
      'http://10.0.0.1',
      'http://192.168.1.1',
      'http://172.16.0.1',
    ];

    for (const url of privateIPs) {
      const result = validateUrlForSSRF(url);
      expect(result.safe).toBe(false);
      expect(result.reason).toBeDefined();
    }
  });

  it('should block file:// protocol', () => {
    const result = validateUrlForSSRF('file:///etc/passwd');
    expect(result.safe).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('should block .local domains', () => {
    const result = validateUrlForSSRF('http://myhost.local');
    expect(result.safe).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('should return reason for blocked URLs', () => {
    const result = validateUrlForSSRF('http://localhost');
    expect(result.safe).toBe(false);
    expect(typeof result.reason).toBe('string');
    expect(result.reason!.length).toBeGreaterThan(0);
  });
});

describe('OS Info', () => {
  it('should return system info with all fields', () => {
    const info = getSystemInfo();

    // Check all fields are defined
    expect(info.platform).toBeDefined();
    expect(info.arch).toBeDefined();
    expect(info.nodeVersion).toBeDefined();
    expect(info.hostname).toBeDefined();
    expect(info.cpus).toBeDefined();
    expect(info.memoryMb).toBeDefined();
    expect(info.uptime).toBeDefined();

    // Check correct types
    expect(typeof info.platform).toBe('string');
    expect(typeof info.arch).toBe('string');
    expect(typeof info.nodeVersion).toBe('string');
    expect(typeof info.hostname).toBe('string');
    expect(typeof info.cpus).toBe('number');
    expect(typeof info.memoryMb).toBe('number');
    expect(typeof info.uptime).toBe('number');

    // Check reasonable values
    expect(info.cpus).toBeGreaterThan(0);
    expect(info.memoryMb).toBeGreaterThan(0);
    expect(info.uptime).toBeGreaterThanOrEqual(0);
  });
});
