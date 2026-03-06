/**
 * DailyTipAgent - Onboarding drip campaign via native notifications.
 *
 * Sends a daily tip as a macOS/Linux notification that teaches the user
 * one openrappter feature per day for the first 30 days. Each tip includes
 * a command they can try immediately.
 *
 * Auto-created during onboard. Users can customize or disable via cron.
 *
 * Actions: tip (show today's), preview (show all), send (force specific day)
 */

import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

interface Tip {
  day: number;
  title: string;
  body: string;
  command: string;
}

const TIPS: Tip[] = [
  // Week 1: Basics
  { day: 1, title: 'Welcome to openrappter! 🦖', body: 'I\'m your AI agent running in the background. Click this notification to chat with me, or try the command below.', command: 'openrappter "what can you do?"' },
  { day: 2, title: 'I remember things 🧠', body: 'Tell me facts and I\'ll remember them forever. Try it:', command: 'openrappter "remember that I prefer dark mode"' },
  { day: 3, title: 'I can run shell commands 🖥️', body: 'Ask me to check disk space, find files, or run any command.', command: 'openrappter --exec Shell "df -h"' },
  { day: 4, title: 'Check my status anytime 📊', body: 'See all connected agents, channels, and services at a glance.', command: 'openrappter --status' },
  { day: 5, title: 'I have 20 specialized agents 🤖', body: 'Each one handles a different task. See them all:', command: 'openrappter --list-agents' },
  { day: 6, title: 'I browse the web for you 🌐', body: 'I can search the web and fetch pages. Ask me anything current.', command: 'openrappter --exec Web "search latest AI news"' },
  { day: 7, title: 'Weekly recap 📅', body: 'You\'ve been using openrappter for a week! I\'ve been running cron jobs, remembering facts, and learning your preferences. Check what I remember:', command: 'openrappter --exec Memory "list"' },

  // Week 2: Power features
  { day: 8, title: 'I can read code 🔍', body: 'Point me at a repo and I\'ll review it. The CodeReview agent catches bugs, security issues, and style problems.', command: 'openrappter --exec Git "status"' },
  { day: 9, title: 'Cron jobs = set and forget ⏱️', body: 'I run scheduled tasks automatically. You already have some! Check them:', command: 'openrappter --exec Cron "list"' },
  { day: 10, title: 'I can speak! 🎙️', body: 'The TTS agent converts text to speech. Try hearing something:', command: 'openrappter --exec TTS "speak Hello from openrappter"' },
  { day: 11, title: 'Dream Mode cleans my brain 🧹', body: 'Every night at 3am, I review my memories, merge duplicates, and prune stale facts. Run it manually:', command: 'openrappter --exec Dream "audit"' },
  { day: 12, title: 'I read Hacker News 📰', body: 'Get top stories from HN without opening a browser.', command: 'openrappter --exec HackerNews "top 5 stories"' },
  { day: 13, title: 'Open the web dashboard 🖥️', body: 'I have a full web UI with agents, memory, sessions, and more.', command: 'openrappter --web' },
  { day: 14, title: 'Two weeks in! 🎉', body: 'You\'re a power user now. Fun fact: I\'ve been evolving myself. The Ouroboros agent rewrites its own code across 5 generations.', command: 'openrappter --exec Ouroboros "evolve"' },

  // Week 3: Customization
  { day: 15, title: 'Create your own agents ✨', body: 'Describe an agent in English and I\'ll build it. No code required.', command: 'openrappter --exec LearnNew "Create an agent that checks my git repos for uncommitted changes"' },
  { day: 16, title: 'I have different personalities 👻', body: 'Soul templates let you summon specialized versions of me: coder, researcher, ops, narrator, oracle.', command: 'openrappter --exec Shell "cat ~/.openrappter/typescript/src/gateway/soul-templates/index.ts | head -20"' },
  { day: 17, title: 'Chain agents together ⛓️', body: 'The Pipeline agent runs multiple agents in sequence. Output from one feeds into the next.', command: 'openrappter --exec Pipeline "Shell:date | Memory:remember today\'s date"' },
  { day: 18, title: 'Customize this tip! ✏️', body: 'This daily tip is just a cron job. Edit cron.json to change the schedule, or disable it anytime.', command: 'cat ~/.openrappter/cron.json' },
  { day: 19, title: 'I self-heal 🏥', body: 'SelfHealingCron monitors services and auto-restarts them when they go down.', command: 'openrappter --exec SelfHealingCron "status"' },
  { day: 20, title: 'Browse the agent marketplace 🏪', body: 'RappterHub has community-built agents you can install with one command.', command: 'openrappter rappterhub search "productivity"' },
  { day: 21, title: 'Three weeks! 🌟', body: 'You\'ve explored most of my features. Next week: the advanced stuff that makes openrappter truly unique.', command: 'openrappter --exec Memory "recall openrappter"' },

  // Week 4: Advanced
  { day: 22, title: 'I watch myself improve 🧬', body: 'Watchmaker evaluates agent quality, A/B tests new versions, and promotes winners. It\'s Darwinian evolution for AI.', command: 'openrappter --exec Watchmaker "status"' },
  { day: 23, title: 'Data sloshing = context magic 🌊', body: 'Before every action, I auto-enrich your request with temporal, memory, and behavioral signals. You get smarter answers without asking smarter questions.', command: 'openrappter "what time is it and what was I working on recently?"' },
  { day: 24, title: 'Multi-channel messaging 📱', body: 'I can send messages to Telegram, Slack, Discord, and more — all from one interface.', command: 'openrappter --exec Message "list channels"' },
  { day: 25, title: 'Screenshot & analyze 📸', body: 'The Browser agent can navigate websites, take screenshots, and the Image agent analyzes them.', command: 'openrappter --exec Browser "screenshot https://github.com"' },
  { day: 26, title: 'Your data stays local 🔒', body: 'Memory, config, sessions, and agent state all live in ~/.openrappter/. Nothing leaves your machine except LLM API calls.', command: 'ls ~/.openrappter/' },
  { day: 27, title: 'Write skills, share them 📦', body: 'Skills are portable agent packages. Write one and publish it to RappterHub for others to use.', command: 'cat ~/.openrappter/skills.md | head -30' },
  { day: 28, title: 'The daemon log 📋', body: 'Everything the daemon does is logged. Check what\'s been happening while you weren\'t looking.', command: 'tail -30 ~/.openrappter/daemon.log' },
  { day: 29, title: 'Morning Brief ☀️', body: 'Every day at 8am, MorningBrief checks weather, your calendar, and priorities from memory. Add a ~/calendar.md to personalize it.', command: 'openrappter --exec MorningBrief ""' },
  { day: 30, title: 'You\'ve graduated! 🎓', body: 'You now know everything openrappter can do. This tip series is done — but I\'m always here. Disable this cron job or keep it for the reminder. Happy hacking! 🦖', command: 'openrappter "thanks for everything"' },
];

