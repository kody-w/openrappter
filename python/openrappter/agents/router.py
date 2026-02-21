"""
AgentRouter - Routes messages to appropriate agents based on rules.

Supports condition types: always, sender, channel, group, pattern
Rules are priority-sorted (highest first).
Session keys determine conversation isolation.

Mirrors TypeScript agents/router.ts
"""

import re


class AgentRouter:
    """Routes messages to agents based on configurable rules."""

    def __init__(self):
        self._rules = []
        self._default_agent_id = 'default'
        self._session_key_format = 'conversation'
        self._custom_session_key = None

    def add_rule(self, rule):
        """Add a routing rule.

        Args:
            rule: dict with keys: id, priority, conditions, agentId, metadata (optional)
        """
        self._rules.append(rule)
        self._rules.sort(key=lambda r: r.get('priority', 0), reverse=True)

    def remove_rule(self, rule_id):
        """Remove a routing rule by ID. Returns True if removed."""
        for i, rule in enumerate(self._rules):
            if rule['id'] == rule_id:
                self._rules.pop(i)
                return True
        return False

    def set_default_agent(self, agent_id):
        """Set the default agent ID."""
        self._default_agent_id = agent_id

    def set_session_key_format(self, fmt, custom_fn=None):
        """Set session key format.

        Args:
            fmt: 'sender', 'conversation', 'channel', or 'custom'
            custom_fn: callable(context) -> str (required if fmt='custom')
        """
        self._session_key_format = fmt
        self._custom_session_key = custom_fn

    def route(self, context):
        """Route a message to an agent.

        Args:
            context: dict with keys: senderId, channelId, conversationId, message, metadata (optional)

        Returns:
            dict with keys: agentId, sessionKey, rule (optional)
        """
        session_key = self._get_session_key(context)

        for rule in self._rules:
            if self._matches_rule(context, rule):
                return {
                    'agentId': rule['agentId'],
                    'sessionKey': session_key,
                    'rule': rule,
                }

        return {
            'agentId': self._default_agent_id,
            'sessionKey': session_key,
        }

    def get_rules(self):
        """Get all rules."""
        return list(self._rules)

    def load_rules(self, configs):
        """Create rules from config dicts.

        Args:
            configs: list of dicts with keys: id, priority, sender, channel, group, pattern, agent
        """
        for item in configs:
            conditions = []

            if item.get('sender'):
                conditions.append({'type': 'sender', 'value': item['sender']})
            if item.get('channel'):
                conditions.append({'type': 'channel', 'value': item['channel']})
            if item.get('group'):
                conditions.append({'type': 'group', 'value': item['group']})
            if item.get('pattern'):
                conditions.append({'type': 'pattern', 'value': item['pattern']})

            if not conditions:
                conditions.append({'type': 'always'})

            import time
            import random
            rule_id = item.get('id', f"rule_{int(time.time())}_{random.randint(0, 999999)}")

            self.add_rule({
                'id': rule_id,
                'priority': item.get('priority', 0),
                'conditions': conditions,
                'agentId': item['agent'],
            })

    def _matches_rule(self, context, rule):
        """Check if context matches all conditions in a rule."""
        return all(self._matches_condition(context, c) for c in rule.get('conditions', []))

    def _matches_condition(self, context, condition):
        """Check if context matches a single condition."""
        ctype = condition.get('type')

        if ctype == 'always':
            return True
        elif ctype == 'sender':
            return context.get('senderId') == condition.get('value')
        elif ctype == 'channel':
            return context.get('channelId') == condition.get('value')
        elif ctype == 'group':
            return context.get('conversationId') == condition.get('value')
        elif ctype == 'pattern':
            pattern = condition.get('pattern')
            if pattern:
                return bool(re.search(pattern, context.get('message', '')))
            value = condition.get('value')
            if value:
                return bool(re.search(value, context.get('message', ''), re.IGNORECASE))
            return False
        else:
            return False

    def _get_session_key(self, context):
        """Generate session key based on format."""
        fmt = self._session_key_format

        if fmt == 'sender':
            return f"{context.get('channelId', '')}:{context.get('senderId', '')}"
        elif fmt == 'conversation':
            return f"{context.get('channelId', '')}:{context.get('conversationId', '')}"
        elif fmt == 'channel':
            return context.get('channelId', '')
        elif fmt == 'custom':
            if self._custom_session_key:
                return self._custom_session_key(context)
            return f"{context.get('channelId', '')}:{context.get('conversationId', '')}"
        else:
            return f"{context.get('channelId', '')}:{context.get('conversationId', '')}"


def create_agent_router():
    """Factory function to create an AgentRouter."""
    return AgentRouter()
