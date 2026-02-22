"""
GitAgent - Git repository operations agent.

Provides git repository operations with injectable exec function
for testability. All operations are read-only by default except
commit and branch create.

Actions: status, diff, log, branch, commit, pr

Mirrors TypeScript agents/GitAgent.ts
"""

import json
import os
import subprocess
from datetime import datetime

from openrappter.agents.basic_agent import BasicAgent


class GitAgent(BasicAgent):
    def __init__(self, cwd=None, exec_fn=None):
        self.name = 'Git'
        self.metadata = {
            "name": self.name,
            "description": "Git repository operations. Status, diff, log, branch management, commits, and PR creation.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "The git action to perform.",
                        "enum": ["status", "diff", "log", "branch", "commit", "pr"]
                    },
                    "count": {
                        "type": "number",
                        "description": "Number of log entries to retrieve (default: 10)."
                    },
                    "name": {
                        "type": "string",
                        "description": "Branch name for branch create action."
                    },
                    "files": {
                        "type": "array",
                        "description": "Files to stage for commit.",
                        "items": {"type": "string"}
                    },
                    "message": {
                        "type": "string",
                        "description": "Commit message."
                    },
                    "title": {
                        "type": "string",
                        "description": "PR title."
                    },
                    "body": {
                        "type": "string",
                        "description": "PR body."
                    },
                    "base": {
                        "type": "string",
                        "description": "Base branch for PR (default: main)."
                    }
                },
                "required": []
            }
        }
        super().__init__(name=self.name, metadata=self.metadata)
        self._cwd = cwd or os.getcwd()
        self._exec_fn = exec_fn or self._default_exec

    def _default_exec(self, cmd, cwd=None):
        """Default exec using subprocess."""
        try:
            result = subprocess.run(
                cmd, shell=True,
                capture_output=True, text=True,
                cwd=cwd or self._cwd,
                timeout=30
            )
            return {
                'stdout': result.stdout.strip(),
                'stderr': result.stderr.strip(),
            }
        except subprocess.TimeoutExpired:
            return {'stdout': '', 'stderr': 'Command timed out'}
        except Exception as e:
            return {'stdout': '', 'stderr': str(e)}

    def perform(self, **kwargs):
        action = kwargs.get('action')

        if not action:
            return json.dumps({
                "status": "error",
                "message": "No action specified. Use: status, diff, log, branch, commit, or pr"
            })

        try:
            if action == 'status':
                return self._git_status()
            elif action == 'diff':
                return self._git_diff()
            elif action == 'log':
                return self._git_log(kwargs)
            elif action == 'branch':
                return self._git_branch(kwargs)
            elif action == 'commit':
                return self._git_commit(kwargs)
            elif action == 'pr':
                return self._git_pr(kwargs)
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

    def _git_status(self):
        result = self._exec_fn('git status --porcelain', self._cwd)
        stdout = result.get('stdout', '')
        files = []

        if stdout:
            for line in stdout.split('\n'):
                line = line.rstrip()
                if line:
                    status_code = line[:2].strip()
                    file_path = line[3:].strip()
                    files.append({'status': status_code, 'file': file_path})

        data_slush = self.slush_out(
            signals={'file_count': len(files), 'clean': len(files) == 0}
        )

        return json.dumps({
            "status": "success",
            "action": "status",
            "files": files,
            "clean": len(files) == 0,
            "data_slush": data_slush,
        })

    def _git_diff(self):
        stat_result = self._exec_fn('git diff --stat', self._cwd)
        diff_result = self._exec_fn('git diff', self._cwd)

        diff = diff_result.get('stdout', '')
        truncated = len(diff) > 10000
        content = diff[:10000]

        data_slush = self.slush_out(
            signals={'has_changes': len(diff) > 0, 'truncated': truncated}
        )

        return json.dumps({
            "status": "success",
            "action": "diff",
            "stat": stat_result.get('stdout', ''),
            "diff": content,
            "truncated": truncated,
            "data_slush": data_slush,
        })

    def _git_log(self, kwargs):
        count = kwargs.get('count', 10)
        fmt = '--pretty=format:{"hash":"%H","short":"%h","author":"%an","date":"%ai","subject":"%s"}'
        result = self._exec_fn(f'git log -{count} {fmt}', self._cwd)
        stdout = result.get('stdout', '')

        commits = []
        if stdout:
            for line in stdout.split('\n'):
                line = line.strip()
                if line:
                    try:
                        commits.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass

        data_slush = self.slush_out(
            signals={'commit_count': len(commits)}
        )

        return json.dumps({
            "status": "success",
            "action": "log",
            "commits": commits,
            "count": len(commits),
            "data_slush": data_slush,
        })

    def _git_branch(self, kwargs):
        name = kwargs.get('name')

        if not name:
            result = self._exec_fn('git branch --format="%(refname:short)"', self._cwd)
            stdout = result.get('stdout', '')
            branches = [b.strip() for b in stdout.split('\n') if b.strip()]

            current_result = self._exec_fn('git branch --show-current', self._cwd)
            current = current_result.get('stdout', '').strip()

            data_slush = self.slush_out(
                signals={'branch_count': len(branches), 'current_branch': current}
            )

            return json.dumps({
                "status": "success",
                "action": "branch",
                "branches": branches,
                "current": current,
                "data_slush": data_slush,
            })

        # Create branch
        result = self._exec_fn(f'git checkout -b {name}', self._cwd)

        data_slush = self.slush_out(
            signals={'branch_created': name}
        )

        return json.dumps({
            "status": "success",
            "action": "branch",
            "created": name,
            "output": result.get('stdout', '') or result.get('stderr', ''),
            "data_slush": data_slush,
        })

    def _git_commit(self, kwargs):
        files = kwargs.get('files')
        message = kwargs.get('message')

        if not message:
            return json.dumps({
                "status": "error",
                "message": "message is required for commit"
            })

        if files:
            file_list = ' '.join(files)
            self._exec_fn(f'git add {file_list}', self._cwd)

        result = self._exec_fn(f'git commit -m "{message}"', self._cwd)

        data_slush = self.slush_out(
            signals={'committed': True, 'message': message}
        )

        return json.dumps({
            "status": "success",
            "action": "commit",
            "message": message,
            "output": result.get('stdout', '') or result.get('stderr', ''),
            "data_slush": data_slush,
        })

    def _git_pr(self, kwargs):
        title = kwargs.get('title')
        body = kwargs.get('body')
        base = kwargs.get('base', 'main')

        if not title:
            return json.dumps({
                "status": "error",
                "message": "title is required for pr"
            })

        body_flag = f' --body "{body}"' if body else ''
        result = self._exec_fn(
            f'gh pr create --title "{title}"{body_flag} --base {base}',
            self._cwd
        )

        data_slush = self.slush_out(
            signals={'pr_title': title, 'base': base}
        )

        return json.dumps({
            "status": "success",
            "action": "pr",
            "title": title,
            "base": base,
            "output": result.get('stdout', '') or result.get('stderr', ''),
            "data_slush": data_slush,
        })
