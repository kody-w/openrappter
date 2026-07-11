import json
import os
import signal
import subprocess
import time
from pathlib import Path

from openrappter.agents.basic_agent import BasicAgent
from openrappter.agents.computer_use_agent import ComputerUseAgent

RAR_DEMO_SCRIPT = {
    "name": "RAR Feature Walkthrough",
    "description": "A guided tour of the RAPP Agent Repository",
    "url": "https://kody-w.github.io/RAR/",
    "steps": [
        {"label": "Opening RAR in Safari", "action": "open_app", "params": {"text": "Safari"}, "pauseAfter": 2000},
        {"label": "Navigating to RAR", "action": "key", "params": {"text": "cmd+l"}, "pauseAfter": 500},
        {"label": "Typing URL", "action": "type", "params": {"text": "https://kody-w.github.io/RAR/"}, "pauseAfter": 500},
        {"label": "Loading the page", "action": "key", "params": {"text": "return"}, "pauseAfter": 3000, "narration": "Welcome to the RAPP Agent Repository"},
        {"label": "Capturing the landing page", "action": "screenshot", "params": {}, "pauseAfter": 2000, "narration": "The main agent grid shows all available agents"},
        {"label": "Scrolling through agents", "action": "scroll", "params": {"direction": "down", "amount": 10}, "pauseAfter": 1500},
        {"label": "Scrolling more", "action": "scroll", "params": {"direction": "down", "amount": 10}, "pauseAfter": 1500, "narration": "Browse through 138 agents across 19 categories"},
        {"label": "Scrolling back to top", "action": "scroll", "params": {"direction": "up", "amount": 30}, "pauseAfter": 1500},
        {"label": "Focusing search", "action": "key", "params": {"text": "/"}, "pauseAfter": 800, "narration": "Use slash to search agents"},
        {"label": "Searching for an agent", "action": "type", "params": {"text": "fraud detection"}, "pauseAfter": 2000, "narration": "Search filters agents in real time"},
        {"label": "Capturing search results", "action": "screenshot", "params": {}, "pauseAfter": 1500},
        {"label": "Clearing search", "action": "key", "params": {"text": "cmd+a"}, "pauseAfter": 300},
        {"label": "Deleting search text", "action": "key", "params": {"text": "delete"}, "pauseAfter": 500},
        {"label": "Closing search", "action": "key", "params": {"text": "escape"}, "pauseAfter": 1000},
        {"label": "Reading the screen to find an agent card", "action": "read_screen", "params": {}, "pauseAfter": 1000},
        {"label": "Clicking the first agent card", "action": "click", "params": {"x": 400, "y": 500}, "pauseAfter": 2000, "narration": "Click any card to see agent details"},
        {"label": "Capturing agent detail modal", "action": "screenshot", "params": {}, "pauseAfter": 2000, "narration": "View description, version, category, and download options"},
        {"label": "Closing the modal", "action": "key", "params": {"text": "escape"}, "pauseAfter": 1000},
        {"label": "Navigating to Submit page", "action": "key", "params": {"text": "cmd+l"}, "pauseAfter": 500},
        {"label": "Typing Submit URL", "action": "type", "params": {"text": "https://kody-w.github.io/RAR/submit.html"}, "pauseAfter": 500},
        {"label": "Loading Submit page", "action": "key", "params": {"text": "return"}, "pauseAfter": 3000, "narration": "Submit your own agents to the repository"},
        {"label": "Capturing the submit page", "action": "screenshot", "params": {}, "pauseAfter": 2000},
        {"label": "Going back to main page", "action": "key", "params": {"text": "cmd+l"}, "pauseAfter": 500},
        {"label": "Typing main URL", "action": "type", "params": {"text": "https://kody-w.github.io/RAR/"}, "pauseAfter": 500},
        {"label": "Loading main page", "action": "key", "params": {"text": "return"}, "pauseAfter": 2000},
        {"label": "Final screenshot", "action": "screenshot", "params": {}, "pauseAfter": 1000, "narration": "That wraps up the RAR tour!"},
    ],
}


