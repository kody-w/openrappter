"""
AgentGraph - DAG (directed acyclic graph) executor for parallel agent pipelines.

Extends the agent chain concept to support arbitrary dependency graphs.
Nodes whose dependencies are all satisfied execute concurrently — no idle
waiting when work can proceed in parallel.

When a node has multiple dependencies, all their data_slush outputs are
merged into a combined upstream_slush keyed by node name:

    upstream_slush = { nodeA: { ...slushA }, nodeB: { ...slushB } }

Mirrors TypeScript agents/graph.ts
"""

import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class GraphNode:
    """A node in the DAG."""
    name: str
    agent: Any
    kwargs: Optional[dict] = None
    depends_on: Optional[list] = None


@dataclass
class GraphNodeResult:
    """Result of executing a single graph node."""
    name: str
    agent_name: str
    result: dict
    data_slush: Optional[dict]
    duration_ms: int
    status: str  # 'success', 'error', 'skipped'


@dataclass
class GraphResult:
    """Result of executing the full graph."""
    status: str  # 'success', 'partial', 'error'
    nodes: dict  # name -> GraphNodeResult
    execution_order: list
    total_duration_ms: int
    error: Optional[str] = None


class AgentGraph:
    """DAG executor for parallel agent pipelines."""

    def __init__(self, options=None):
        options = options or {}
        self._nodes = {}  # name -> GraphNode (ordered dict in Python 3.7+)
        self._node_timeout = options.get('node_timeout')
        self._stop_on_error = options.get('stop_on_error', False)
        self._parallel = options.get('parallel', True)

    def add_node(self, node=None, *, name=None, agent=None, kwargs=None, depends_on=None):
        """Add a node to the graph. Returns self for fluent chaining.

        Can be called with a GraphNode object or with keyword arguments.
        """
        if node is None:
            node = GraphNode(name=name, agent=agent, kwargs=kwargs, depends_on=depends_on)
        if node.name in self._nodes:
            raise ValueError(f'AgentGraph: duplicate node name "{node.name}"')
        self._nodes[node.name] = node
        return self

    def get_node_names(self):
        """Get all node names."""
        return list(self._nodes.keys())

    @property
    def length(self):
        """Get the number of nodes."""
        return len(self._nodes)

    def validate(self):
        """Validate the graph: check for missing dependencies and cycles."""
        errors = []

        # Check that all referenced dependencies exist
        for name, node in self._nodes.items():
            for dep in (node.depends_on or []):
                if dep not in self._nodes:
                    errors.append(f'Node "{name}" depends on "{dep}", which does not exist')

        # Detect cycles using DFS (three-color algorithm)
        WHITE, GRAY, BLACK = 0, 1, 2
        color = {name: WHITE for name in self._nodes}

        def dfs(name, stack):
            color[name] = GRAY
            stack.append(name)

            node = self._nodes[name]
            for dep in (node.depends_on or []):
                if dep not in self._nodes:
                    continue  # already reported as missing
                if color[dep] == GRAY:
                    cycle_start = stack.index(dep)
                    cycle = ' → '.join(stack[cycle_start:] + [dep])
                    errors.append(f'Cycle detected: {cycle}')
                    return True
                if color[dep] == WHITE:
                    if dfs(dep, stack):
                        return True

            stack.pop()
            color[name] = BLACK
            return False

        for name in self._nodes:
            if color[name] == WHITE:
                dfs(name, [])

        return {'valid': len(errors) == 0, 'errors': errors}

    def run(self, initial_kwargs=None):
        """Execute the DAG. Nodes at each topological level run concurrently."""
        validation = self.validate()
        if not validation['valid']:
            raise ValueError(f"AgentGraph validation failed:\n" + '\n'.join(validation['errors']))

        graph_start = time.time()
        node_results = {}
        execution_order = []
        skipped = set()

        # Compute topological levels using Kahn's algorithm
        levels = self._topological_levels()

        for level in levels:
            # Check if stopOnError was triggered in a previous level
            if self._stop_on_error and self._has_error(node_results):
                for name in level:
                    if name not in node_results:
                        node_results[name] = self._make_skipped(name)
                        execution_order.append(name)
                continue

            # Determine which nodes in this level should run vs. be skipped
            to_run = []
            for name in level:
                if self._should_skip(name, skipped, node_results):
                    skipped.add(name)
                    node_results[name] = self._make_skipped(name)
                    execution_order.append(name)
                else:
                    to_run.append(name)

            if not to_run:
                continue

            # Execute all runnable nodes in this level
            if self._parallel and not self._stop_on_error and len(to_run) > 1:
                # Parallel execution via ThreadPoolExecutor
                level_results = {}
                with ThreadPoolExecutor(max_workers=len(to_run)) as executor:
                    futures = {
                        executor.submit(self._execute_node, name, node_results, initial_kwargs): name
                        for name in to_run
                    }
                    for future in as_completed(futures):
                        name = futures[future]
                        level_results[name] = future.result()

                # Process results in stable order
                for name in to_run:
                    result = level_results[name]
                    node_results[name] = result
                    execution_order.append(name)
                    if result.status == 'error':
                        self._collect_dependents(name, skipped)
            else:
                # Sequential execution (stop_on_error needs per-node checking, or parallel=False)
                for name in to_run:
                    result = self._execute_node(name, node_results, initial_kwargs)
                    node_results[name] = result
                    execution_order.append(name)

                    if result.status == 'error':
                        if self._stop_on_error:
                            # Mark all remaining unexecuted nodes as skipped
                            for remaining_name in self._nodes:
                                if remaining_name not in node_results:
                                    node_results[remaining_name] = self._make_skipped(remaining_name)
                                    execution_order.append(remaining_name)
                            return GraphResult(
                                status='error',
                                nodes=node_results,
                                execution_order=execution_order,
                                total_duration_ms=int((time.time() - graph_start) * 1000),
                                error=result.result.get('message', 'A node failed'),
                            )
                        else:
                            # Mark all transitive dependents as skipped
                            self._collect_dependents(name, skipped)

        has_errors = any(r.status == 'error' for r in node_results.values())
        has_skipped = any(r.status == 'skipped' for r in node_results.values())

        return GraphResult(
            status='partial' if (has_errors or has_skipped) else 'success',
            nodes=node_results,
            execution_order=execution_order,
            total_duration_ms=int((time.time() - graph_start) * 1000),
        )

    def _topological_levels(self):
        """Compute topological levels using Kahn's algorithm."""
        in_degree = {name: 0 for name in self._nodes}
        dependents = {name: [] for name in self._nodes}

        for name, node in self._nodes.items():
            for dep in (node.depends_on or []):
                if dep in self._nodes:
                    in_degree[name] = in_degree.get(name, 0) + 1
                    dependents[dep].append(name)

        levels = []
        current_level = [name for name, deg in in_degree.items() if deg == 0]

        while current_level:
            levels.append(current_level)
            next_level = []
            for name in current_level:
                for dependent in dependents.get(name, []):
                    in_degree[dependent] -= 1
                    if in_degree[dependent] == 0:
                        next_level.append(dependent)
            current_level = next_level

        return levels

    def _execute_node(self, name, completed, initial_kwargs=None):
        """Execute a single node, building its kwargs from static config + upstream slush."""
        node = self._nodes[name]
        node_start = time.time()

        # Build kwargs: initial (for root nodes) + static node kwargs
        is_root = not (node.depends_on or [])
        kwargs = {}
        if is_root and initial_kwargs:
            kwargs.update(initial_kwargs)
        if node.kwargs:
            kwargs.update(node.kwargs)

        # Merge upstream slush from all dependencies
        deps = node.depends_on or []
        if deps:
            upstream_slush = {}
            for dep in deps:
                dep_result = completed.get(dep)
                if dep_result and dep_result.data_slush:
                    upstream_slush[dep] = dep_result.data_slush
            if upstream_slush:
                kwargs['upstream_slush'] = upstream_slush

        try:
            result_str = node.agent.execute(**kwargs)
            duration_ms = int((time.time() - node_start) * 1000)

            try:
                result = json.loads(result_str) if isinstance(result_str, str) else result_str
            except (json.JSONDecodeError, TypeError):
                result = {'status': 'success', 'raw': result_str}

            data_slush = node.agent.last_data_slush
            if not data_slush:
                data_slush = node.agent.slush_out(
                    signals={'node_name': name, 'node_result_status': result.get('status', 'unknown')},
                )

            return GraphNodeResult(
                name=name,
                agent_name=node.agent.name,
                result=result,
                data_slush=data_slush,
                duration_ms=duration_ms,
                status='success',
            )

        except Exception as e:
            duration_ms = int((time.time() - node_start) * 1000)
            error_result = {'status': 'error', 'message': str(e)}

            return GraphNodeResult(
                name=name,
                agent_name=node.agent.name,
                result=error_result,
                data_slush=None,
                duration_ms=duration_ms,
                status='error',
            )

    def _should_skip(self, name, skipped, completed):
        """Determine whether a node should be skipped."""
        node = self._nodes[name]
        for dep in (node.depends_on or []):
            if dep in skipped:
                return True
            dep_result = completed.get(dep)
            if dep_result and dep_result.status == 'error':
                return True
        return False

    def _collect_dependents(self, failed_name, skipped):
        """Recursively collect all transitive dependents of a failed node."""
        for name, node in self._nodes.items():
            if name not in skipped and failed_name in (node.depends_on or []):
                skipped.add(name)
                self._collect_dependents(name, skipped)

    def _has_error(self, node_results):
        """Check whether any completed node has an error status."""
        return any(r.status == 'error' for r in node_results.values())

    def _make_skipped(self, name):
        """Build a skipped GraphNodeResult for a node that was not executed."""
        node = self._nodes[name]
        return GraphNodeResult(
            name=name,
            agent_name=node.agent.name,
            result={'status': 'info', 'message': 'skipped'},
            data_slush=None,
            duration_ms=0,
            status='skipped',
        )


def create_agent_graph(options=None):
    """Factory function to create an AgentGraph."""
    return AgentGraph(options)
