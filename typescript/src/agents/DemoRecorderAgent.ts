import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';
import { ComputerUseAgent } from './ComputerUseAgent.js';
import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync } from 'fs';
import { copyFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

function isSafeOutputName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/.test(value) &&
    !value.includes('..')
  );
}

interface DemoStep {
  label: string;
  action: string;
  params: Record<string, unknown>;
  pauseAfter?: number; // ms to wait after action for visual effect
  narration?: string; // text overlay or TTS narration
}

interface DemoScript {
  name: string;
  description: string;
  url?: string;
  steps: DemoStep[];
}

const RAR_DEMO_SCRIPT: DemoScript = {
  name: 'RAR Feature Walkthrough',
  description: 'A guided tour of the RAPP Agent Repository',
  url: 'https://kody-w.github.io/RAR/',
  steps: [
    {
      label: 'Opening RAR in Safari',
      action: 'open_app',
      params: { text: 'Safari' },
      pauseAfter: 2000,
    },
    {
      label: 'Navigating to RAR',
      action: 'key',
      params: { text: 'cmd+l' },
      pauseAfter: 500,
    },
    {
      label: 'Typing URL',
      action: 'type',
      params: { text: 'https://kody-w.github.io/RAR/' },
      pauseAfter: 500,
    },
    {
      label: 'Loading the page',
      action: 'key',
      params: { text: 'return' },
      pauseAfter: 3000,
      narration: 'Welcome to the RAPP Agent Repository',
    },
    {
      label: 'Capturing the landing page',
      action: 'screenshot',
      params: {},
      pauseAfter: 2000,
      narration: 'The main agent grid shows all available agents',
    },
    {
      label: 'Scrolling through agents',
      action: 'scroll',
      params: { direction: 'down', amount: 10 },
      pauseAfter: 1500,
    },
    {
      label: 'Scrolling more',
      action: 'scroll',
      params: { direction: 'down', amount: 10 },
      pauseAfter: 1500,
      narration: 'Browse through 138 agents across 19 categories',
    },
    {
      label: 'Scrolling back to top',
      action: 'scroll',
      params: { direction: 'up', amount: 30 },
      pauseAfter: 1500,
    },
    {
      label: 'Focusing search',
      action: 'key',
      params: { text: '/' },
      pauseAfter: 800,
      narration: 'Use slash to search agents',
    },
    {
      label: 'Searching for an agent',
      action: 'type',
      params: { text: 'fraud detection' },
      pauseAfter: 2000,
      narration: 'Search filters agents in real time',
    },
    {
      label: 'Capturing search results',
      action: 'screenshot',
      params: {},
      pauseAfter: 1500,
    },
    {
      label: 'Clearing search',
      action: 'key',
      params: { text: 'cmd+a' },
      pauseAfter: 300,
    },
    {
      label: 'Deleting search text',
      action: 'key',
      params: { text: 'delete' },
      pauseAfter: 500,
    },
    {
      label: 'Closing search',
      action: 'key',
      params: { text: 'escape' },
      pauseAfter: 1000,
    },
    {
      label: 'Reading the screen to find an agent card',
      action: 'read_screen',
      params: {},
      pauseAfter: 1000,
    },
    {
      label: 'Clicking the first agent card',
      action: 'click',
      params: { x: 400, y: 500 },
      pauseAfter: 2000,
      narration: 'Click any card to see agent details',
    },
    {
      label: 'Capturing agent detail modal',
      action: 'screenshot',
      params: {},
      pauseAfter: 2000,
      narration: 'View description, version, category, and download options',
    },
    {
      label: 'Closing the modal',
      action: 'key',
      params: { text: 'escape' },
      pauseAfter: 1000,
    },
    {
      label: 'Navigating to Submit page',
      action: 'key',
      params: { text: 'cmd+l' },
      pauseAfter: 500,
    },
    {
      label: 'Typing Submit URL',
      action: 'type',
      params: { text: 'https://kody-w.github.io/RAR/submit.html' },
      pauseAfter: 500,
    },
    {
      label: 'Loading Submit page',
      action: 'key',
      params: { text: 'return' },
      pauseAfter: 3000,
      narration: 'Submit your own agents to the repository',
    },
    {
      label: 'Capturing the submit page',
      action: 'screenshot',
      params: {},
      pauseAfter: 2000,
    },
    {
      label: 'Going back to main page',
      action: 'key',
      params: { text: 'cmd+l' },
      pauseAfter: 500,
    },
    {
      label: 'Typing main URL',
      action: 'type',
      params: { text: 'https://kody-w.github.io/RAR/' },
      pauseAfter: 500,
    },
    {
      label: 'Loading main page',
      action: 'key',
      params: { text: 'return' },
      pauseAfter: 2000,
    },
    {
      label: 'Final screenshot',
      action: 'screenshot',
      params: {},
      pauseAfter: 1000,
      narration: 'That wraps up the RAR tour!',
    },
  ],
};

