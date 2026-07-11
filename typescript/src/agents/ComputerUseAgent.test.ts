import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComputerUseAgent } from './ComputerUseAgent.js';

interface Invocation {
  file: string;
  args: string[];
}

class TestComputerUseAgent extends ComputerUseAgent {
  readonly invocations: Invocation[] = [];

  protected override async runFile(
    file: string,
    args: string[]
  ): Promise<{ stdout: string; stderr: string }> {
    this.invocations.push({ file, args });
    return { stdout: '', stderr: '' };
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ComputerUseAgent process execution', () => {
  it('passes typed text to osascript as one argument without a shell', async () => {
    const agent = new TestComputerUseAgent();
    const text = "hello'; touch /tmp/openrappter-injected; echo '";

    const result = JSON.parse(await agent.perform({ action: 'type', text }));

    expect(result.status).toBe('success');
    expect(agent.invocations).toEqual([
      {
        file: '/usr/bin/osascript',
        args: ['-e', expect.stringContaining(text)],
      },
    ]);
  });

  it('passes app names literally without command substitution', async () => {
    vi.useFakeTimers();
    const agent = new TestComputerUseAgent();
    const appName = '$(touch /tmp/openrappter-injected)Notes';

    const pending = agent.perform({ action: 'open_app', text: appName });
    await vi.runAllTimersAsync();
    const result = JSON.parse(await pending);

    expect(result.status).toBe('success');
    expect(agent.invocations).toEqual([
      {
        file: '/usr/bin/open',
        args: ['-a', appName],
      },
    ]);
  });

  it('keeps activation and element queries in a single AppleScript argument', async () => {
    const agent = new TestComputerUseAgent();
    const payload = 'value\\\\"\\ndo shell script \"touch /tmp/openrappter-injected\"\\n--';
    const escaped = payload.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    expect(JSON.parse(await agent.perform({ action: 'activate_app', text: payload })).status).toBe(
      'success'
    );
    expect(JSON.parse(await agent.perform({ action: 'find_element', text: payload })).status).toBe(
      'success'
    );

    expect(agent.invocations).toHaveLength(2);
    for (const invocation of agent.invocations) {
      expect(invocation.file).toBe('/usr/bin/osascript');
      expect(invocation.args).toHaveLength(2);
      expect(invocation.args[0]).toBe('-e');
      expect(invocation.args[1]).toContain(escaped);
    }
  });

  it('rejects non-numeric native inputs before compiling code', async () => {
    const agent = new TestComputerUseAgent();
    const payload = '0); system("touch /tmp/openrappter-injected"); //';

    const click = JSON.parse(await agent.perform({ action: 'click', x: payload, y: 1 }));
    const scroll = JSON.parse(
      await agent.perform({ action: 'scroll', direction: 'down', amount: payload })
    );
    const drag = JSON.parse(
      await agent.perform({ action: 'drag', x: 0, y: 0, end_x: payload, end_y: 1 })
    );

    expect(click.status).toBe('error');
    expect(scroll.status).toBe('error');
    expect(drag.status).toBe('error');
    expect(agent.invocations).toHaveLength(0);
  });

  it('compiles and runs native actions without a shell', async () => {
    const agent = new TestComputerUseAgent();

    const result = JSON.parse(await agent.perform({ action: 'click', x: 10, y: 20 }));

    expect(result.status).toBe('success');
    expect(agent.invocations[0]).toMatchObject({
      file: '/usr/bin/cc',
      args: expect.arrayContaining(['-framework', 'ApplicationServices']),
    });
    expect(agent.invocations[1]?.args).toEqual([]);
  });
});
