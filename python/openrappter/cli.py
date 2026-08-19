from openrappter.paths import openrappter_path
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
import time
from pathlib import Path
from datetime import datetime
from typing import Optional

from openrappter import __version__
from openrappter.result_status import agent_result_is_error

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

    def __init__(
        self,
        agents_dir: Path = None,
        skills_dir: Path = None,
        load_skills: bool = True,
    ):
        self.agents_dir = Path(agents_dir) if agents_dir is not None else PACKAGE_ROOT / "agents"
        self.skills_dir = (
            Path(skills_dir)
            if skills_dir is not None
            else openrappter_path("skills")
        )
        self.load_skills = load_skills
        self._agents = {}
        self._clawhub_agents = {}
        self._loaded = False
    
    def discover_agents(self):
        """Discover and load all agents from the agents directory."""
        if self._loaded:
            return self._agents
        
        if not self.agents_dir.exists():
            self.agents_dir.mkdir(parents=True, exist_ok=True)
            return self._agents
        
        # Import BasicAgent for type checking
        try:
            from openrappter.agents.basic_agent import BasicAgent
        except ImportError:
            BasicAgent = None

        # Agents written to the portability contract import `agents.basic_agent`
        # and nothing else from the tree, so the same file runs in the grail
        # brainstem unchanged. This loader already gives discovered modules a
        # synthetic `agents.` namespace, but it skips basic_agent.py, so that
        # import resolved to nothing and the agent failed to load here while
        # loading fine in the grail. Alias it, without clobbering a real
        # top-level `agents` package if one is present.
        if BasicAgent is not None:
            import openrappter.agents as _agents_pkg
            import openrappter.agents.basic_agent as _basic_agent_mod

            sys.modules.setdefault("agents", _agents_pkg)
            sys.modules.setdefault("agents.basic_agent", _basic_agent_mod)

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
        if CLAWHUB_AVAILABLE and self.load_skills:
            self._discover_clawhub_skills()

        self._loaded = True
        total = len(self._agents) + len(self._clawhub_agents)
        logging.info(f"Loaded {len(self._agents)} agent(s), {len(self._clawhub_agents)} ClawHub skill(s)")
        return self._agents

    def _discover_clawhub_skills(self):
        """Discover and load ClawHub skills from ~/.openrappter/skills/."""
        try:
            client = ClawHubClient(skills_dir=self.skills_dir)
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
        self.id = "github-copilot"
        self.model = "gpt-4.1"
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
            "model": self.model,  # Fast and capable
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
                    await session.destroy()
                    return {
                        "content": None,
                        "tool_calls": None,
                        "error": "Copilot request timed out after 60 seconds",
                    }
                
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
            'version': __version__,
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
        from openrappter.flight_recorder import ensure_flight_recorder_from_env

        recorder = ensure_flight_recorder_from_env()
        operation = lambda: self._process_message_within_trace(user_message)
        if recorder.current_trace():
            return operation()
        return recorder.run_trace(
            {
                "sessionId": "python-cli",
                "workspaceId": str(Path.cwd()),
            },
            operation,
        )

    def _process_message_within_trace(self, user_message: str) -> str:
        """Process one message after its Flight Recorder trace is established."""
        # Add to conversation history
        self.conversation_history.append({
            "role": "user",
            "content": user_message
        })
        
        # Get available tools
        tools = self.registry.get_agent_metadata_tools()
        
        # Call Copilot with tools
        from openrappter.flight_recorder import (
            ensure_flight_recorder_from_env,
            summarize_flight_error,
        )

        recorder = ensure_flight_recorder_from_env()
        started = time.monotonic()
        system_prompt = self.get_system_prompt()
        provider_messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ]
        model_policy = (
            self.copilot.model.strip()
            if isinstance(self.copilot.model, str)
            and self.copilot.model.strip()
            else None
        )
        recorder.record({
            "kind": "context.assembled",
            "source": "python-cli-assistant",
            "status": "info",
            "metadata": {
                "sourceNames": ["system", "history", "tools"],
                "categoryNames": [
                    "system",
                    "conversation",
                    "tools",
                ],
                "systemChars": len(system_prompt),
                "historyLength": len(self.conversation_history),
                "toolCount": len(tools),
            },
            "payload": {
                "messages": provider_messages,
                "tools": tools,
            },
        })
        started_event = recorder.record({
            "kind": "provider.attempt.started",
            "source": "python-cli-assistant",
            "status": "started",
            "providerId": self.copilot.id,
            "metadata": {
                "messageCount": len(provider_messages),
                "toolCount": len(tools),
                **({"modelPolicy": model_policy} if model_policy else {}),
            },
            "payload": {
                "messages": provider_messages,
                "tools": tools,
            },
        })
        provider_parent_id = (
            started_event.get("id") if started_event is not None else None
        )
        try:
            response = self.copilot.chat(
                message=user_message,
                system_prompt=system_prompt,
                tools=tools if tools else None
            )
        except Exception as exc:
            recorder.record({
                "kind": "provider.attempt.failed",
                "source": "python-cli-assistant",
                "status": "error",
                **({"parentId": provider_parent_id} if provider_parent_id else {}),
                "providerId": self.copilot.id,
                "durationMs": (time.monotonic() - started) * 1000,
                "metadata": {
                    **summarize_flight_error(exc),
                    **({"modelPolicy": model_policy} if model_policy else {}),
                },
                "payload": {
                    "messages": provider_messages,
                    "tools": tools,
                    "error": exc,
                },
            })
            raise

        if response.get("error"):
            failed_event = recorder.record({
                "kind": "provider.attempt.failed",
                "source": "python-cli-assistant",
                "status": "error",
                **({"parentId": provider_parent_id} if provider_parent_id else {}),
                "providerId": self.copilot.id,
                **(
                    {"model": response.get("model")}
                    if response.get("model")
                    else {}
                ),
                "durationMs": (time.monotonic() - started) * 1000,
                "metadata": {
                    **summarize_flight_error(response.get("error")),
                    **({"modelPolicy": model_policy} if model_policy else {}),
                },
                "payload": {
                    "messages": provider_messages,
                    "tools": tools,
                    "response": response,
                },
            })
            provider_completed_id = (
                failed_event.get("id")
                if failed_event is not None
                else provider_parent_id
            )
        else:
            completed_event = recorder.record({
                "kind": "provider.attempt.completed",
                "source": "python-cli-assistant",
                "status": "success",
                **({"parentId": provider_parent_id} if provider_parent_id else {}),
                "providerId": self.copilot.id,
                **(
                    {"model": response.get("model")}
                    if response.get("model")
                    else {}
                ),
                "durationMs": (time.monotonic() - started) * 1000,
                "metadata": {
                    "hadContent": bool(response.get("content")),
                    "hadToolCalls": bool(response.get("tool_calls")),
                    **({"modelPolicy": model_policy} if model_policy else {}),
                },
                "payload": {
                    "messages": provider_messages,
                    "tools": tools,
                    "response": response,
                },
            })
            provider_completed_id = (
                completed_event.get("id")
                if completed_event is not None
                else provider_parent_id
            )
        
        # Handle errors
        if response.get('error'):
            # Fallback to direct agent execution for simple queries
            return self._fallback_response(
                user_message,
                recorder,
                provider_completed_id,
            )
        
        # Check for tool calls
        if response.get('tool_calls'):
            tool_call = response['tool_calls'][0]
            agent_name = tool_call['name']
            
            parse_success = True
            try:
                arguments = json.loads(tool_call['arguments']) if tool_call['arguments'] else {}
            except json.JSONDecodeError:
                arguments = {}
                parse_success = False
            
            result = self._run_agent_tool(
                recorder,
                agent_name,
                arguments,
                user_message,
                provider_completed_id,
                parse_success=parse_success,
                argument_text=tool_call.get("arguments") or "",
                route="provider-tool-call",
            )
            
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

    def _run_agent_tool(
        self,
        recorder,
        agent_name: str,
        arguments: dict,
        original_query: str,
        parent_id: Optional[str],
        *,
        parse_success: bool,
        argument_text: str,
        route: str,
        route_score: Optional[int] = None,
    ) -> str:
        from openrappter.flight_recorder import sanitize_flight_value

        tool_started_at = time.monotonic()
        route_metadata = {
            "route": route,
            **({"routeScore": route_score} if route_score is not None else {}),
        }
        tool_started = recorder.record({
            "kind": "tool.call.started",
            "source": "python-cli-assistant",
            "status": "started",
            **({"parentId": parent_id} if parent_id else {}),
            "toolName": agent_name,
            "metadata": {
                "parseSuccess": parse_success,
                "argumentChars": len(argument_text),
                **route_metadata,
            },
            "payload": {
                "arguments": (
                    arguments
                    if parse_success
                    else sanitize_flight_value(argument_text)
                )
            },
        })
        tool_parent_id = (
            tool_started.get("id") if tool_started is not None else None
        )
        result = recorder.with_parent(
            tool_parent_id,
            lambda: self._execute_agent(agent_name, arguments, original_query),
        )
        failed = agent_result_is_error(result)
        try:
            parsed_result = json.loads(result)
        except (json.JSONDecodeError, TypeError):
            parsed_result = sanitize_flight_value(result)
        recorder.record({
            "kind": (
                "tool.call.failed"
                if failed
                else "tool.call.completed"
            ),
            "source": "python-cli-assistant",
            "status": "error" if failed else "success",
            **({"parentId": tool_parent_id} if tool_parent_id else {}),
            "toolName": agent_name,
            "durationMs": (time.monotonic() - tool_started_at) * 1000,
            "metadata": {
                "parseSuccess": parse_success,
                "resultLength": len(result),
                **({"resultStatus": "error"} if failed else {}),
                **route_metadata,
            },
            "payload": {
                "arguments": (
                    arguments
                    if parse_success
                    else sanitize_flight_value(argument_text)
                ),
                "result": sanitize_flight_value(parsed_result),
            },
        })
        return result

    def _fallback_response(
        self,
        message: str,
        recorder,
        parent_id: Optional[str],
    ) -> str:
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
                    arguments = {"description": desc, "query": message}
                else:
                    arguments = {"query": message}
                argument_text = json.dumps(arguments, separators=(",", ":"))
                return self._run_agent_tool(
                    recorder,
                    best_match,
                    arguments,
                    message,
                    parent_id,
                    parse_success=True,
                    argument_text=argument_text,
                    route="provider-error-fallback",
                    route_score=best_score,
                )
        
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
        self.version = __version__
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

