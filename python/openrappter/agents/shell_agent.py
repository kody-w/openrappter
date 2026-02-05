"""
ShellAgent - Shell command and file operations agent.

Provides bash command execution, file reading/writing, and directory listing.
The core "hands" of the assistant for interacting with the system.
"""

import json
import subprocess
from pathlib import Path

from openrappter.agents.basic_agent import BasicAgent


class ShellAgent(BasicAgent):
    """
    Agent for shell commands and file operations.
    
    Capabilities:
    - Execute bash commands
    - Read file contents
    - Write/create files
    - List directory contents
    """
    
    def __init__(self):
        self.name = 'Shell'
        self.metadata = {
            "name": self.name,
            "description": "Executes shell commands and file operations. Use this to run commands, read files, write files, or list directories.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "The action to perform.",
                        "enum": ["bash", "read", "write", "list"]
                    },
                    "command": {
                        "type": "string",
                        "description": "Shell command to execute (for 'bash' action)."
                    },
                    "path": {
                        "type": "string",
                        "description": "File or directory path (for read/write/list actions)."
                    },
                    "content": {
                        "type": "string",
                        "description": "Content to write (for 'write' action)."
                    },
                    "query": {
                        "type": "string",
                        "description": "Natural language query that may contain the command or path."
                    }
                },
                "required": []
            }
        }
        super().__init__(name=self.name, metadata=self.metadata)
    
    def perform(self, **kwargs):
        """Execute the requested action."""
        action = kwargs.get('action', '')
        command = kwargs.get('command', '')
        path = kwargs.get('path', '')
        content = kwargs.get('content', '')
        query = kwargs.get('query', '')
        
        # Try to infer action from query if not specified
        if not action and query:
            action, command, path, content = self._parse_query(query)
        
        if action == 'bash' or (command and not action):
            return self._execute_bash(command or query)
        elif action == 'read':
            return self._read_file(path or query)
        elif action == 'write':
            return self._write_file(path, content)
        elif action == 'list':
            return self._list_directory(path or '.')
        else:
            # Default: try as bash command
            if query:
                return self._execute_bash(query)
            return json.dumps({
                "status": "error",
                "message": "No action specified. Use: bash, read, write, or list"
            })
    
    def _parse_query(self, query: str) -> tuple:
        """Parse natural language query to determine action."""
        q_lower = query.lower()
        
        # Detect bash commands
        if q_lower.startswith(('run ', 'execute ', '$ ')):
            for prefix in ['run ', 'execute ', '$ ']:
                if q_lower.startswith(prefix):
                    return 'bash', query[len(prefix):], '', ''
        
        # Detect file read
        if q_lower.startswith(('read ', 'show ', 'cat ')):
            for prefix in ['read ', 'show ', 'cat ']:
                if q_lower.startswith(prefix):
                    return 'read', '', query[len(prefix):].strip(), ''
        
        # Detect directory listing
        if q_lower in ['ls', 'dir'] or q_lower.startswith('list '):
            path = '.'
            if q_lower.startswith('list '):
                path = query[5:].strip() or '.'
            return 'list', '', path, ''
        
        # Default to bash
        return 'bash', query, '', ''
    
    def _execute_bash(self, command: str) -> str:
        """Execute a shell command."""
        if not command:
            return json.dumps({
                "status": "error",
                "message": "No command provided"
            })
        
        try:
            result = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=30,
                cwd=Path.cwd()
            )
            
            output = result.stdout or result.stderr
            return json.dumps({
                "status": "success",
                "command": command,
                "output": output[:2000] if output else "(no output)",
                "return_code": result.returncode
            })
            
        except subprocess.TimeoutExpired:
            return json.dumps({
                "status": "error",
                "message": "Command timed out after 30 seconds"
            })
        except Exception as e:
            return json.dumps({
                "status": "error",
                "message": str(e)
            })
    
    def _read_file(self, path: str) -> str:
        """Read a file's contents."""
        if not path:
            return json.dumps({
                "status": "error",
                "message": "No file path provided"
            })
        
        try:
            p = Path(path).expanduser()
            
            if not p.exists():
                return json.dumps({
                    "status": "error",
                    "message": f"File not found: {path}"
                })
            
            if p.is_dir():
                return self._list_directory(path)
            
            content = p.read_text()
            truncated = len(content) > 5000
            
            return json.dumps({
                "status": "success",
                "path": str(p),
                "content": content[:5000] if truncated else content,
                "truncated": truncated,
                "size": len(content)
            })
            
        except Exception as e:
            return json.dumps({
                "status": "error",
                "message": str(e)
            })
    
    def _write_file(self, path: str, content: str) -> str:
        """Write content to a file."""
        if not path:
            return json.dumps({
                "status": "error",
                "message": "No file path provided"
            })
        
        if not content:
            return json.dumps({
                "status": "error",
                "message": "No content provided to write"
            })
        
        try:
            p = Path(path).expanduser()
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
            
            return json.dumps({
                "status": "success",
                "path": str(p),
                "bytes_written": len(content),
                "message": f"Wrote {len(content)} bytes to {p}"
            })
            
        except Exception as e:
            return json.dumps({
                "status": "error",
                "message": str(e)
            })
    
    def _list_directory(self, path: str = '.') -> str:
        """List directory contents."""
        try:
            p = Path(path).expanduser()
            
            if not p.exists():
                return json.dumps({
                    "status": "error",
                    "message": f"Directory not found: {path}"
                })
            
            if not p.is_dir():
                return self._read_file(path)
            
            items = []
            for item in sorted(list(p.iterdir())[:50]):
                items.append({
                    "name": item.name,
                    "type": "directory" if item.is_dir() else "file",
                    "size": item.stat().st_size if item.is_file() else None
                })
            
            return json.dumps({
                "status": "success",
                "path": str(p),
                "items": items,
                "count": len(items)
            })
            
        except Exception as e:
            return json.dumps({
                "status": "error",
                "message": str(e)
            })