export class DailyTipAgent extends BasicAgent {
  private stateFile: string;

  constructor() {
    const metadata: AgentMetadata = {
      name: 'DailyTip',
      description: 'Sends a daily onboarding tip as a native notification. Teaches one openrappter feature per day for 30 days.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'The action to perform.',
            enum: ['tip', 'preview', 'send'],
          },
          day: {
            type: 'number',
            description: 'Force a specific day number (1-30) for send action.',
          },
        },
        required: [],
      },
    };
    super('DailyTip', metadata);
    this.stateFile = path.join(os.homedir(), '.openrappter', 'tip-state.json');
  }

  private async getState(): Promise<{ startDate: string; lastDay: number }> {
    try {
      const data = await fs.readFile(this.stateFile, 'utf-8');
      return JSON.parse(data);
    } catch {
      const state = { startDate: new Date().toISOString(), lastDay: 0 };
      await this.saveState(state);
      return state;
    }
  }

  private async saveState(state: { startDate: string; lastDay: number }): Promise<void> {
    await fs.writeFile(this.stateFile, JSON.stringify(state, null, 2));
  }

  private getTodayNumber(startDate: string): number {
    const start = new Date(startDate).getTime();
    const now = Date.now();
    return Math.floor((now - start) / 86400000) + 1;
  }

  private sendNotification(title: string, body: string, command: string): void {
    const port = process.env.OPENRAPPTER_PORT ?? '18790';
    const webUrl = `http://127.0.0.1:${port}`;
    const barApp = '/Applications/OpenRappter Bar.app';
    const hasBar = (() => { try { return require('fs').existsSync(barApp); } catch { return false; } })();
    const hasTerminalNotifier = (() => { try { execSync('which terminal-notifier', { stdio: 'pipe' }); return true; } catch { return false; } })();

    if (process.platform === 'darwin' && hasTerminalNotifier) {
      // Clickable notification — opens web UI or menu bar app on click
      const openTarget = hasBar ? barApp : webUrl;
      const subtitle = hasBar ? 'Click to open OpenRappter Bar' : 'Click to open web dashboard';
      const escapedTitle = title.replace(/"/g, '\\"');
      const escapedBody = `${body}\n\n💡 Try: ${command}`.replace(/"/g, '\\"');
      const escapedSubtitle = subtitle.replace(/"/g, '\\"');
      try {
        const iconFlag = hasBar
          ? `-appIcon "${barApp}/Contents/Resources/AppIcon.icns"`
          : '';
        execSync(
          `terminal-notifier -title "${escapedTitle}" -subtitle "${escapedSubtitle}" -message "${escapedBody}" -open "${openTarget}" ${iconFlag} -group openrappter`,
          { timeout: 5000, stdio: 'pipe' },
        );
      } catch {
        // Fall back to osascript
        this.sendOsascriptNotification(title, body, command);
      }
    } else if (process.platform === 'darwin') {
      this.sendOsascriptNotification(title, body, command);
    } else if (process.platform === 'linux') {
      const escapedTitle = title.replace(/"/g, '\\"');
      const fullBody = `${body}\n\n💡 Try: ${command}`.replace(/"/g, '\\"');
      try {
        // notify-send with --action for clickable on modern desktops
        execSync(
          `notify-send "${escapedTitle}" "${fullBody}" --app-name=openrappter`,
          { timeout: 5000, stdio: 'pipe' },
        );
      } catch {
        // notify-send not available
      }
    }
  }

  private sendOsascriptNotification(title: string, body: string, command: string): void {
    const escapedTitle = title.replace(/"/g, '\\"');
    const escapedBody = `${body}\\n\\n💡 Try: ${command}`.replace(/"/g, '\\"');
    try {
      execSync(
        `osascript -e 'display notification "${escapedBody}" with title "${escapedTitle}"'`,
        { timeout: 5000, stdio: 'pipe' },
      );
    } catch {
      // Notification failed — not critical
    }
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    let action = (kwargs.action as string) || 'tip';
    const forcedDay = kwargs.day as number | undefined;

    // Parse from query string for --exec usage
    const query = kwargs.query as string | undefined;
    if (query && !kwargs.action) {
      const q = query.toLowerCase().trim();
      if (q === 'preview' || q === 'all') action = 'preview';
      else if (q.match(/^\d+$/)) {
        action = 'send';
      } else if (q.startsWith('send') && q.match(/\d+/)) {
        action = 'send';
      } else {
        action = 'tip';
      }
    }

    switch (action) {
      case 'tip':
        return this.sendTodaysTip();
      case 'preview':
        return this.previewAll();
      case 'send':
        return this.sendSpecificDay(forcedDay ?? parseInt(query ?? '1', 10));
      default:
        return JSON.stringify({ status: 'error', message: `Unknown action: ${action}` });
    }
  }

  private async sendTodaysTip(): Promise<string> {
    const state = await this.getState();
    const dayNum = this.getTodayNumber(state.startDate);

    if (dayNum > 30) {
      return JSON.stringify({
        status: 'complete',
        message: 'All 30 tips have been delivered! 🎓',
        day: dayNum,
      });
    }

    // Don't resend same day
    if (state.lastDay >= dayNum) {
      const tip = TIPS[dayNum - 1];
      return JSON.stringify({
        status: 'already_sent',
        message: `Today's tip (day ${dayNum}) was already sent.`,
        tip: tip ? { title: tip.title, body: tip.body, command: tip.command } : null,
      });
    }

    const tip = TIPS[dayNum - 1];
    if (!tip) {
      return JSON.stringify({ status: 'error', message: `No tip for day ${dayNum}` });
    }

    this.sendNotification(tip.title, tip.body, tip.command);

    state.lastDay = dayNum;
    await this.saveState(state);

    return JSON.stringify({
      status: 'success',
      day: dayNum,
      tip: { title: tip.title, body: tip.body, command: tip.command },
      remaining: 30 - dayNum,
      data_slush: this.slushOut({
        signals: { day: dayNum, remaining: 30 - dayNum, title: tip.title },
      }),
    });
  }

  private async previewAll(): Promise<string> {
    const state = await this.getState();
    const currentDay = this.getTodayNumber(state.startDate);

    return JSON.stringify({
      status: 'success',
      current_day: currentDay,
      last_sent: state.lastDay,
      total_tips: TIPS.length,
      tips: TIPS.map(t => ({
        day: t.day,
        title: t.title,
        body: t.body,
        command: t.command,
        sent: t.day <= state.lastDay,
      })),
    });
  }

  private async sendSpecificDay(day: number): Promise<string> {
    if (day < 1 || day > 30) {
      return JSON.stringify({ status: 'error', message: 'Day must be 1-30' });
    }

    const tip = TIPS[day - 1];
    this.sendNotification(tip.title, tip.body, tip.command);

    return JSON.stringify({
      status: 'success',
      day,
      tip: { title: tip.title, body: tip.body, command: tip.command },
    });
  }
}
