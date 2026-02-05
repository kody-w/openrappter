#!/usr/bin/env python3
"""
🦖 openrappter — rapp Agent Orchestrator

Dynamically discovers and loads agents from the agents/ directory.
Uses GitHub Copilot CLI for LLM-powered tool calling (no API keys needed).

Follows the CommunityRAPP function_app.py pattern:
- Agent discovery from agents/ directory
- Tool/function calling via LLM
- Automatic agent execution based on user intent

Usage:
    openrappter                         # Interactive mode (if installed)
    python -m openrappter.cli           # Interactive mode
    python -m openrappter.cli --task "hello"
    python -m openrappter.cli --list-agents

Dependencies:
    - Python 3.10+
    - GitHub Copilot CLI (for LLM-powered tool calling)
"""

import importlib
import importlib.util
import inspect
import json
import os
import subprocess
import sys
import re
import logging
from pathlib import Path
from datetime import datetime
from typing import Optional

# Package root for agent discovery
PACKAGE_ROOT = Path(__file__).parent

# ClawHub integration
try:
    from openrappter.clawhub import ClawHubClient, clawhub_search, clawhub_install, clawhub_list
    CLAWHUB_AVAILABLE = True
except ImportError:
    CLAWHUB_AVAILABLE = False

# RappterHub integration
try:
    from openrappter.rappterhub import (
        RappterHubClient, rappterhub_search, rappterhub_install,
        rappterhub_list, rappterhub_uninstall
    )
    RAPPTERHUB_AVAILABLE = True
except ImportError:
    RAPPTERHUB_AVAILABLE = False

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')


# ═══════════════════════════════════════════════════════════════════════════════
# AGENT DISCOVERY (CommunityRAPP Pattern)
# ═══════════════════════════════════════════════════════════════════════════════

class AgentRegistry:
    """
    Dynamic agent registry that discovers and loads agents from the agents/ directory.
    Also loads ClawHub skills from ~/.openrappter/skills/.
    Follows the CommunityRAPP pattern for agent discovery.
    """

    def __init__(self, agents_dir: Path = None):
        self.agents_dir = agents_dir or PACKAGE_ROOT / "agents"
        self._agents = {}
        self._clawhub_agents = {}
        self._loaded = False
    
    def discover_agents(self):
        """Discover and load all agents from the agents directory."""
        if self._loaded:
            return self._agents
        
        if not self.agents_dir.exists():
            self.agents_dir.mkdir(exist_ok=True)
            return self._agents
        
        # Import BasicAgent for type checking
        try:
            from openrappter.agents.basic_agent import BasicAgent
        except ImportError:
            BasicAgent = None
        
        # Scan for agent files
        for file_path in self.agents_dir.glob("*_agent.py"):
            if file_path.name.startswith("_") or file_path.name == "basic_agent.py":
                continue
            
            try:
                module_name = file_path.stem
                spec = importlib.util.spec_from_file_location(
                    f"agents.{module_name}", 
                    file_path
                )
                module = importlib.util.module_from_spec(spec)
                sys.modules[f"agents.{module_name}"] = module
                spec.loader.exec_module(module)
                
                for name, obj in inspect.getmembers(module, inspect.isclass):
                    if BasicAgent and issubclass(obj, BasicAgent) and obj is not BasicAgent:
                        try:
                            agent_instance = obj()
                            agent_name = getattr(agent_instance, 'name', name)
                            self._agents[agent_name] = {
                                'class': obj,
                                'instance': agent_instance,
                                'metadata': getattr(agent_instance, 'metadata', {}),
                                'module': module_name,
                                'file': str(file_path)
                            }
                        except Exception as e:
                            logging.warning(f"Failed to instantiate {name}: {e}")
                    elif hasattr(obj, 'metadata') and hasattr(obj, 'perform'):
                        try:
                            agent_instance = obj()
                            agent_name = getattr(agent_instance, 'name', name)
                            self._agents[agent_name] = {
                                'class': obj,
                                'instance': agent_instance,
                                'metadata': getattr(agent_instance, 'metadata', {}),
                                'module': module_name,
                                'file': str(file_path)
                            }
                        except Exception as e:
                            logging.warning(f"Failed to instantiate {name}: {e}")
                            
            except Exception as e:
                logging.warning(f"Failed to load {file_path}: {e}")
        
        # Also load ClawHub skills
        if CLAWHUB_AVAILABLE:
            self._discover_clawhub_skills()

        self._loaded = True
        total = len(self._agents) + len(self._clawhub_agents)
        logging.info(f"Loaded {len(self._agents)} agent(s), {len(self._clawhub_agents)} ClawHub skill(s)")
        return self._agents

    def _discover_clawhub_skills(self):
        """Discover and load ClawHub skills from ~/.openrappter/skills/."""
        try:
            client = ClawHubClient()
            skill_agents = client.load_all_skills()
            for agent in skill_agents:
                # Prefix with 'skill:' to distinguish from native agents
                skill_name = f"skill:{agent.name}"
                self._clawhub_agents[skill_name] = {
                    'class': type(agent),
                    'instance': agent,
                    'metadata': agent.metadata,
                    'module': 'clawhub',
                    'file': str(agent.skill.path) if agent.skill.path else 'clawhub'
                }
        except Exception as e:
            logging.warning(f"Failed to load ClawHub skills: {e}")
    
    def get_agent(self, name: str):
        """Get an agent instance by name."""
        self.discover_agents()
        if name in self._agents:
            return self._agents[name]['instance']
        # Check ClawHub skills (with or without 'skill:' prefix)
        if name in self._clawhub_agents:
            return self._clawhub_agents[name]['instance']
        skill_name = f"skill:{name}"
        if skill_name in self._clawhub_agents:
            return self._clawhub_agents[skill_name]['instance']
        return None

    def get_all_agents(self):
        """Get all agent instances (including ClawHub skills)."""
        self.discover_agents()
        agents = {name: info['instance'] for name, info in self._agents.items()}
        agents.update({name: info['instance'] for name, info in self._clawhub_agents.items()})
        return agents
    
    def get_agent_metadata_tools(self):
        """Convert agent metadata to OpenAI tools format for function calling."""
        self.discover_agents()
        tools = []
        for name, info in self._agents.items():
            if 'metadata' in info and info['metadata']:
                tool = {
                    "type": "function",
                    "function": info['metadata']
                }
                tools.append(tool)
        return tools
    
    def list_agents(self):
        """List all available agents with their metadata (including ClawHub skills)."""
        self.discover_agents()
        agents = [
            {
                'name': name,
                'description': info['metadata'].get('description', 'No description'),
                'parameters': info['metadata'].get('parameters', {}),
                'module': info['module'],
                'file': info['file'],
                'source': 'native'
            }
            for name, info in self._agents.items()
        ]
        # Add ClawHub skills
        agents.extend([
            {
                'name': name,
                'description': info['metadata'].get('description', 'No description'),
                'parameters': info['metadata'].get('parameters', {}),
                'module': info['module'],
                'file': info['file'],
                'source': 'clawhub'
            }
            for name, info in self._clawhub_agents.items()
        ])
        return agents


