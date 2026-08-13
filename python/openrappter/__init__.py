"""openrappter - Local-first AI agent powered by GitHub Copilot SDK"""

from openrappter.flight_recorder import (
    FLIGHT_EVENT_SCHEMA,
    FLIGHT_EXPORT_SCHEMA,
    FlightRecorder,
    FlightRecorderCorruptionError,
    FlightRecorderUnhealthyError,
    SQLiteFlightLedger,
    compute_flight_event_hash,
    ensure_flight_recorder_from_env,
    get_flight_recorder,
    normalize_flight_model_id,
    normalize_flight_session_id,
    normalize_flight_workspace_id,
    sanitize_flight_metadata,
    sanitize_flight_payload,
    sanitize_flight_value,
    set_flight_recorder,
    summarize_flight_error,
    verify_flight_event_hash,
    with_flight_trace,
)

__version__ = "1.12.0"

__all__ = [
    "__version__",
    "FLIGHT_EVENT_SCHEMA",
    "FLIGHT_EXPORT_SCHEMA",
    "FlightRecorder",
    "FlightRecorderCorruptionError",
    "FlightRecorderUnhealthyError",
    "SQLiteFlightLedger",
    "compute_flight_event_hash",
    "ensure_flight_recorder_from_env",
    "get_flight_recorder",
    "normalize_flight_model_id",
    "normalize_flight_session_id",
    "normalize_flight_workspace_id",
    "sanitize_flight_metadata",
    "sanitize_flight_payload",
    "sanitize_flight_value",
    "set_flight_recorder",
    "summarize_flight_error",
    "verify_flight_event_hash",
    "with_flight_trace",
]
