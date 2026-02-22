"""
AgentChain - Sequential agent pipeline with automatic data_slush forwarding.

Chains agents together so the output of one feeds into the next.
Each step's data_slush is automatically passed as upstream_slush
to the next step - no manual wiring needed.

Mirrors TypeScript agents/chain.ts
"""

import json
import time
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Optional


@dataclass
class ChainStep:
    """A single step in the chain."""
    name: str
    agent: Any
    kwargs: Optional[dict] = None
    transform: Optional[Callable] = None


@dataclass
class ChainStepResult:
    """Result of executing a single chain step."""
    name: str
    agent_name: str
    result: dict
    data_slush: Optional[dict]
    duration_ms: int


@dataclass
class ChainResult:
    """Result of executing the full chain."""
    status: str  # 'success', 'partial', 'error'
    steps: list
    total_duration_ms: int
    final_result: Optional[dict]
    final_slush: Optional[dict]
    failed_step: Optional[str] = None
    error: Optional[str] = None


class AgentChain:
    """Sequential agent pipeline with automatic data_slush forwarding."""

    def __init__(self, options=None):
        options = options or {}
        self._steps = []
        self._stop_on_error = options.get('stop_on_error', True)
        self._step_timeout = options.get('step_timeout')

    def add_step(self, name, agent, kwargs=None, transform=None):
        """Add a step to the chain. Returns self for fluent chaining."""
        self._steps.append(ChainStep(
            name=name,
            agent=agent,
            kwargs=kwargs,
            transform=transform,
        ))
        return self

    def run(self, initial_kwargs=None):
        """Execute the chain. Each step's data_slush flows to the next."""
        step_results = []
        current_slush = None
        last_result = None
        chain_start = time.time()

        for i, step in enumerate(self._steps):
            step_start = time.time()

            # Build kwargs: static step kwargs + upstream slush + optional transform
            kwargs = dict(step.kwargs or {})

            # Merge initial kwargs only for the first step
            if i == 0 and initial_kwargs:
                merged = dict(initial_kwargs)
                merged.update(kwargs)
                kwargs = merged

            # Apply transform from previous step
            if step.transform and last_result is not None:
                transformed = step.transform(last_result, current_slush)
                kwargs.update(transformed)

            # Inject upstream slush
            if current_slush is not None:
                kwargs['upstream_slush'] = current_slush

            try:
                result_str = self._execute_with_timeout(step.agent, kwargs)
                duration_ms = int((time.time() - step_start) * 1000)

                try:
                    result = json.loads(result_str) if isinstance(result_str, str) else result_str
                except (json.JSONDecodeError, TypeError):
                    result = {'status': 'success', 'raw': result_str}

                # Extract data_slush from result
                data_slush = step.agent.last_data_slush
                if data_slush:
                    current_slush = data_slush
                else:
                    current_slush = step.agent.slush_out(
                        signals={'step_name': step.name, 'step_result_status': result.get('status', 'unknown')},
                    )

                last_result = result

                step_results.append(ChainStepResult(
                    name=step.name,
                    agent_name=step.agent.name,
                    result=result,
                    data_slush=current_slush,
                    duration_ms=duration_ms,
                ))

            except Exception as e:
                duration_ms = int((time.time() - step_start) * 1000)
                error_result = {'status': 'error', 'message': str(e)}

                step_results.append(ChainStepResult(
                    name=step.name,
                    agent_name=step.agent.name,
                    result=error_result,
                    data_slush=current_slush,
                    duration_ms=duration_ms,
                ))

                if self._stop_on_error:
                    return ChainResult(
                        status='error',
                        steps=step_results,
                        total_duration_ms=int((time.time() - chain_start) * 1000),
                        final_result=error_result,
                        final_slush=current_slush,
                        failed_step=step.name,
                        error=str(e),
                    )

        has_errors = any(s.result.get('status') == 'error' for s in step_results)

        return ChainResult(
            status='partial' if has_errors else 'success',
            steps=step_results,
            total_duration_ms=int((time.time() - chain_start) * 1000),
            final_result=last_result,
            final_slush=current_slush,
        )

    def get_step_names(self):
        """Get the step names in order."""
        return [s.name for s in self._steps]

    @property
    def length(self):
        """Get the number of steps."""
        return len(self._steps)

    def _execute_with_timeout(self, agent, kwargs):
        """Execute agent with optional timeout."""
        if not self._step_timeout:
            return agent.execute(**kwargs)

        result = [None]
        error = [None]

        def run():
            try:
                result[0] = agent.execute(**kwargs)
            except Exception as e:
                error[0] = e

        thread = threading.Thread(target=run)
        thread.start()
        thread.join(timeout=self._step_timeout / 1000)

        if thread.is_alive():
            raise TimeoutError(f"Step timeout after {self._step_timeout}ms")

        if error[0] is not None:
            raise error[0]

        return result[0]


def create_agent_chain(options=None):
    """Factory function to create an AgentChain."""
    return AgentChain(options)
