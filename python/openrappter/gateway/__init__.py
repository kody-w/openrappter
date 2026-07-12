"""
openrappter Gateway Package

WebSocket gateway, streaming sessions, and dashboard REST API.
"""

from openrappter.gateway.streaming import StreamManager, StreamBlock, StreamSession, stream_manager
from openrappter.gateway.dashboard import DashboardHandler
from openrappter.gateway.server import GatewayServer, GatewayError, RPC_ERROR
from openrappter.gateway.observability import GatewayMetrics

__all__ = [
    'StreamManager',
    'StreamBlock',
    'StreamSession',
    'stream_manager',
    'DashboardHandler',
    'GatewayServer',
    'GatewayError',
    'RPC_ERROR',
    'GatewayMetrics',
]