export class DemoRecorderAgent extends BasicAgent {
  private computer: ComputerUseAgent;
  private outputDir: string;
  private recordingTimeouts = new Map<number, NodeJS.Timeout>();

  constructor() {
    const metadata: AgentMetadata = {
      name: 'DemoRecorder',
      description:
        'Records scripted demos of apps by orchestrating ComputerUseAgent while screen recording. Produces video walkthroughs with narration.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['record_rar', 'record_custom', 'list_scripts', 'status'],
            description: 'What to do',
          },
          script: {
            type: 'string',
            description: 'JSON demo script for record_custom action',
          },
          output_name: {
            type: 'string',
            description: 'Name for the output video file (without extension)',
          },
          with_narration: {
            type: 'boolean',
            description: 'Enable TTS narration (default true)',
          },
          query: {
            type: 'string',
            description: 'Natural language description of what to demo',
          },
        },
        required: [],
      },
    };
    super('DemoRecorder', metadata);
    this.computer = new ComputerUseAgent();
    this.outputDir = join(homedir(), 'Movies', 'RappterDemos');
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const action = (kwargs.action as string) || 'record_rar';
    const withNarration = kwargs.with_narration !== false;
    const outputName = kwargs.output_name ?? `demo_${Date.now()}`;

    if (
      (action === 'record_rar' || action === 'record_custom') &&
      !isSafeOutputName(outputName)
    ) {
      return JSON.stringify({
        status: 'error',
        message:
          'output_name must start with a letter or number and contain only letters, numbers, spaces, dots, dashes, or underscores',
      });
    }

    // Ensure output directory exists
    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
    }

    try {
      switch (action) {
        case 'record_rar':
          return await this.recordDemo(RAR_DEMO_SCRIPT, outputName as string, withNarration);
        case 'record_custom': {
          const scriptJson = kwargs.script as string;
          if (!scriptJson) {
            return JSON.stringify({
              status: 'error',
              message: 'script (JSON string) required for record_custom',
            });
          }
          const customScript = JSON.parse(scriptJson) as DemoScript;
          return await this.recordDemo(customScript, outputName as string, withNarration);
        }
        case 'list_scripts':
          return JSON.stringify({
            status: 'success',
            action: 'list_scripts',
            scripts: [
              {
                id: 'rar',
                name: RAR_DEMO_SCRIPT.name,
                description: RAR_DEMO_SCRIPT.description,
                steps: RAR_DEMO_SCRIPT.steps.length,
              },
            ],
          });
        case 'status':
          return await this.getStatus();
        default:
          return JSON.stringify({ status: 'error', message: `Unknown action: ${action}` });
      }
    } catch (e) {
      return JSON.stringify({
        status: 'error',
        action,
        message: (e as Error).message,
      });
    }
  }

  private async recordDemo(
    script: DemoScript,
    outputName: string,
    withNarration: boolean
  ): Promise<string> {
    const videoPath = join(this.outputDir, `${outputName}.mov`);
    const screenshots: string[] = [];
    const log: Array<{ step: string; status: string; timestamp: string; narration?: string }> = [];

    // Start screen recording using ffmpeg
    const recordingPid = await this.startRecording(videoPath);

    // Give ffmpeg time to initialize capture
    await this.sleep(2500);

    // Execute each step
    for (let i = 0; i < script.steps.length; i++) {
      const step = script.steps[i];
      const stepLabel = `[${i + 1}/${script.steps.length}] ${step.label}`;

      try {
        // Narrate if enabled
        if (withNarration && step.narration) {
          // Fire and forget TTS — don't block the demo
          this.narrate(step.narration).catch(() => {});
        }

        // Execute the computer action
        const result = await this.computer.execute({
          action: step.action,
          ...step.params,
        });

        // Collect screenshots — copy to demo dir for persistence
        const parsed = JSON.parse(result);
        if (parsed.path && step.action === 'screenshot') {
          const screenshotDest = join(
            this.outputDir,
            `${outputName}_step${i + 1}.png`
          );
          try {
            await copyFile(parsed.path, screenshotDest);
            screenshots.push(screenshotDest);
          } catch {
            screenshots.push(parsed.path);
          }
        }

        log.push({
          step: stepLabel,
          status: 'success',
          timestamp: new Date().toISOString(),
          narration: step.narration,
        });

        // Pause for visual effect
        if (step.pauseAfter) {
          await this.sleep(step.pauseAfter);
        }
      } catch (e) {
        log.push({
          step: stepLabel,
          status: `error: ${(e as Error).message}`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Stop recording
    await this.stopRecording(recordingPid);

    // Wait for file to be written
    await this.sleep(2000);

    const fileExists = existsSync(videoPath);

    return JSON.stringify({
      status: 'success',
      action: 'record_demo',
      script_name: script.name,
      video_path: fileExists ? videoPath : null,
      video_saved: fileExists,
      screenshots,
      steps_completed: log.filter((l) => l.status === 'success').length,
      steps_total: script.steps.length,
      log,
      data_slush: {
        source_agent: 'DemoRecorder',
        video_path: videoPath,
        script_name: script.name,
        screenshots_count: screenshots.length,
      },
    });
  }

  private async startRecording(outputPath: string): Promise<number> {
    const child = spawn(
      'ffmpeg',
      [
        '-f',
        'avfoundation',
        '-framerate',
        '30',
        '-i',
        'Capture screen 0',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        '-y',
        outputPath,
      ],
      { stdio: 'ignore' }
    );

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });

    if (!child.pid) {
      throw new Error('ffmpeg started without a process ID');
    }

    const timeout = setTimeout(() => child.kill('SIGINT'), 300000);
    timeout.unref();
    this.recordingTimeouts.set(child.pid, timeout);
    child.once('exit', () => {
      const current = this.recordingTimeouts.get(child.pid!);
      if (current) clearTimeout(current);
      this.recordingTimeouts.delete(child.pid!);
    });

    // Give ffmpeg time to initialize
    await this.sleep(2000);

    return child.pid || 0;
  }

  private async stopRecording(pid: number): Promise<void> {
    try {
      const timeout = this.recordingTimeouts.get(pid);
      if (timeout) {
        clearTimeout(timeout);
        this.recordingTimeouts.delete(pid);
      }
      // Send SIGINT (ctrl+c) to ffmpeg for clean shutdown
      if (pid) {
        process.kill(pid, 'SIGINT');
      }
      // Also try pkill as backup
      await execAsync('pkill -INT -f "ffmpeg.*avfoundation.*Capture screen"').catch(() => {});
    } catch {
      // Process may have already exited
    }
    // Give ffmpeg time to finalize the file
    await this.sleep(2000);
  }

  private async narrate(text: string): Promise<void> {
    await execFileAsync('/usr/bin/say', ['-v', 'Samantha', '-r', '180', text]).catch(() => {});
  }

  private async getStatus(): Promise<string> {
    // Check if a recording is in progress
    let recording = false;
    try {
      const { stdout } = await execAsync('pgrep -f "screencapture -v"');
      recording = stdout.trim().length > 0;
    } catch {
      recording = false;
    }

    // List existing demos
    let demos: string[] = [];
    try {
      const { stdout } = await execAsync(`ls -1t "${this.outputDir}" 2>/dev/null`);
      demos = stdout
        .trim()
        .split('\n')
        .filter((f) => f.endsWith('.mov'));
    } catch {
      demos = [];
    }

    return JSON.stringify({
      status: 'success',
      action: 'status',
      recording_in_progress: recording,
      output_dir: this.outputDir,
      existing_demos: demos,
      demo_count: demos.length,
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
