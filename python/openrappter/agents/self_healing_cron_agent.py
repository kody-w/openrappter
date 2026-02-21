"""
SelfHealingCronAgent - Autonomous self-healing health check agent.

Orchestrates WebAgent, ShellAgent, and MessageAgent into a self-healing loop:
schedule a health check, detect failures, run a repair command, and notify
on any configured channel.

Actions:
  setup    - Configure a new self-healing job
  check    - Run one health check cycle (the core loop)
  status   - Return current state of a named job
  history  - Return check history for a named job
  teardown - Remove a job and clear its history

Flow (check action):
  1. WebAgent fetches the health URL (with retries)
  2. If unhealthy, ShellAgent runs the restart command
  3. WebAgent re-checks after restart
  4. MessageAgent sends alert (recovered or still down)

Mirrors TypeScript agents/SelfHealingCronAgent.ts
"""

import json
import re
from datetime import datetime

from openrappter.agents.basic_agent import BasicAgent


class SelfHealingCronAgent(BasicAgent):
    def __init__(self, web_agent=None, shell_agent=None, message_agent=None):
        self.name = 'SelfHealingCron'
        self.metadata = {
            "name": self.name,
            "description": "Autonomous self-healing health check agent. Schedules health checks, detects failures, runs repair commands, and sends notifications.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "The action to perform.",
                        "enum": ["setup", "check", "status", "history", "teardown"]
                    },
                    "name": {
                        "type": "string",
                        "description": "Job name (e.g. \"api-health\")."
                    },
                    "url": {
                        "type": "string",
                        "description": "Health check endpoint URL."
                    },
                    "schedule": {
                        "type": "string",
                        "description": "Cron expression (default: \"*/5 * * * *\")."
                    },
                    "restartCommand": {
                        "type": "string",
                        "description": "Shell command to run on failure."
                    },
                    "notifyChannel": {
                        "type": "string",
                        "description": "Channel ID for alerts (e.g. \"slack\")."
                    },
                    "conversationId": {
                        "type": "string",
                        "description": "Conversation/room ID for the channel."
                    },
                    "maxRetries": {
                        "type": "number",
                        "description": "Retry fetch attempts before declaring failure (default: 2)."
                    },
                    "timeoutMs": {
                        "type": "number",
                        "description": "Fetch timeout per attempt in ms (default: 5000)."
                    }
                },
                "required": []
            }
        }
        super().__init__(name=self.name, metadata=self.metadata)

        self._jobs = {}
        self._check_history = {}
        self._web_agent = web_agent
        self._shell_agent = shell_agent
        self._message_agent = message_agent

    @property
    def web_agent(self):
        if self._web_agent is None:
            from openrappter.agents.shell_agent import ShellAgent as _ShellAgent
            # Lazy import to avoid circular deps; in practice WebAgent would exist
            self._web_agent = BasicAgent.__new__(BasicAgent)
        return self._web_agent

    @property
    def shell_agent(self):
        if self._shell_agent is None:
            from openrappter.agents.shell_agent import ShellAgent
            self._shell_agent = ShellAgent()
        return self._shell_agent

    @property
    def message_agent(self):
        if self._message_agent is None:
            self._message_agent = BasicAgent.__new__(BasicAgent)
        return self._message_agent

    def set_agents(self, web_agent=None, shell_agent=None, message_agent=None):
        """Replace sub-agents for testing."""
        if web_agent is not None:
            self._web_agent = web_agent
        if shell_agent is not None:
            self._shell_agent = shell_agent
        if message_agent is not None:
            self._message_agent = message_agent

    def perform(self, **kwargs):
        action = kwargs.get('action')

        if not action:
            return json.dumps({
                "status": "error",
                "message": "No action specified. Use: setup, check, status, history, or teardown"
            })

        try:
            if action == 'setup':
                return self._setup_job(kwargs)
            elif action == 'check':
                return self._run_check(kwargs)
            elif action == 'status':
                return self._get_status(kwargs)
            elif action == 'history':
                return self._get_history(kwargs)
            elif action == 'teardown':
                return self._teardown_job(kwargs)
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

    def _setup_job(self, kwargs):
        name = kwargs.get('name')
        url = kwargs.get('url')
        restart_command = kwargs.get('restartCommand')

        if not name or not url or not restart_command:
            return json.dumps({
                "status": "error",
                "message": "name, url, and restartCommand are required for setup"
            })

        config = {
            "name": name,
            "url": url,
            "schedule": kwargs.get('schedule', '*/5 * * * *'),
            "restartCommand": restart_command,
            "notifyChannel": kwargs.get('notifyChannel', ''),
            "conversationId": kwargs.get('conversationId', ''),
            "maxRetries": kwargs.get('maxRetries', 2),
            "timeoutMs": kwargs.get('timeoutMs', 5000),
            "createdAt": datetime.now().isoformat(),
        }

        self._jobs[name] = config
        self._check_history[name] = []

        data_slush = self.slush_out(
            signals={"job_name": name, "job_url": url},
            action="setup",
        )

        return json.dumps({
            "status": "success",
            "action": "setup",
            "job": config,
            "message": f'Job "{name}" configured',
            "data_slush": data_slush,
        })

    def _run_check(self, kwargs):
        name = kwargs.get('name')
        if not name:
            return json.dumps({"status": "error", "message": "name is required for check"})

        job = self._jobs.get(name)
        if not job:
            return json.dumps({"status": "error", "message": f"Job not found: {name}"})

        check_result = {
            "timestamp": datetime.now().isoformat(),
            "healthy": False,
            "restarted": False,
            "recovered": False,
            "notified": False,
        }

        # Step 1: Health check with retries
        healthy = False
        http_status = None

        for attempt in range(job['maxRetries'] + 1):
            fetch_result = self.web_agent.execute(action='fetch', url=job['url'])
            try:
                parsed = json.loads(fetch_result) if isinstance(fetch_result, str) else fetch_result
                if parsed.get('status') == 'success':
                    healthy = True
                    http_status = 200
                    break
                status_match = re.search(r'HTTP (\d+)', parsed.get('message', ''))
                if status_match:
                    http_status = int(status_match.group(1))
            except (json.JSONDecodeError, TypeError, AttributeError):
                pass

        check_result['httpStatus'] = http_status

        # Step 2: If healthy, log and return
        if healthy:
            check_result['healthy'] = True
            self._push_check_result(name, check_result)

            data_slush = self.slush_out(
                signals={"job_name": name, "health_status": "healthy"},
                action="check",
                health_status="healthy",
                action_taken="none",
            )

            return json.dumps({
                "status": "success",
                "action": "check",
                "job": name,
                "healthy": True,
                "check": check_result,
                "data_slush": data_slush,
            })

        # Step 3: Unhealthy - run restart command
        check_result['restarted'] = True
        restart_output = None
        restart_success = False

        try:
            shell_result = self.shell_agent.execute(
                action='bash',
                command=job['restartCommand'],
            )
            shell_parsed = json.loads(shell_result) if isinstance(shell_result, str) else shell_result
            restart_output = shell_parsed.get('output')
            restart_success = shell_parsed.get('status') == 'success'
        except Exception:
            restart_output = 'Restart command failed'

        # Step 4: Re-check after restart (single attempt)
        recovered_healthy = False
        try:
            recheck_result = self.web_agent.execute(action='fetch', url=job['url'])
            recheck_parsed = json.loads(recheck_result) if isinstance(recheck_result, str) else recheck_result
            if recheck_parsed.get('status') == 'success':
                recovered_healthy = True
        except Exception:
            pass

        check_result['recovered'] = recovered_healthy
        check_result['healthy'] = recovered_healthy

        # Step 5: Send notification
        if recovered_healthy:
            alert_message = f'Service "{name}" recovered after restart'
        else:
            alert_message = f'Service "{name}" is DOWN \u2014 restart failed'

        if job.get('notifyChannel') and job.get('conversationId'):
            try:
                self.message_agent.execute(
                    action='send',
                    channelId=job['notifyChannel'],
                    conversationId=job['conversationId'],
                    content=alert_message,
                )
                check_result['notified'] = True
            except Exception:
                pass

        self._push_check_result(name, check_result)

        action_taken = 'restarted_recovered' if recovered_healthy else 'restarted_still_down'
        data_slush = self.slush_out(
            signals={
                "job_name": name,
                "health_status": "recovered" if recovered_healthy else "down",
                "restart_success": restart_success,
            },
            action="check",
            health_status="recovered" if recovered_healthy else "down",
            action_taken=action_taken,
        )

        return json.dumps({
            "status": "success",
            "action": "check",
            "job": name,
            "healthy": recovered_healthy,
            "check": check_result,
            "alert": alert_message,
            "data_slush": data_slush,
        })

    def _get_status(self, kwargs):
        name = kwargs.get('name')
        if not name:
            return json.dumps({"status": "error", "message": "name is required for status"})

        job = self._jobs.get(name)
        if not job:
            return json.dumps({"status": "error", "message": f"Job not found: {name}"})

        history = self._check_history.get(name, [])
        last_check = history[-1] if history else None
        total_checks = len(history)
        healthy_checks = sum(1 for c in history if c.get('healthy'))
        uptime_percent = round((healthy_checks / total_checks) * 100) if total_checks > 0 else 100

        return json.dumps({
            "status": "success",
            "action": "status",
            "job": job,
            "lastCheck": last_check,
            "stats": {
                "totalChecks": total_checks,
                "healthyChecks": healthy_checks,
                "uptimePercent": uptime_percent,
            },
        })

    def _get_history(self, kwargs):
        name = kwargs.get('name')
        if not name:
            return json.dumps({"status": "error", "message": "name is required for history"})

        job = self._jobs.get(name)
        if not job:
            return json.dumps({"status": "error", "message": f"Job not found: {name}"})

        history = self._check_history.get(name, [])

        return json.dumps({
            "status": "success",
            "action": "history",
            "job": name,
            "checks": history,
            "count": len(history),
        })

    def _teardown_job(self, kwargs):
        name = kwargs.get('name')
        if not name:
            return json.dumps({"status": "error", "message": "name is required for teardown"})

        if name not in self._jobs:
            return json.dumps({"status": "error", "message": f"Job not found: {name}"})

        del self._jobs[name]
        self._check_history.pop(name, None)

        return json.dumps({
            "status": "success",
            "action": "teardown",
            "job": name,
            "message": f'Job "{name}" removed',
        })

    def _push_check_result(self, name, result):
        history = self._check_history.get(name)
        if history is not None:
            history.append(result)
