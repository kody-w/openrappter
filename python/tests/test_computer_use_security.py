import json

from openrappter.agents.computer_use_agent import ComputerUseAgent
from openrappter.agents.demo_recorder_agent import DemoRecorderAgent


def test_computer_use_rejects_native_code_inputs(monkeypatch):
    agent = ComputerUseAgent()
    calls = []
    monkeypatch.setattr(agent, '_run_cg', calls.append)
    payload = '0); system("touch /tmp/openrappter-injected"); //'

    click = json.loads(agent.perform(action='click', x=payload, y=1))
    scroll = json.loads(agent.perform(action='scroll', direction='down', amount=payload))
    drag = json.loads(agent.perform(action='drag', x=0, y=0, end_x=payload, end_y=1))

    assert click['status'] == 'error'
    assert scroll['status'] == 'error'
    assert drag['status'] == 'error'
    assert calls == []


def test_computer_use_escapes_key_apple_script(monkeypatch):
    agent = ComputerUseAgent()
    calls = []

    def capture(args, **kwargs):
        calls.append((args, kwargs))

    monkeypatch.setattr('subprocess.run', capture)
    payload = 'x"; do shell script "touch /tmp/openrappter-injected"; "'

    result = json.loads(agent.perform(action='key', text=payload))

    assert result['status'] == 'success'
    assert calls[0][0][:2] == ['osascript', '-e']
    assert '\\"' in calls[0][0][2]


def test_computer_use_escapes_backslashes_before_quotes():
    agent = ComputerUseAgent()
    payload = 'a\\\\"\\ndo shell script "touch /tmp/openrappter-injected"\\n--'

    escaped = agent._escape_apple_script_string(payload)

    assert escaped == payload.replace('\\', '\\\\').replace('"', '\\"')


def test_demo_recorder_rejects_path_traversal_before_creating_output(tmp_path):
    agent = DemoRecorderAgent()
    agent.output_dir = str(tmp_path / 'demos')

    result = json.loads(agent.perform(action='record_rar', output_name='../../escaped'))

    assert result['status'] == 'error'
    assert not (tmp_path / 'demos').exists()


def test_demo_recorder_narration_passes_apostrophes_literally(monkeypatch):
    agent = DemoRecorderAgent()
    calls = []

    def capture(args, **kwargs):
        calls.append((args, kwargs))

    monkeypatch.setattr('subprocess.Popen', capture)
    agent._narrate("don't alter this")

    assert calls[0][0][-1] == "don't alter this"
