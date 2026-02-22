RECOGNIZED_SECTIONS = {'gateway', 'models', 'agents', 'channels', 'memory', 'cron'}


def validate_config(data: dict) -> dict:
    """Validate a config dict.

    Returns {'success': True, 'data': data} if valid,
    or {'success': False, 'error': str} if invalid.
    """
    if not isinstance(data, dict):
        return {'success': False, 'error': 'Config must be a dict'}

    # Must have at least one recognized section
    if not RECOGNIZED_SECTIONS.intersection(data.keys()):
        return {
            'success': False,
            'error': (
                'Config must contain at least one recognized section: '
                + ', '.join(sorted(RECOGNIZED_SECTIONS))
            ),
        }

    # gateway section: port must be an int if present
    if 'gateway' in data:
        gateway = data['gateway']
        if isinstance(gateway, dict) and 'port' in gateway:
            if not isinstance(gateway['port'], int):
                return {
                    'success': False,
                    'error': "gateway.port must be an integer",
                }

    # models section: must be a list if present
    if 'models' in data:
        if not isinstance(data['models'], list):
            return {'success': False, 'error': 'models must be a list'}

    return {'success': True, 'data': data}


def get_config_json_schema() -> dict:
    """Return a JSON Schema dict describing valid config objects."""
    return {
        'type': 'object',
        'properties': {
            'gateway': {
                'type': 'object',
                'description': 'Gateway server settings (host, port, WebSocket options)',
                'properties': {
                    'port': {'type': 'integer', 'description': 'Port to listen on'},
                    'host': {'type': 'string', 'description': 'Host to bind to'},
                },
            },
            'models': {
                'type': 'array',
                'description': 'List of model provider configurations',
                'items': {'type': 'object'},
            },
            'agents': {
                'type': 'object',
                'description': 'Agent-specific configuration and defaults',
            },
            'channels': {
                'type': 'object',
                'description': 'Channel integrations (Slack, Discord, Telegram, etc.)',
            },
            'memory': {
                'type': 'object',
                'description': 'Memory storage and retrieval settings',
            },
            'cron': {
                'type': 'object',
                'description': 'Scheduled task (cron job) definitions',
            },
        },
    }
