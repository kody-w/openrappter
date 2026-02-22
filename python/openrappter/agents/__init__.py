"""
openrappter Agents Package

This package contains rapp agents following the CommunityRAPP pattern.
Agents are automatically discovered and loaded by the main openrappter.py orchestrator.

Core Agents:
- ManageMemory: Store facts, preferences, insights, and tasks
- ContextMemory: Recall and search stored memories
- Shell: Execute commands and file operations
- LearnNew: Generate new agents from descriptions (hot-loaded)
"""

from openrappter.agents.basic_agent import BasicAgent
from openrappter.agents.chain import AgentChain, create_agent_chain
from openrappter.agents.graph import AgentGraph, GraphNode, create_agent_graph
from openrappter.agents.tracer import AgentTracer, TraceSpan, TraceContext, create_tracer, global_tracer

__all__ = [
    'BasicAgent',
    'AgentChain',
    'create_agent_chain',
    'AgentGraph',
    'GraphNode',
    'create_agent_graph',
    'AgentTracer',
    'TraceSpan',
    'TraceContext',
    'create_tracer',
    'global_tracer',
]