class DemoRecorderAgent(BasicAgent):
    """Records scripted demos by orchestrating ComputerUseAgent while screen recording."""

    def __init__(self):
        self.name = 'DemoRecorder'
        self.metadata = {
            "name": self.name,
            "description": (
                "Records scripted demos of apps by orchestrating ComputerUseAgent "
                "while screen recording. Produces video walkthroughs with narration."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["record_rar", "record_custom", "list_scripts", "status"],
                        "description": "What to do",
                    },
                    "script": {
                        "type": "string",
                        "description": "JSON demo script for record_custom",
                    },
                    "output_name": {
                        "type": "string",
                        "description": "Name for the output video (no extension)",
                    },
                    "with_narration": {
                        "type": "boolean",
                        "description": "Enable TTS narration (default true)",
                    },
                    "query": {"type": "string", "description": "Natural language description"},
                },
                "required": [],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)
        self.computer = ComputerUseAgent()
        self.output_dir = os.path.join(str(Path.home()), 'Movies', 'RappterDemos')

    def perform(self, **kwargs):
        action = kwargs.get('action', 'record_rar')
        with_narration = kwargs.get('with_narration', True)
        output_name = kwargs.get('output_name', f'demo_{int(time.time())}')

        if action in ('record_rar', 'record_custom') and not self._valid_output_name(output_name):
            return json.dumps({
                "status": "error",
                "message": (
                    "output_name must start with a letter or number and contain only "
                    "letters, numbers, spaces, dots, dashes, or underscores"
                ),
            })

        os.makedirs(self.output_dir, exist_ok=True)

        try:
            if action == 'record_rar':
                return self._record_demo(RAR_DEMO_SCRIPT, output_name, with_narration)
            elif action == 'record_custom':
                script_json = kwargs.get('script', '')
                if not script_json:
                    return json.dumps({"status": "error", "message": "script JSON required"})
                custom_script = json.loads(script_json)
                return self._record_demo(custom_script, output_name, with_narration)
            elif action == 'list_scripts':
                return json.dumps({
                    "status": "success",
                    "action": "list_scripts",
                    "scripts": [{
                        "id": "rar",
                        "name": RAR_DEMO_SCRIPT["name"],
                        "description": RAR_DEMO_SCRIPT["description"],
                        "steps": len(RAR_DEMO_SCRIPT["steps"]),
                    }],
                })
            elif action == 'status':
                return self._get_status()
            else:
                return json.dumps({"status": "error", "message": f"Unknown action: {action}"})
        except Exception as e:
            return json.dumps({"status": "error", "action": action, "message": str(e)})

    def _record_demo(self, script, output_name, with_narration):
        video_path = os.path.join(self.output_dir, f"{output_name}.mov")
        screenshots = []
        log = []

        # Start screen recording
        recording_pid = self._start_recording(video_path)
        time.sleep(1.5)

        steps = script.get('steps', [])
        for i, step in enumerate(steps):
            step_label = f"[{i + 1}/{len(steps)}] {step['label']}"

            try:
                # Narrate if enabled
                if with_narration and step.get('narration'):
                    self._narrate(step['narration'])

                # Execute the computer action
                params = step.get('params', {})
                result = self.computer.execute(action=step['action'], **params)
                parsed = json.loads(result)

                if parsed.get('path') and step['action'] == 'screenshot':
                    screenshots.append(parsed['path'])

                log.append({
                    "step": step_label,
                    "status": "success",
                    "timestamp": time.strftime('%Y-%m-%dT%H:%M:%S'),
                    "narration": step.get('narration'),
                })

                pause = step.get('pauseAfter', 0)
                if pause:
                    time.sleep(pause / 1000.0)

            except Exception as e:
                log.append({
                    "step": step_label,
                    "status": f"error: {str(e)}",
                    "timestamp": time.strftime('%Y-%m-%dT%H:%M:%S'),
                })

        # Stop recording
        self._stop_recording(recording_pid)
        time.sleep(2)

        file_exists = os.path.exists(video_path)

        return json.dumps({
            "status": "success",
            "action": "record_demo",
            "script_name": script.get('name', 'custom'),
            "video_path": video_path if file_exists else None,
            "video_saved": file_exists,
            "screenshots": screenshots,
            "steps_completed": sum(1 for l in log if l['status'] == 'success'),
            "steps_total": len(steps),
            "log": log,
            "data_slush": {
                "source_agent": "DemoRecorder",
                "video_path": video_path,
                "script_name": script.get('name', 'custom'),
                "screenshots_count": len(screenshots),
            },
        })

    def _start_recording(self, output_path):
        proc = subprocess.Popen(
            ['/usr/sbin/screencapture', '-v', '-C', '-k', output_path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(0.5)
        return proc.pid

    def _stop_recording(self, pid):
        try:
            if pid:
                os.kill(pid, signal.SIGINT)
        except ProcessLookupError:
            pass
        try:
            subprocess.run(
                ['pkill', '-INT', '-f', 'screencapture -v'],
                capture_output=True,
            )
        except Exception:
            pass

    def _narrate(self, text):
        try:
            subprocess.Popen(
                ['say', '-v', 'Samantha', '-r', '180', text],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:
            pass

    @staticmethod
    def _valid_output_name(value):
        return (
            isinstance(value, str)
            and 1 <= len(value) <= 128
            and value[0].isalnum()
            and all(char.isalnum() or char in ' _.-' for char in value)
            and '..' not in value
        )

    def _get_status(self):
        recording = False
        try:
            result = subprocess.run(
                ['pgrep', '-f', 'screencapture -v'],
                capture_output=True, text=True,
            )
            recording = bool(result.stdout.strip())
        except Exception:
            pass

        demos = []
        try:
            for f in sorted(Path(self.output_dir).iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
                if f.suffix == '.mov':
                    demos.append(f.name)
        except FileNotFoundError:
            pass

        return json.dumps({
            "status": "success",
            "action": "status",
            "recording_in_progress": recording,
            "output_dir": self.output_dir,
            "existing_demos": demos,
            "demo_count": len(demos),
        })
