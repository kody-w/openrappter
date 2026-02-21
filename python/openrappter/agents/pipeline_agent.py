"""
PipelineAgent - Declarative multi-agent pipeline runner.

Runs a sequence of agent steps with support for:
- Sequential agent execution with data_slush threading
- Parallel fan-out across multiple agents
- Conditional steps based on slush field values
- Loop steps with iteration limits
- Per-step error handling (stop/continue/skip)

Actions: run, validate, status

Mirrors TypeScript agents/PipelineAgent.ts
"""

import asyncio
import json
import time
from datetime import datetime

from openrappter.agents.basic_agent import BasicAgent


class PipelineAgent(BasicAgent):
    def __init__(self, agent_resolver=None):
        self.name = 'Pipeline'
        self.metadata = {
            "name": self.name,
            "description": "Declarative multi-agent pipeline runner. Chains agents sequentially with data_slush threading, parallel fan-out, conditional branching, and loop steps.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "The action to perform.",
                        "enum": ["run", "validate", "status"]
                    },
                    "spec": {
                        "type": "object",
                        "description": "Pipeline specification with name, steps, and input."
                    }
                },
                "required": []
            }
        }
        super().__init__(name=self.name, metadata=self.metadata)
        self._agent_resolver = agent_resolver
        self._last_pipeline_result = None

    def set_agent_resolver(self, resolver):
        """Set the agent resolver function."""
        self._agent_resolver = resolver

    def perform(self, **kwargs):
        action = kwargs.get('action')

        if not action:
            return json.dumps({
                "status": "error",
                "message": "No action specified. Use: run, validate, or status"
            })

        try:
            if action == 'run':
                return self._run_pipeline(kwargs)
            elif action == 'validate':
                return self._validate_pipeline(kwargs)
            elif action == 'status':
                return self._get_status()
            else:
                return json.dumps({
                    "status": "error",
                    "message": f"Unknown action: {action}"
                })
        except Exception as e:
            return json.dumps({
                "status": "error",
                "action": action,
                "message": str(e)
            })

    def _run_pipeline(self, kwargs):
        """Run a pipeline synchronously (uses asyncio.run internally for parallel steps)."""
        spec = kwargs.get('spec')

        if not spec or not spec.get('name') or not spec.get('steps'):
            return json.dumps({
                "status": "error",
                "message": "spec with name and steps is required for run"
            })

        if not self._agent_resolver:
            return json.dumps({
                "status": "error",
                "message": "No agent resolver configured"
            })

        pipeline_start = time.time()
        step_results = []
        last_slush = None
        pipeline_status = 'completed'
        last_result = ''
        pipeline_input = spec.get('input', {})

        for step in spec['steps']:
            on_error = step.get('onError', 'stop')

            try:
                results = self._execute_step(step, pipeline_input, last_slush)

                for result in results:
                    step_results.append(result)
                    last_result = result.get('result', '')

                    if result.get('dataSlush'):
                        last_slush = result['dataSlush']

                    if result.get('status') == 'error':
                        if on_error == 'stop':
                            pipeline_status = 'failed'
                            return self._build_result(
                                spec['name'], pipeline_start, step_results,
                                last_result, pipeline_status, last_slush
                            )
                        elif on_error == 'continue':
                            pipeline_status = 'partial'

            except Exception as e:
                error_result = {
                    'stepId': step.get('id', ''),
                    'agentName': step.get('agent', step.get('agents', ['unknown'])[0] if isinstance(step.get('agents'), list) else 'unknown'),
                    'status': 'error',
                    'result': str(e),
                    'dataSlush': None,
                    'latencyMs': 0,
                }
                step_results.append(error_result)

                if on_error == 'stop':
                    pipeline_status = 'failed'
                    return self._build_result(
                        spec['name'], pipeline_start, step_results,
                        str(e), pipeline_status, last_slush
                    )
                elif on_error == 'continue':
                    pipeline_status = 'partial'

        return self._build_result(
            spec['name'], pipeline_start, step_results,
            last_result, pipeline_status, last_slush
        )

    def _execute_step(self, step, pipeline_input, last_slush):
        """Execute a single pipeline step."""
        step_type = step.get('type')

        if step_type == 'agent':
            return [self._execute_agent_step(step, pipeline_input, last_slush)]
        elif step_type == 'parallel':
            return self._execute_parallel_step(step, pipeline_input, last_slush)
        elif step_type == 'conditional':
            return [self._execute_conditional_step(step, pipeline_input, last_slush)]
        elif step_type == 'loop':
            return self._execute_loop_step(step, pipeline_input, last_slush)
        else:
            raise ValueError(f"Unknown step type: {step_type}")

    def _execute_agent_step(self, step, pipeline_input, last_slush):
        """Execute a single agent step."""
        agent_name = step.get('agent')
        if not agent_name:
            raise ValueError(f"Step {step.get('id', '?')}: agent name is required for agent step")

        agent = self._agent_resolver(agent_name)
        if not agent:
            raise ValueError(f"Step {step.get('id', '?')}: agent not found: {agent_name}")

        input_data = dict(pipeline_input)
        input_data.update(step.get('input', {}))
        if last_slush:
            input_data['upstream_slush'] = last_slush

        start_time = time.time()
        result = agent.execute(**input_data)
        latency_ms = int((time.time() - start_time) * 1000)

        data_slush = None
        try:
            parsed = json.loads(result) if isinstance(result, str) else result
            if isinstance(parsed, dict) and 'data_slush' in parsed:
                data_slush = parsed['data_slush']
        except (json.JSONDecodeError, TypeError):
            pass

        return {
            'stepId': step.get('id', ''),
            'agentName': agent_name,
            'status': 'success',
            'result': result if isinstance(result, str) else json.dumps(result),
            'dataSlush': data_slush,
            'latencyMs': latency_ms,
        }

    def _execute_parallel_step(self, step, pipeline_input, last_slush):
        """Execute multiple agents in parallel using asyncio."""
        agents = step.get('agents', [])
        if not agents:
            raise ValueError(f"Step {step.get('id', '?')}: agents array is required for parallel step")

        results = []
        for agent_name in agents:
            sub_step = dict(step)
            sub_step['agent'] = agent_name
            sub_step['type'] = 'agent'
            results.append(self._execute_agent_step(sub_step, pipeline_input, last_slush))

        return results

    def _execute_conditional_step(self, step, pipeline_input, last_slush):
        """Execute a conditional step."""
        condition = step.get('condition')
        if not condition:
            raise ValueError(f"Step {step.get('id', '?')}: condition is required for conditional step")

        if not self._evaluate_condition(condition, last_slush):
            return {
                'stepId': step.get('id', ''),
                'agentName': step.get('agent', 'conditional'),
                'status': 'skipped',
                'result': 'Condition not met',
                'dataSlush': None,
                'latencyMs': 0,
            }

        if not step.get('agent'):
            raise ValueError(f"Step {step.get('id', '?')}: agent name is required when condition is met")

        return self._execute_agent_step(step, pipeline_input, last_slush)

    def _execute_loop_step(self, step, pipeline_input, last_slush):
        """Execute a loop step with iteration limit."""
        if not step.get('agent'):
            raise ValueError(f"Step {step.get('id', '?')}: agent name is required for loop step")

        max_iterations = step.get('maxIterations', 5)
        results = []
        current_slush = last_slush

        for i in range(max_iterations):
            result = self._execute_agent_step(step, pipeline_input, current_slush)
            results.append(result)

            if result.get('dataSlush'):
                current_slush = result['dataSlush']

            # Check exit condition if defined
            if step.get('condition') and self._evaluate_condition(step['condition'], current_slush):
                break

        return results

    def _evaluate_condition(self, condition, slush):
        """Evaluate a condition against slush data."""
        if not slush:
            return False

        value = self._get_field_value(slush, condition.get('field', ''))

        if 'exists' in condition:
            return (value is not None) if condition['exists'] else (value is None)

        if 'equals' in condition:
            return value == condition['equals']

        return value is not None

    def _get_field_value(self, obj, field):
        """Get a nested field value using dot notation."""
        parts = field.split('.')
        current = obj
        for part in parts:
            if isinstance(current, dict) and part in current:
                current = current[part]
            else:
                return None
        return current

    def _validate_pipeline(self, kwargs):
        """Validate a pipeline specification."""
        spec = kwargs.get('spec')

        if not spec:
            return json.dumps({
                "status": "error",
                "message": "spec is required for validate"
            })

        errors = []

        if not spec.get('name'):
            errors.append('Pipeline name is required')

        steps = spec.get('steps')
        if not steps or not isinstance(steps, list) or len(steps) == 0:
            errors.append('Pipeline must have at least one step')
        else:
            for step in steps:
                if not step.get('id'):
                    errors.append('Each step must have an id')
                if not step.get('type'):
                    errors.append(f"Step {step.get('id', '?')}: type is required")

                if step.get('type') == 'agent' and not step.get('agent'):
                    errors.append(f"Step {step.get('id')}: agent name is required for agent step")

                if step.get('type') == 'parallel' and not step.get('agents'):
                    errors.append(f"Step {step.get('id')}: agents array is required for parallel step")

                if step.get('type') == 'conditional' and not step.get('condition'):
                    errors.append(f"Step {step.get('id')}: condition is required for conditional step")

                if step.get('type') == 'loop' and not step.get('agent'):
                    errors.append(f"Step {step.get('id')}: agent name is required for loop step")

                # Resolve agent names if resolver available
                if self._agent_resolver:
                    agent_names = [step['agent']] if step.get('agent') else (step.get('agents') or [])
                    for name in agent_names:
                        if not self._agent_resolver(name):
                            errors.append(f"Step {step.get('id')}: agent not found: {name}")

        if errors:
            return json.dumps({
                "status": "error",
                "action": "validate",
                "valid": False,
                "errors": errors,
            })

        return json.dumps({
            "status": "success",
            "action": "validate",
            "valid": True,
            "stepCount": len(spec.get('steps', [])),
        })

    def _get_status(self):
        """Return status of last pipeline run."""
        if not self._last_pipeline_result:
            return json.dumps({
                "status": "success",
                "action": "status",
                "message": "No pipeline has been run yet",
            })

        return json.dumps({
            "status": "success",
            "action": "status",
            "lastRun": self._last_pipeline_result,
        })

    def _build_result(self, pipeline_name, start_time, step_results, last_result, pipeline_status, last_slush):
        """Build the pipeline result response."""
        total_latency_ms = int((time.time() - start_time) * 1000)

        pipeline_result = {
            'pipelineName': pipeline_name,
            'timestamp': datetime.now().isoformat(),
            'steps': step_results,
            'finalResult': last_result,
            'totalLatencyMs': total_latency_ms,
            'status': pipeline_status,
        }

        self._last_pipeline_result = pipeline_result

        data_slush = self.slush_out(
            signals={
                'pipeline_name': pipeline_name,
                'step_count': len(step_results),
                'pipeline_status': pipeline_status,
            },
            **({"pipeline_slush": last_slush} if last_slush else {}),
        )

        return json.dumps({
            "status": "error" if pipeline_status == 'failed' else "success",
            "action": "run",
            "pipeline": pipeline_result,
            "data_slush": data_slush,
        })
