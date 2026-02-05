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

__all__ = ['BasicAgent']
