/**
 * Parity Tests Index
 *
 * These tests verify feature parity between openrappter and openclaw.
 *
 * Existing Test Categories:
 * - channels.test.ts - All messaging channels (Discord, Slack, WhatsApp, etc.)
 * - gateway.test.ts - WebSocket RPC protocol and HTTP endpoints
 * - memory.test.ts - SQLite persistence, vector search, FTS
 * - multiagent.test.ts - Agent routing, broadcast, sub-agents
 * - docker.test.ts - Container build, health checks, volumes
 *
 * New Parity Gap Tests:
 * - cli.test.ts - CLI commands and subcommands
 * - onboarding.test.ts - Wizard flow (channel selection, credentials, validation)
 * - config.test.ts - Config schema, loading, hot reload, RPC
 * - cron.test.ts - Job CRUD, scheduling, execution, history
 * - voice.test.ts - TTS providers, transcription, voice wake
 * - browser.test.ts - Navigation, DOM, screenshots, cookies, sandbox
 * - media.test.ts - Image/video/audio/document processing, channel limits
 * - nodes.test.ts - Node protocol, pairing, method invocation, capabilities
 * - sessions.test.ts - Session CRUD, isolation, transcript storage
 * - providers.test.ts - Model providers, failover, embedding, auth
 * - network.test.ts - Tailscale, mDNS, bind modes, TLS
 * - security.test.ts - Approvals, policies, scopes, audit logging
 * - skills.test.ts - Skill registry, execution, categories, creator
 * - advanced.test.ts - Hooks, auto-reply, HTTP API compat, usage tracking
 * - power-prompts.test.ts - 10 multi-channel power prompt scenarios
 * - power-prompts-2.test.ts - 20 ambient intelligence scenarios
 */

export {};