# ═══════════════════════════════════════════════════════════════════════════════
# COPILOT SDK PROVIDER (Using github-copilot-sdk)
# ═══════════════════════════════════════════════════════════════════════════════

class CopilotProvider:
    """
    LLM provider using GitHub Copilot SDK.
    Provides tool/function calling without requiring API keys.
    """
    
    def __init__(self):
        self._client = None
        self._session = None
        self._sdk_available = None
        self._loop = None
    
    @property
    def is_available(self) -> bool:
        """Check if Copilot SDK is available."""
        if self._sdk_available is None:
            try:
                from copilot import CopilotClient
                # Also check if copilot CLI is available
                result = subprocess.run(
                    ["copilot", "--version"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                self._sdk_available = result.returncode == 0
            except Exception:
                self._sdk_available = False
        return self._sdk_available
    
    def _get_loop(self):
        """Get or create an event loop."""
        import asyncio
        try:
            return asyncio.get_running_loop()
        except RuntimeError:
            if self._loop is None or self._loop.is_closed():
                self._loop = asyncio.new_event_loop()
                asyncio.set_event_loop(self._loop)
            return self._loop
    
    async def _ensure_client(self):
        """Ensure Copilot client is started."""
        if self._client is None:
            from copilot import CopilotClient
            self._client = CopilotClient({
                "log_level": "warning",
                "auto_start": True,
            })
            await self._client.start()
        return self._client
    
    async def _create_session(self, tools: list = None):
        """Create a new session with optional tools."""
        import asyncio
        from copilot import Tool
        
        client = await self._ensure_client()
        
        session_config = {
            "model": "gpt-4.1",  # Fast and capable
        }
        
        # Convert our tool format to Copilot SDK format
        if tools:
            sdk_tools = []
            for tool in tools:
                func = tool.get('function', {})
                tool_name = func.get('name', 'unknown')
                
                sdk_tools.append(Tool(
                    name=tool_name,
                    description=func.get('description', ''),
                    parameters=func.get('parameters', {}),
                    handler=lambda inv, n=tool_name: self._tool_invoked(n, inv)
                ))
            session_config["tools"] = sdk_tools
        
        session = await client.create_session(session_config)
        return session
    
    def _tool_invoked(self, tool_name: str, invocation: dict) -> dict:
        """Handle tool invocation from Copilot - just return the name and args."""
        # Store for later retrieval
        self._last_tool_call = {
            "name": tool_name,
            "arguments": json.dumps(invocation.get("arguments", {}))
        }
        return {
            "textResultForLlm": f"Tool {tool_name} will be executed by the orchestrator.",
            "resultType": "success"
        }
    
    def chat(self, message: str, system_prompt: str = "", tools: list = None) -> dict:
        """
        Send a chat message to Copilot and get a response.
        
        Returns:
            dict with keys: content, tool_calls (if any), error (if any)
        """
        if not self.is_available:
            return {
                "content": None,
                "error": "Copilot SDK not available",
                "tool_calls": None
            }
        
        import asyncio
        
        async def _chat():
            try:
                session = await self._create_session(tools)
                
                done = asyncio.Event()
                response_content = []
                tool_calls = []
                self._last_tool_call = None
                
                def on_event(event):
                    event_type = event.type.value if hasattr(event.type, 'value') else str(event.type)
                    
                    if event_type == "assistant.message":
                        response_content.append(event.data.content)
                    elif event_type == "tool.call":
                        # Capture tool call
                        tool_calls.append({
                            "name": event.data.tool_name if hasattr(event.data, 'tool_name') else "unknown",
                            "arguments": json.dumps(event.data.arguments if hasattr(event.data, 'arguments') else {})
                        })
                    elif event_type == "session.idle":
                        done.set()
                
                session.on(on_event)
                
                # Build prompt with system context
                full_prompt = message
                if system_prompt:
                    full_prompt = f"{system_prompt}\n\nUser: {message}"
                
                await session.send({"prompt": full_prompt})
                
                # Wait for response with timeout
                try:
                    await asyncio.wait_for(done.wait(), timeout=60)
                except asyncio.TimeoutError:
                    pass
                
                await session.destroy()
                
                # Check if we captured a tool call
                if self._last_tool_call:
                    tool_calls.append(self._last_tool_call)
                
                return {
                    "content": "\n".join(response_content) if response_content else None,
                    "tool_calls": tool_calls if tool_calls else None,
                    "error": None
                }
                
            except Exception as e:
                return {
                    "content": None,
                    "error": str(e),
                    "tool_calls": None
                }
        
        # Run async code
        loop = self._get_loop()
        return loop.run_until_complete(_chat())
    
    async def cleanup(self):
        """Clean up Copilot client."""
        if self._client:
            await self._client.stop()
            self._client = None


# ═══════════════════════════════════════════════════════════════════════════════
# ASSISTANT (function_app.py Pattern)
# ═══════════════════════════════════════════════════════════════════════════════

class Assistant:
    """
    Main assistant that orchestrates agent execution via LLM tool calling.
    Follows the CommunityRAPP function_app.py pattern.
    """
    
    def __init__(self, registry: AgentRegistry):
        self.registry = registry
        self.agents = registry.get_all_agents()
        self.copilot = CopilotProvider()
        self.conversation_history = []
        self.config = {
            'name': 'openrappter',
            'emoji': '🦖',
            'version': '1.1.0'
        }
    
    def get_system_prompt(self) -> str:
        """Build the system prompt with agent context."""
        agent_list = "\n".join([
            f"- {agent['name']}: {agent.get('description', 'No description')[:100]}"
            for agent in self.registry.list_agents()
        ])
        
        return f"""You are {self.config['emoji']} {self.config['name']}, a helpful terminal assistant.

Current time: {datetime.now().strftime("%Y-%m-%d %H:%M")}

You have access to these agents/tools that you can call:
{agent_list}

When a user asks you to do something that matches an agent's capability, call that agent.
Be helpful, concise, and use the appropriate tool when needed.
"""
    
    def process_message(self, user_message: str) -> str:
        """
        Process a user message, potentially calling agents via tool calling.
        Returns the response string.
        """
        # Add to conversation history
        self.conversation_history.append({
            "role": "user",
            "content": user_message
        })
        
        # Get available tools
        tools = self.registry.get_agent_metadata_tools()
        
        # Call Copilot with tools
        response = self.copilot.chat(
            message=user_message,
            system_prompt=self.get_system_prompt(),
            tools=tools if tools else None
        )
        
        # Handle errors
        if response.get('error'):
            # Fallback to direct agent execution for simple queries
            return self._fallback_response(user_message)
        
        # Check for tool calls
        if response.get('tool_calls'):
            tool_call = response['tool_calls'][0]
            agent_name = tool_call['name']
            
            try:
                arguments = json.loads(tool_call['arguments']) if tool_call['arguments'] else {}
            except json.JSONDecodeError:
                arguments = {}
            
            # Execute the agent
            result = self._execute_agent(agent_name, arguments, user_message)
            
            # Add agent execution to history
            self.conversation_history.append({
                "role": "assistant",
                "content": f"[Called {agent_name}]",
                "tool_call": tool_call
            })
            self.conversation_history.append({
                "role": "system",
                "content": f"Agent {agent_name} result: {result}"
            })
            
            return result
        
        # Return direct response
        content = response.get('content', '')
        self.conversation_history.append({
            "role": "assistant",
            "content": content
        })
        
        return content
    
    def _execute_agent(self, agent_name: str, arguments: dict, original_query: str) -> str:
        """Execute an agent with the given arguments."""
        agent = self.agents.get(agent_name)
        
        if not agent:
            return json.dumps({
                "status": "error",
                "message": f"Agent '{agent_name}' not found"
            })
        
        try:
            # Add query to arguments if not present
            if 'query' not in arguments and original_query:
                arguments['query'] = original_query
            
            # Execute the agent
            result = agent.execute(**arguments)
            
            logging.info(f"Executed agent {agent_name} with args: {list(arguments.keys())}")
            return result
            
        except Exception as e:
            logging.error(f"Error executing agent {agent_name}: {e}")
            return json.dumps({
                "status": "error",
                "message": f"Error executing {agent_name}: {str(e)}"
            })
    
    def _fallback_response(self, message: str) -> str:
        """Fallback when Copilot is unavailable - use smart agent matching."""
        msg_lower = message.lower()
        
        # Keyword patterns for core agents
        patterns = {
            'LearnNew': ['learn', 'create agent', 'new agent', 'make agent', 'teach', 'generate agent'],
            'ManageMemory': ['remember', 'store', 'save', 'memorize', 'keep in mind', 'note that'],
            'ContextMemory': ['recall', 'what do you know', 'remember about', 'memory of', 'remind me'],
            'Shell': ['run', 'execute', 'bash', 'ls', 'cat', 'read file', 'write file', 'list dir', 'command']
        }
        
        # Find best matching agent from patterns
        best_match = None
        best_score = 0
        
        for agent_name, keywords in patterns.items():
            score = sum(1 for kw in keywords if kw in msg_lower)
            if score > best_score:
                best_score = score
                best_match = agent_name
        
        # Also check dynamically loaded agents by their descriptions
        for agent_name, agent in self.agents.items():
            if agent_name in patterns:
                continue  # Already checked
            
            metadata = getattr(agent, 'metadata', {})
            desc = metadata.get('description', '').lower()
            name_lower = agent_name.lower()
            
            # Check if agent name or description keywords match
            words = [w for w in msg_lower.split() if len(w) > 2]
            score = sum(1 for w in words if w in desc or w in name_lower)
            
            if score > best_score:
                best_score = score
                best_match = agent_name
        
        # Execute matched agent
        if best_match and best_score > 0:
            agent = self.agents.get(best_match)
            if agent:
                # Prepare arguments based on agent type
                if best_match == 'LearnNew':
                    # Extract description from message
                    desc = message
                    for prefix in ['learn how to', 'learn to', 'create an agent that', 'make an agent that', 'teach yourself to']:
                        if prefix in msg_lower:
                            desc = message[msg_lower.find(prefix) + len(prefix):].strip()
                            break
                    return agent.execute(description=desc, query=message)
                else:
                    return agent.execute(query=message)
        
        # Default response
        return json.dumps({
            "status": "info",
            "response": f"I heard: '{message}'. Use /help to see available commands.",
            "agents": list(self.agents.keys())
        })


# ═══════════════════════════════════════════════════════════════════════════════
# ORCHESTRATOR
# ═══════════════════════════════════════════════════════════════════════════════

class Orchestrator:
    """
    Main orchestrator that combines agent registry and assistant.
    """
    
    def __init__(self):
        self.registry = AgentRegistry()
        self.assistant = None
        self.version = "1.2.0"
        self.emoji = "🦖"
        self.name = "openrappter"
    
    def initialize(self):
        """Initialize the orchestrator and assistant."""
        self.registry.discover_agents()
        self.assistant = Assistant(self.registry)
        return self
    
    def chat(self, message: str) -> str:
        """Process a chat message with tool calling."""
        if not self.assistant:
            self.initialize()
        return self.assistant.process_message(message)
    
    def execute_agent(self, agent_name: str, **kwargs) -> str:
        """Execute a specific agent directly."""
        agent = self.registry.get_agent(agent_name)
        if not agent:
            return json.dumps({"status": "error", "message": f"Agent '{agent_name}' not found"})
        return agent.execute(**kwargs)
    
    def list_agents(self):
        """List all available agents."""
        return self.registry.list_agents()
    
    @property
    def copilot_available(self) -> bool:
        """Check if Copilot is available."""
        if self.assistant:
            return self.assistant.copilot.is_available
        return CopilotProvider().is_available


# ═══════════════════════════════════════════════════════════════════════════════
# CLI ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    import argparse
    
    orchestrator = Orchestrator()
    
    parser = argparse.ArgumentParser(
        description=f"{orchestrator.emoji} {orchestrator.name} — rapp Agent Orchestrator with Tool Calling",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python openrappter.py                     Interactive chat mode
  python openrappter.py --task "hello"      Run a single task
  python openrappter.py --list-agents       List available agents
  python openrappter.py --exec Agent query  Execute specific agent
  python openrappter.py --status            Show status
""",
    )
    parser.add_argument("--version", "-v", action="version", version=f"{orchestrator.name} {orchestrator.version}")
    parser.add_argument("--task", "-t", help="Run a single task via chat")
    parser.add_argument("--status", "-s", action="store_true", help="Show status")
    parser.add_argument("--list-agents", "-l", action="store_true", help="List available agents")
    parser.add_argument("--exec", "-e", nargs=2, metavar=('AGENT', 'QUERY'), help="Execute specific agent")

    # ClawHub subcommands
    subparsers = parser.add_subparsers(dest='command', help='Commands')

    # clawhub search
    clawhub_parser = subparsers.add_parser('clawhub', help='ClawHub skill management')
    clawhub_sub = clawhub_parser.add_subparsers(dest='clawhub_command')

    search_parser = clawhub_sub.add_parser('search', help='Search ClawHub for skills')
    search_parser.add_argument('query', help='Search query')

    install_parser = clawhub_sub.add_parser('install', help='Install a skill from ClawHub')
    install_parser.add_argument('skill', help='Skill slug to install')

    clawhub_sub.add_parser('list', help='List installed ClawHub skills')

    # rappterhub subcommands
    rappterhub_parser = subparsers.add_parser('rappterhub', help='RappterHub agent management')
    rappterhub_sub = rappterhub_parser.add_subparsers(dest='rappterhub_command')

    rh_search_parser = rappterhub_sub.add_parser('search', help='Search RappterHub for agents')
    rh_search_parser.add_argument('query', help='Search query')

    rh_install_parser = rappterhub_sub.add_parser('install', help='Install an agent from RappterHub')
    rh_install_parser.add_argument('agent', help='Agent reference (author/name)')
    rh_install_parser.add_argument('--force', '-f', action='store_true', help='Force reinstall')

    rappterhub_sub.add_parser('list', help='List installed RappterHub agents')

    rh_uninstall_parser = rappterhub_sub.add_parser('uninstall', help='Uninstall an agent')
    rh_uninstall_parser.add_argument('agent', help='Agent name to uninstall')
    
    args = parser.parse_args()

    # Handle clawhub commands before full initialization
    if args.command == 'clawhub':
        if not CLAWHUB_AVAILABLE:
            print("ClawHub integration not available. Check clawhub.py exists.")
            return

        if args.clawhub_command == 'search':
            print(clawhub_search(args.query))
            return
        elif args.clawhub_command == 'install':
            print(clawhub_install(args.skill))
            return
        elif args.clawhub_command == 'list':
            print(clawhub_list())
            return
        else:
            print("Usage: openrappter clawhub [search|install|list]")
            return

    # Handle rappterhub commands
    if args.command == 'rappterhub':
        if not RAPPTERHUB_AVAILABLE:
            print("RappterHub integration not available. Check rappterhub.py exists.")
            return

        if args.rappterhub_command == 'search':
            print(rappterhub_search(args.query))
            return
        elif args.rappterhub_command == 'install':
            print(rappterhub_install(args.agent, getattr(args, 'force', False)))
            return
        elif args.rappterhub_command == 'list':
            print(rappterhub_list())
            return
        elif args.rappterhub_command == 'uninstall':
            print(rappterhub_uninstall(args.agent))
            return
        else:
            print("Usage: openrappter rappterhub [search|install|list|uninstall]")
            return

    # Initialize
    orchestrator.initialize()
    
    # List agents
    if args.list_agents:
        agents = orchestrator.list_agents()
        if not agents:
            print("No agents found in agents/ directory")
            return
        print(f"\n{orchestrator.emoji} Available Agents:\n")

        # Separate native and clawhub agents
        native = [a for a in agents if a.get('source') == 'native']
        clawhub = [a for a in agents if a.get('source') == 'clawhub']

        if native:
            print("  Native Agents:")
            for agent in native:
                print(f"    • {agent['name']}")
                print(f"      {agent['description'][:60]}...")
            print()

        if clawhub:
            print("  ClawHub Skills:")
            for agent in clawhub:
                print(f"    • {agent['name']}")
                print(f"      {agent['description'][:60]}...")
            print()
        return
    
    # Status check
    if args.status:
        agents = orchestrator.list_agents()
        print(json.dumps({
            "status": "success",
            "orchestrator": {
                "name": orchestrator.name,
                "version": orchestrator.version,
                "copilot_available": orchestrator.copilot_available,
                "agents_loaded": len(agents),
                "agents": [a['name'] for a in agents]
            }
        }, indent=2))
        return
    
    # Execute specific agent
    if args.exec:
        agent_name, query = args.exec
        result = orchestrator.execute_agent(agent_name, query=query)
        print(result)
        return
    
    # Single task via chat
    if args.task:
        result = orchestrator.chat(args.task)
        # Pretty print if JSON
        try:
            data = json.loads(result)
            if 'response' in data:
                print(data['response'])
            elif 'message' in data:
                print(data['message'])
            else:
                print(json.dumps(data, indent=2))
        except json.JSONDecodeError:
            print(result)
        return
    
    # Interactive chat mode
    print(f"\n{orchestrator.emoji} {orchestrator.name} v{orchestrator.version}")
    print("─" * 40)
    print(f"Copilot: {'✅ Available' if orchestrator.copilot_available else '❌ Not found'}")
    print(f"Agents: {len(orchestrator.list_agents())} loaded")
    print("Type /help for commands, /quit to exit")
    print()
    
    while True:
        try:
            user_input = input(f"{orchestrator.emoji} You: ").strip()
            if not user_input:
                continue
            
            # Handle commands
            if user_input.startswith("/"):
                cmd = user_input[1:].lower().split()[0]
                
                if cmd in ["quit", "exit", "q"]:
                    print(f"\nGoodbye! {orchestrator.emoji}")
                    break
                
                if cmd == "help":
                    print(f"""
{orchestrator.emoji} Commands:
  /help     - Show this help
  /agents   - List available agents
  /status   - Show status
  /quit     - Exit
""")
                    continue
                
                if cmd == "agents":
                    for agent in orchestrator.list_agents():
                        print(f"  • {agent['name']}: {agent['description'][:50]}...")
                    continue
                
                if cmd == "status":
                    print(f"  Copilot: {'✅' if orchestrator.copilot_available else '❌'}")
                    print(f"  Agents: {len(orchestrator.list_agents())}")
                    continue
                
                print(f"Unknown command: {user_input}")
                continue
            
            # Process chat message
            result = orchestrator.chat(user_input)
            
            # Display result
            try:
                data = json.loads(result)
                if data.get("status") == "exit":
                    print(f"\nGoodbye! {orchestrator.emoji}")
                    break
                elif "response" in data:
                    print(f"\n{orchestrator.emoji}: {data['response']}\n")
                elif "message" in data:
                    print(f"\n{orchestrator.emoji}: {data['message']}\n")
                elif "output" in data:
                    print(f"\n{data['output']}\n")
                else:
                    print(f"\n{json.dumps(data, indent=2)}\n")
            except json.JSONDecodeError:
                print(f"\n{orchestrator.emoji}: {result}\n")
            
        except KeyboardInterrupt:
            print(f"\n\nGoodbye! {orchestrator.emoji}")
            break
        except EOFError:
            break


if __name__ == "__main__":
    main()
