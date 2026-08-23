/**
 * OpenRappter UI Entry Point
 */

import './components/app.js';
import './components/xpedition-onboarding.js';
import './components/company-app.js';
import './components/xpedition-extension-host.js';
import './components/xpedition-shell.js';
import './components/sidebar.js';
import './components/surgeon.js';
import './components/chat.js';
import './components/show-and-tell.js';
import './components/channels.js';
import './components/sessions.js';
import './components/cron.js';
import './components/config.js';
import './components/logs.js';
import './components/devices.js';
import './components/agents.js';
import './components/skills.js';
import './components/showcase.js';
import './components/zen.js';
import './components/accounts.js';
import './components/presence.js';
import './components/debug.js';
import { installDesktopCommandHandler } from './services/desktop-control.js';
import { installXpeditionExtensionApi } from './services/xpedition-extensions.js';

installDesktopCommandHandler();
installXpeditionExtensionApi();
console.log('OpenRappter UI initialized');
