"""
BroadcastManager - Send messages to multiple agents simultaneously.

Modes:
  all      - Send to all agents, wait for all responses
  race     - Send to all agents, return first success
  fallback - Try agents sequentially until one succeeds

In fallback mode, data_slush from each failed agent is passed as
upstream_slush to the next agent in line.

Mirrors TypeScript agents/broadcast.ts
"""

import asyncio


class BroadcastManager:
    """Manages broadcast groups for multi-agent messaging."""

    def __init__(self):
        self._groups = {}

    def create_group(self, group):
        """Create a broadcast group.

        Args:
            group: dict with keys: id, name, agentIds, mode, timeout (optional)
        """
        self._groups[group['id']] = group

    def remove_group(self, group_id):
        """Remove a broadcast group. Returns True if removed."""
        if group_id in self._groups:
            del self._groups[group_id]
            return True
        return False

    def get_group(self, group_id):
        """Get a broadcast group by ID."""
        return self._groups.get(group_id)

    def get_groups(self):
        """Get all broadcast groups."""
        return list(self._groups.values())

    async def broadcast(self, group_id, message, executor):
        """Broadcast message to a group.

        Args:
            group_id: The broadcast group ID
            message: The message to send
            executor: async callable(agent_id, message, upstream_slush=None) -> AgentResult

        Returns:
            BroadcastResult dict
        """
        group = self._groups.get(group_id)
        if not group:
            raise ValueError(f"Broadcast group not found: {group_id}")

        mode = group.get('mode', 'all')
        if mode == 'all':
            return await self._broadcast_all(group, message, executor)
        elif mode == 'race':
            return await self._broadcast_race(group, message, executor)
        elif mode == 'fallback':
            return await self._broadcast_fallback(group, message, executor)
        else:
            return await self._broadcast_all(group, message, executor)

    async def _broadcast_all(self, group, message, executor):
        """Broadcast to all agents and wait for all responses."""
        results = {}
        first_response = None
        timeout = group.get('timeout')

        async def run_agent(agent_id):
            nonlocal first_response
            try:
                coro = executor(agent_id, message)
                if timeout:
                    result = await asyncio.wait_for(coro, timeout=timeout / 1000)
                else:
                    result = await coro
                results[agent_id] = result
                if first_response is None:
                    first_response = {'agentId': agent_id, 'result': result}
            except Exception as e:
                results[agent_id] = e

        await asyncio.gather(*[run_agent(aid) for aid in group['agentIds']], return_exceptions=True)

        successes = sum(1 for r in results.values() if not isinstance(r, Exception))

        return {
            'groupId': group['id'],
            'results': results,
            'firstResponse': first_response,
            'allSucceeded': successes == len(group['agentIds']),
            'anySucceeded': successes > 0,
        }

    async def _broadcast_race(self, group, message, executor):
        """Broadcast to all agents and return first response."""
        results = {}
        first_response = None
        timeout = group.get('timeout')

        async def run_agent(agent_id):
            try:
                coro = executor(agent_id, message)
                if timeout:
                    result = await asyncio.wait_for(coro, timeout=timeout / 1000)
                else:
                    result = await coro
                results[agent_id] = result
                return {'agentId': agent_id, 'result': result, 'success': True}
            except Exception as e:
                results[agent_id] = e
                raise

        tasks = [asyncio.create_task(run_agent(aid)) for aid in group['agentIds']]

        # Wait for first successful result
        try:
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)

            for task in done:
                if not task.cancelled() and task.exception() is None:
                    r = task.result()
                    if r.get('success'):
                        first_response = {'agentId': r['agentId'], 'result': r['result']}
                        break

            # Cancel pending tasks
            for task in pending:
                task.cancel()

            # Wait for remaining to finish
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
        except Exception:
            pass

        # Wait for all tasks to be done
        await asyncio.gather(*tasks, return_exceptions=True)

        successes = sum(1 for r in results.values() if not isinstance(r, Exception))

        return {
            'groupId': group['id'],
            'results': results,
            'firstResponse': first_response,
            'allSucceeded': successes == len(group['agentIds']),
            'anySucceeded': successes > 0,
        }

    async def _broadcast_fallback(self, group, message, executor):
        """Try agents in order until one succeeds.

        In fallback mode, data_slush from each failed agent is passed
        as upstream_slush to the next agent.
        """
        results = {}
        first_response = None
        last_slush = None
        timeout = group.get('timeout')

        for agent_id in group['agentIds']:
            try:
                coro = executor(agent_id, message, last_slush)
                if timeout:
                    result = await asyncio.wait_for(coro, timeout=timeout / 1000)
                else:
                    result = await coro
                results[agent_id] = result
                first_response = {'agentId': agent_id, 'result': result}
                break  # Success, stop trying
            except Exception as e:
                results[agent_id] = e
                # Extract data_slush from failed agent for downstream chaining
                if hasattr(e, 'result') and isinstance(e.result, dict) and 'data_slush' in e.result:
                    last_slush = e.result['data_slush']

        successes = sum(1 for r in results.values() if not isinstance(r, Exception))

        return {
            'groupId': group['id'],
            'results': results,
            'firstResponse': first_response,
            'allSucceeded': successes == len(group['agentIds']),
            'anySucceeded': successes > 0,
        }


def create_broadcast_manager():
    """Factory function to create a BroadcastManager."""
    return BroadcastManager()
