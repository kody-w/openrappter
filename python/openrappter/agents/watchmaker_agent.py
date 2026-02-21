"""
WatchmakerAgent - Self-evolving agent ecosystem manager.

Evaluates agent capabilities, A/B tests competing versions, and promotes
winners. Natural selection for software: external processes produce
candidate mutations; the Watchmaker decides which survive.

Actions:
  register - Add an agent version to a slot
  evaluate - Score an agent version with test cases
  compare  - A/B test two versions
  promote  - Swap a candidate into the active slot
  cycle    - Full evolution loop
  status   - Current state of a slot (or all slots)
  history  - Evaluation and promotion history

Flow (cycle action):
  1. Evaluate all active agents with test cases
  2. For each slot with candidates, compare active vs candidate
  3. Auto-promote candidates that beat active
  4. Return full CycleResult audit trail

Mirrors TypeScript agents/WatchmakerAgent.ts
"""

import json
import time
from datetime import datetime

from openrappter.agents.basic_agent import BasicAgent


class WatchmakerAgent(BasicAgent):
    def __init__(self):
        self.name = 'Watchmaker'
        self.metadata = {
            "name": self.name,
            "description": "Self-evolving agent ecosystem manager. Evaluates agent capabilities, A/B tests competing versions, and promotes winners.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "The action to perform.",
                        "enum": ["evaluate", "compare", "register", "promote", "cycle", "status", "history"]
                    },
                    "agent": {
                        "type": "string",
                        "description": "Agent name (slot key)."
                    },
                    "version": {
                        "type": "string",
                        "description": "Version identifier."
                    },
                    "versionA": {
                        "type": "string",
                        "description": "Version A for comparison."
                    },
                    "versionB": {
                        "type": "string",
                        "description": "Version B for comparison."
                    },
                    "testCases": {
                        "type": "array",
                        "description": "Test inputs for evaluation.",
                        "items": {"type": "object"}
                    },
                    "reason": {
                        "type": "string",
                        "description": "Promotion reason."
                    }
                },
                "required": []
            }
        }
        super().__init__(name=self.name, metadata=self.metadata)

        self._slots = {}           # name -> AgentSlot dict
        self._eval_history = {}    # name -> list of EvaluationResult dicts
        self._cycle_history = []   # list of CycleResult dicts
        self._default_test_cases = {}  # name -> list of TestCase dicts

    def set_agents(self, agents):
        """Inject agents for testing.

        Args:
            agents: list of dicts with keys: agent (BasicAgent), version (str),
                    source (str, optional: 'manual'|'learnNew'|'mutation')
        """
        for entry in agents:
            agent_instance = entry['agent']
            name = agent_instance.name
            version = entry['version']
            source = entry.get('source', 'manual')

            agent_version = {
                'agent': agent_instance,
                'version': version,
                'registeredAt': datetime.now().isoformat(),
                'source': source,
            }

            if name not in self._slots:
                self._slots[name] = {
                    'name': name,
                    'active': agent_version,
                    'candidates': [],
                    'history': [],
                }
            else:
                self._slots[name]['candidates'].append(agent_version)

            if name not in self._eval_history:
                self._eval_history[name] = []

    def perform(self, **kwargs):
        action = kwargs.get('action')

        if not action:
            return json.dumps({
                "status": "error",
                "message": "No action specified. Use: evaluate, compare, register, promote, cycle, status, or history"
            })

        try:
            if action == 'register':
                return self._register_agent(kwargs)
            elif action == 'evaluate':
                return self._evaluate_agent(kwargs)
            elif action == 'compare':
                return self._compare_agents(kwargs)
            elif action == 'promote':
                return self._promote_agent(kwargs)
            elif action == 'cycle':
                return self._run_cycle(kwargs)
            elif action == 'status':
                return self._get_status(kwargs)
            elif action == 'history':
                return self._get_history(kwargs)
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

    # ── register ────────────────────────────────────────────────────

    def _register_agent(self, kwargs):
        agent_name = kwargs.get('agent')
        version = kwargs.get('version')
        agent_instance = kwargs.get('agentInstance')
        source = kwargs.get('source', 'manual')

        if not agent_name or not version or not agent_instance:
            return json.dumps({
                "status": "error",
                "message": "agent, version, and agentInstance are required for register"
            })

        agent_version = {
            'agent': agent_instance,
            'version': version,
            'registeredAt': datetime.now().isoformat(),
            'source': source,
        }

        if agent_name not in self._eval_history:
            self._eval_history[agent_name] = []

        slot = self._slots.get(agent_name)
        if not slot:
            self._slots[agent_name] = {
                'name': agent_name,
                'active': agent_version,
                'candidates': [],
                'history': [],
            }

            data_slush = self.slush_out(
                signals={'agent_name': agent_name, 'version': version, 'action': 'register'},
                registered='active',
            )

            return json.dumps({
                "status": "success",
                "action": "register",
                "agent": agent_name,
                "version": version,
                "role": "active",
                "message": f"Registered {agent_name} v{version} as active",
                "data_slush": data_slush,
            })

        # Check for duplicate version
        all_versions = [slot['active']] + slot['candidates']
        if any(v['version'] == version for v in all_versions):
            return json.dumps({
                "status": "error",
                "message": f"Version {version} already registered for {agent_name}"
            })

        slot['candidates'].append(agent_version)

        data_slush = self.slush_out(
            signals={'agent_name': agent_name, 'version': version, 'action': 'register'},
            registered='candidate',
        )

        return json.dumps({
            "status": "success",
            "action": "register",
            "agent": agent_name,
            "version": version,
            "role": "candidate",
            "message": f"Registered {agent_name} v{version} as candidate",
            "data_slush": data_slush,
        })

    # ── evaluate ────────────────────────────────────────────────────

    def _evaluate_agent(self, kwargs):
        agent_name = kwargs.get('agent')
        if not agent_name:
            return json.dumps({
                "status": "error",
                "message": "agent name is required for evaluate"
            })

        slot = self._slots.get(agent_name)
        if not slot:
            return json.dumps({
                "status": "error",
                "message": f"Agent not found: {agent_name}"
            })

        target_version = kwargs.get('version')
        if target_version:
            all_versions = [slot['active']] + slot['candidates']
            found = next((v for v in all_versions if v['version'] == target_version), None)
            if not found:
                return json.dumps({
                    "status": "error",
                    "message": f"Version {target_version} not found for {agent_name}"
                })
            agent_version = found
        else:
            agent_version = slot['active']

        test_cases = kwargs.get('testCases') or \
            self._default_test_cases.get(agent_name) or \
            [{'input': {'query': 'health check'}}]

        eval_result = self._run_evaluation(agent_name, agent_version, test_cases)
        self._eval_history[agent_name].append(eval_result)

        data_slush = self.slush_out(
            signals={
                'agent_name': agent_name,
                'version': agent_version['version'],
                'quality': eval_result['quality'],
                'eval_status': eval_result['status'],
            },
        )

        return json.dumps({
            "status": "success",
            "action": "evaluate",
            "evaluation": eval_result,
            "data_slush": data_slush,
        })

    # ── compare ─────────────────────────────────────────────────────

    def _compare_agents(self, kwargs):
        agent_name = kwargs.get('agent')
        version_a = kwargs.get('versionA')
        version_b = kwargs.get('versionB')

        if not agent_name or not version_a or not version_b:
            return json.dumps({
                "status": "error",
                "message": "agent, versionA, and versionB are required for compare"
            })

        slot = self._slots.get(agent_name)
        if not slot:
            return json.dumps({
                "status": "error",
                "message": f"Agent not found: {agent_name}"
            })

        all_versions = [slot['active']] + slot['candidates']
        found_a = next((v for v in all_versions if v['version'] == version_a), None)
        found_b = next((v for v in all_versions if v['version'] == version_b), None)

        if not found_a or not found_b:
            return json.dumps({
                "status": "error",
                "message": f"One or both versions not found: {version_a}, {version_b}"
            })

        test_cases = kwargs.get('testCases') or \
            self._default_test_cases.get(agent_name) or \
            [{'input': {'query': 'health check'}}]

        result_a = self._run_evaluation(agent_name, found_a, test_cases)
        result_b = self._run_evaluation(agent_name, found_b, test_cases)

        comparison = self._build_comparison(agent_name, result_a, result_b)

        return json.dumps({
            "status": "success",
            "action": "compare",
            "comparison": comparison,
        })

    # ── promote ─────────────────────────────────────────────────────

    def _promote_agent(self, kwargs):
        agent_name = kwargs.get('agent')
        version = kwargs.get('version')
        reason = kwargs.get('reason', 'manual promotion')

        if not agent_name or not version:
            return json.dumps({
                "status": "error",
                "message": "agent and version are required for promote"
            })

        slot = self._slots.get(agent_name)
        if not slot:
            return json.dumps({
                "status": "error",
                "message": f"Agent not found: {agent_name}"
            })

        candidate_index = None
        for i, c in enumerate(slot['candidates']):
            if c['version'] == version:
                candidate_index = i
                break

        if candidate_index is None:
            return json.dumps({
                "status": "error",
                "message": f"Version {version} not found in candidates for {agent_name}"
            })

        candidate = slot['candidates'][candidate_index]
        latest_evals = [e for e in self._eval_history.get(agent_name, []) if e['version'] == version]
        quality = latest_evals[-1]['quality'] if latest_evals else 0

        self._do_promotion(slot, candidate, candidate_index, reason, quality)

        data_slush = self.slush_out(
            signals={'agent_name': agent_name, 'promoted_version': version, 'reason': reason},
        )

        return json.dumps({
            "status": "success",
            "action": "promote",
            "agent": agent_name,
            "version": version,
            "reason": reason,
            "message": f"Promoted {agent_name} to v{version}",
            "data_slush": data_slush,
        })

    # ── cycle ───────────────────────────────────────────────────────

    def _run_cycle(self, kwargs):
        test_cases_override = kwargs.get('testCases')
        cycle_result = {
            'timestamp': datetime.now().isoformat(),
            'evaluated': [],
            'comparisons': [],
            'promotions': [],
            'summary': '',
        }

        for name, slot in list(self._slots.items()):
            test_cases = test_cases_override or \
                self._default_test_cases.get(name) or \
                [{'input': {'query': 'health check'}}]

            eval_result = self._run_evaluation(name, slot['active'], test_cases)
            self._eval_history[name].append(eval_result)
            cycle_result['evaluated'].append(eval_result)

            i = 0
            while i < len(slot['candidates']):
                candidate = slot['candidates'][i]
                candidate_eval = self._run_evaluation(name, candidate, test_cases)
                self._eval_history[name].append(candidate_eval)
                cycle_result['evaluated'].append(candidate_eval)

                comparison = self._build_comparison(name, eval_result, candidate_eval)
                cycle_result['comparisons'].append(comparison)

                if comparison['winner'] == 'B':
                    record = self._do_promotion(
                        slot, candidate, i,
                        f"Outperformed active: quality {candidate_eval['quality']} vs {eval_result['quality']}",
                        candidate_eval['quality'],
                    )
                    cycle_result['promotions'].append(record)
                    # Don't increment i since list shifted
                else:
                    i += 1

        evaluated_count = len(cycle_result['evaluated'])
        comparisons_count = len(cycle_result['comparisons'])
        promotions_count = len(cycle_result['promotions'])
        cycle_result['summary'] = (
            f"Evaluated {evaluated_count} versions, "
            f"{comparisons_count} comparisons, "
            f"{promotions_count} promotions"
        )

        self._cycle_history.append(cycle_result)

        data_slush = self.slush_out(
            signals={
                'evaluations_run': evaluated_count,
                'comparisons_run': comparisons_count,
                'promotions_made': promotions_count,
            },
        )

        return json.dumps({
            "status": "success",
            "action": "cycle",
            "cycle": cycle_result,
            "data_slush": data_slush,
        }, default=str)

    # ── status ──────────────────────────────────────────────────────

    def _get_status(self, kwargs):
        agent_name = kwargs.get('agent')

        if not agent_name:
            all_slots = [self._slot_summary(slot) for slot in self._slots.values()]
            return json.dumps({
                "status": "success",
                "action": "status",
                "slots": all_slots,
                "count": len(all_slots),
            })

        slot = self._slots.get(agent_name)
        if not slot:
            return json.dumps({
                "status": "error",
                "message": f"Agent not found: {agent_name}"
            })

        return json.dumps({
            "status": "success",
            "action": "status",
            "slot": self._slot_summary(slot),
        })

    # ── history ─────────────────────────────────────────────────────

    def _get_history(self, kwargs):
        agent_name = kwargs.get('agent')

        if not agent_name:
            return json.dumps({
                "status": "success",
                "action": "history",
                "cycles": self._cycle_history,
                "count": len(self._cycle_history),
            }, default=str)

        slot = self._slots.get(agent_name)
        if not slot:
            return json.dumps({
                "status": "error",
                "message": f"Agent not found: {agent_name}"
            })

        eval_history = self._eval_history.get(agent_name, [])

        return json.dumps({
            "status": "success",
            "action": "history",
            "agent": agent_name,
            "evaluations": eval_history,
            "promotions": slot['history'],
            "evaluationCount": len(eval_history),
            "promotionCount": len(slot['history']),
        })

    # ── Internal helpers ────────────────────────────────────────────

    def _run_evaluation(self, agent_name, agent_version, test_cases):
        checks = []
        start_time = time.time()

        for test_case in test_cases:
            result = None
            parsed = None
            threw = False

            try:
                result = agent_version['agent'].execute(**test_case.get('input', {}))
                if not isinstance(result, str):
                    result = str(result)
            except Exception:
                threw = True

            checks.append({
                'name': 'executes_without_error',
                'passed': not threw,
                'detail': 'Agent threw an exception' if threw else 'Agent executed successfully',
            })

            if threw or result is None:
                continue

            is_valid_json = False
            try:
                parsed = json.loads(result) if isinstance(result, str) else result
                is_valid_json = parsed is not None and isinstance(parsed, dict)
            except (json.JSONDecodeError, TypeError):
                is_valid_json = False

            checks.append({
                'name': 'returns_valid_json',
                'passed': is_valid_json,
                'detail': 'Valid JSON response' if is_valid_json else 'Response is not valid JSON',
            })

            if not is_valid_json or not parsed:
                continue

            expected_status = test_case.get('expectedStatus')
            if expected_status:
                status_matches = parsed.get('status') == expected_status
                checks.append({
                    'name': 'status_matches',
                    'passed': status_matches,
                    'detail': f'Status matches: {expected_status}' if status_matches
                             else f'Expected status "{expected_status}", got "{parsed.get("status")}"',
                })

            expected_fields = test_case.get('expectedFields')
            if expected_fields:
                for field in expected_fields:
                    has_field = field in parsed
                    checks.append({
                        'name': f'has_field_{field}',
                        'passed': has_field,
                        'detail': f'Field "{field}" present' if has_field else f'Field "{field}" missing',
                    })

            has_slush = 'data_slush' in parsed
            checks.append({
                'name': 'has_data_slush',
                'passed': has_slush,
                'detail': 'data_slush present' if has_slush else 'data_slush missing',
            })

        latency_ms = round((time.time() - start_time) * 1000)
        passed_count = sum(1 for c in checks if c['passed'])
        quality = round((passed_count / len(checks)) * 100) if checks else 0

        if quality >= 80:
            eval_status = 'strong'
        elif quality >= 50:
            eval_status = 'developing'
        else:
            eval_status = 'weak'

        return {
            'agentName': agent_name,
            'version': agent_version['version'],
            'timestamp': datetime.now().isoformat(),
            'checks': checks,
            'quality': quality,
            'status': eval_status,
            'latencyMs': latency_ms,
        }

    def _build_comparison(self, agent_name, result_a, result_b):
        quality_delta = result_b['quality'] - result_a['quality']
        latency_delta = result_b['latencyMs'] - result_a['latencyMs']

        if abs(quality_delta) > 5:
            winner = 'B' if quality_delta > 0 else 'A'
            reason = f"Quality difference: {abs(quality_delta)} points"
        else:
            avg_latency = (result_a['latencyMs'] + result_b['latencyMs']) / 2
            latency_threshold = abs(latency_delta) / avg_latency if avg_latency > 0 else 0
            if latency_threshold > 0.2:
                winner = 'B' if latency_delta < 0 else 'A'
                reason = f"Latency tiebreaker: {abs(latency_delta)}ms difference"
            else:
                winner = 'tie'
                reason = 'No significant difference in quality or latency'

        return {
            'agentName': agent_name,
            'timestamp': datetime.now().isoformat(),
            'versionA': result_a['version'],
            'versionB': result_b['version'],
            'resultA': result_a,
            'resultB': result_b,
            'winner': winner,
            'qualityDelta': quality_delta,
            'latencyDelta': latency_delta,
            'reason': reason,
        }

    def _do_promotion(self, slot, candidate, candidate_index, reason, quality):
        record = {
            'fromVersion': slot['active']['version'],
            'toVersion': candidate['version'],
            'timestamp': datetime.now().isoformat(),
            'reason': reason,
            'quality': quality,
        }

        slot['active'] = candidate
        slot['candidates'].pop(candidate_index)
        slot['history'].append(record)

        return record

    def _slot_summary(self, slot):
        eval_history = self._eval_history.get(slot['name'], [])
        active_evals = [e for e in eval_history if e['version'] == slot['active']['version']]
        latest_eval = active_evals[-1] if active_evals else None

        return {
            'name': slot['name'],
            'activeVersion': slot['active']['version'],
            'candidateCount': len(slot['candidates']),
            'latestQuality': latest_eval['quality'] if latest_eval else None,
            'latestStatus': latest_eval['status'] if latest_eval else None,
            'promotionCount': len(slot['history']),
        }