def _require_show_and_tell_consent(store, purpose, prompt):
    from openrappter.show_and_tell import request_interactive_consent

    return request_interactive_consent(store, purpose, prompt)


def _print_show_and_tell_result(raw):
    try:
        parsed = json.loads(raw)
        print(json.dumps(parsed, indent=2))
        return parsed.get("status") != "error"
    except (json.JSONDecodeError, TypeError):
        print(raw)
        return True


def _handle_show_and_tell_command(args):
    from openrappter.agents.show_and_tell_agent import ShowAndTellAgent
    from openrappter.show_and_tell import ShowAndTellStore

    agent = ShowAndTellAgent(local_surface=True)
    store = ShowAndTellStore()
    command = args.show_command
    kwargs = {"action": command, "session_id": getattr(args, "session", None)}

    if command == "start":
        kwargs.update(
            {
                "title": args.title,
                "intent": args.intent,
                "poll_interval_ms": args.poll,
                "max_duration_ms": args.max_minutes * 60_000,
                "consent_token": _require_show_and_tell_consent(
                    store,
                    "start",
                    "Start recording active app/window changes? Screenshots are "
                    "explicit-only. Avoid passwords, tokens, and private material.",
                ),
            }
        )
    elif command == "note":
        kwargs["note"] = args.text
    elif command == "observe":
        kwargs.update(
            {
                "detail": args.detail,
                "title": args.title,
                "app": args.app,
                "url": args.url,
            }
        )
    elif command == "capture":
        kwargs["title"] = args.label
        kwargs["consent_token"] = _require_show_and_tell_consent(
            store,
            "capture",
            "Capture the currently active window as a local reference frame?",
        )
    elif command == "analyze" and args.enhance:
        kwargs["enhance"] = True
        kwargs["consent_token"] = _require_show_and_tell_consent(
            store,
            "analyze",
            "Send the privacy-safe textual summary to a connected model? "
            "Raw screenshots are never sent.",
        )
    elif command in {"review", "approve"}:
        kwargs.update(
            {
                "action": "review",
                "title": args.title,
                "intent": args.intent,
                "feedback": args.feedback,
                "steps_json": (
                    Path(args.steps).read_text(encoding="utf-8")
                    if args.steps
                    else None
                ),
            }
        )
        if command == "approve":
            kwargs.update(
                {
                    "approve": True,
                    "consent_token": _require_show_and_tell_consent(
                        store,
                        "approve",
                        "Approve this analysis as the exact source for a reusable "
                        "skill or automation?",
                    ),
                }
            )
    elif command == "build":
        kwargs["target"] = args.target
    elif command == "delete":
        kwargs["consent_token"] = _require_show_and_tell_consent(
            store,
            "delete",
            f"Permanently delete "
            f"{f'session {args.session}' if args.session else 'the latest session'} "
            "and its local frames?",
        )
    elif command is None:
        raise RuntimeError(
            "Usage: openrappter show-and-tell "
            "[start|status|note|observe|capture|stop|analyze|review|approve|"
            "build|replay|test|list|delete]"
        )

    return _print_show_and_tell_result(agent.execute(**kwargs))


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
  python openrappter.py --gateway           Run the HTTP/WebSocket gateway (foreground)

Environment:
  OPENRAPPTER_LOG_FORMAT=json  Emit gateway lifecycle/request logs as
                                structured JSON lines (timestamp, level,
                                component, event, safe numeric fields)
                                instead of human-readable text. Off by
                                default; never logs method names, user
                                input, tokens, or stack traces.
  OPENRAPPTER_GATEWAY_TRUSTED_ORIGINS
                               Comma-separated browser origins allowed to
                               connect cross-origin when gateway token auth
                               is enabled.
""",
    )
    parser.add_argument("--version", "-v", action="version", version=f"{orchestrator.name} {orchestrator.version}")
    parser.add_argument("--task", "-t", help="Run a single task via chat")
    parser.add_argument("--status", "-s", action="store_true", help="Show status")
    parser.add_argument("--list-agents", "-l", action="store_true", help="List available agents")
    parser.add_argument("--exec", "-e", nargs=2, metavar=('AGENT', 'QUERY'), help="Execute specific agent")
    parser.add_argument("--gateway", "-g", action="store_true",
                         help="Run the HTTP/WebSocket gateway server in the foreground")
    parser.add_argument("--gateway-host", default="127.0.0.1", metavar="HOST",
                         help="Gateway bind host (default: 127.0.0.1 — loopback only)")
    parser.add_argument("--gateway-port", type=int, default=18790, metavar="PORT",
                         help="Gateway bind port (default: 18790)")
    parser.add_argument("--gateway-token", default=None, metavar="TOKEN",
                         help="Gateway auth token (required to bind to a non-loopback host; "
                              "falls back to OPENRAPPTER_GATEWAY_TOKEN env var)")
    parser.add_argument(
        "--gateway-trusted-origin",
        action="append",
        default=None,
        metavar="ORIGIN",
        help="Browser origin allowed to connect cross-origin; repeatable and requires "
             "gateway token auth",
    )

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

    # Show-and-Tell commands
    show_parser = subparsers.add_parser(
        'show-and-tell',
        help='Learn a reusable workflow from a local demonstration',
    )
    show_sub = show_parser.add_subparsers(dest='show_command')

    show_start = show_sub.add_parser('start', help='Start a local demonstration')
    show_start.add_argument('--title', default='', help='Short session title')
    show_start.add_argument('--intent', default='', help='Goal being demonstrated')
    show_start.add_argument('--poll', type=int, default=2000, help='Poll interval in ms')
    show_start.add_argument(
        '--max-minutes', type=int, default=480, help='Maximum recording duration'
    )

    for name, help_text in [
        ('status', 'Show active or latest recording'),
        ('stop', 'Stop a recording'),
        ('replay', 'Preview a safe dry-run replay plan'),
        ('test', 'Validate built artifacts'),
        ('delete', 'Delete a stopped recording'),
    ]:
        command_parser = show_sub.add_parser(name, help=help_text)
        command_parser.add_argument('session', nargs='?', default=None)

    show_analyze = show_sub.add_parser(
        'analyze', help='Reconstruct intent and ordered steps'
    )
    show_analyze.add_argument('session', nargs='?', default=None)
    show_analyze.add_argument(
        '--enhance',
        action='store_true',
        help='Request optional model refinement after separate local consent',
    )

    show_note = show_sub.add_parser('note', help='Add narration')
    show_note.add_argument('text')
    show_note.add_argument('--session', default=None)

    show_observe = show_sub.add_parser('observe', help='Add a semantic step')
    show_observe.add_argument('detail')
    show_observe.add_argument('--session', default=None)
    show_observe.add_argument('--title', default='')
    show_observe.add_argument('--app', default='')
    show_observe.add_argument('--url', default='')

    show_capture = show_sub.add_parser('capture', help='Capture an explicit frame')
    show_capture.add_argument('--session', default=None)
    show_capture.add_argument('--label', default='')

    for name, help_text in [
        ('review', 'Edit the draft analysis'),
        ('approve', 'Approve the reviewed analysis'),
    ]:
        command_parser = show_sub.add_parser(name, help=help_text)
        command_parser.add_argument('session', nargs='?', default=None)
        command_parser.add_argument('--title', default=None)
        command_parser.add_argument('--intent', default=None)
        command_parser.add_argument('--feedback', default=None)
        command_parser.add_argument('--steps', default=None)

    show_build = show_sub.add_parser('build', help='Build an approved artifact')
    show_build.add_argument('session', nargs='?', default=None)
    show_build.add_argument(
        '--target', choices=['skill', 'automation', 'all'], default='skill'
    )

    show_sub.add_parser('list', help='List recorded demonstrations')
    
    args = parser.parse_args()

    # Run the HTTP/WebSocket gateway server in the foreground
    if args.gateway:
        import asyncio
        from openrappter.gateway import GatewayServer
        from openrappter.gateway.observability import log_gateway_lifecycle

        orchestrator.initialize()
        token = args.gateway_token or os.environ.get("OPENRAPPTER_GATEWAY_TOKEN")
        trusted_origins = args.gateway_trusted_origin
        if trusted_origins is None:
            trusted_origins = [
                origin.strip()
                for origin in os.environ.get(
                    "OPENRAPPTER_GATEWAY_TRUSTED_ORIGINS", ""
                ).split(",")
                if origin.strip()
            ]

        try:
            server = GatewayServer(
                agent_registry=orchestrator.registry,
                host=args.gateway_host,
                port=args.gateway_port,
                token=token,
                trusted_origins=trusted_origins,
                version=orchestrator.version,
            )
        except ValueError as e:
            print(f"Gateway configuration error: {e}")
            sys.exit(1)

        auth_state = "enabled" if server.auth_enabled else "disabled (loopback only)"
        print(f"{orchestrator.emoji} Starting gateway on {args.gateway_host}:{args.gateway_port} (auth {auth_state})")
        print("Press Ctrl+C to stop.")
        # Opt-in structured log (OPENRAPPTER_LOG_FORMAT=json) alongside the
        # human-readable prints above — never replaces them, and never logs
        # the auth token itself.
        log_gateway_lifecycle(
            "cli", "gateway.start", f"Starting gateway on {args.gateway_host}:{args.gateway_port}",
            {"host": args.gateway_host, "port": args.gateway_port, "auth_enabled": server.auth_enabled},
        )

        try:
            asyncio.run(server.run_forever())
        except KeyboardInterrupt:
            pass
        return

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

    if args.command == 'show-and-tell':
        try:
            if not _handle_show_and_tell_command(args):
                raise SystemExit(1)
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
            print(json.dumps({"status": "error", "message": str(exc)}, indent=2))
            raise SystemExit(1)
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
