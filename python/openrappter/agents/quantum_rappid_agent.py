"""Read and propose against local Quantum RAPPIDs, and never append to one.

Mirrors ``typescript/src/agents/QuantumRappidAgent.ts``.

The model-facing surface is deliberately read-and-propose only. Growth is an
append to an organism's own history, and an append is exactly the thing that
must go through the authenticated Habitat approval seam rather than through a
tool a model can call on its own: a proposal that becomes state without a
person saying yes is not a proposal. Anything that is not one of the six
operations below -- including ``grow`` -- is refused with that reason said out
loud.

The organism's external episode pointer is dropped from everything this agent
returns. It names a private local memory key, and nothing these operations do
needs it.
"""

from __future__ import annotations

import json
from typing import Any, Dict

from openrappter.agents.basic_agent import BasicAgent

try:
    from openrappter.rappids import (
        complete_rappid,
        inspect_organism,
        list_organism_summaries,
        playback_manifest,
        propose_growth,
        verify_rappid,
    )
    RAPPIDS_AVAILABLE = True
except ModuleNotFoundError:
    # Brainstem/RAR loaders intentionally execute one agent file with only the
    # BasicAgent contract available. Keep metadata discoverable and fail closed
    # at invocation instead of making the entire agent sweep fail.
    RAPPIDS_AVAILABLE = False

    def _unavailable(*_args, **_kwargs):
        raise RuntimeError(
            "Quantum RAPPIDs require the full OpenRappter runtime package."
        )

    complete_rappid = _unavailable
    inspect_organism = _unavailable
    list_organism_summaries = _unavailable
    playback_manifest = _unavailable
    propose_growth = _unavailable
    verify_rappid = _unavailable


__manifest__ = {
    "schema": "rapp-agent/1.0",
    "name": "@openrappter/quantum-rappid",
    "version": "1.0.0",
    "display_name": "Quantum RAPPID",
    "description": (
        "Inspects and verifies local Quantum RAPPIDs and proposes "
        "non-authoritative append-only growth."
    ),
    "author": "Kody Wildfeuer",
    "ring": "ga",
    "capabilities": [],
    "tags": ["openrappter", "rappid", "local-first", "organism"],
    "category": "memory",
    "quality_tier": "official",
    "requires_env": [],
}

#: Everything this agent will answer. Mutation is not on the list, and the
#: fallback branch says why rather than failing as if the name were a typo.
OPERATIONS = ("list", "inspect", "verify", "complete", "propose", "playback-manifest")


def _model_safe_summary(summary: Dict[str, Any]) -> Dict[str, Any]:
    """A summary without the pointer to the organism's private memory."""
    safe = dict(summary)
    safe.pop("externalEpisode", None)
    return safe


class QuantumRappidAgent(BasicAgent):
    def __init__(self):
        self.name = "QuantumRappid"
        self.metadata = {
            "name": self.name,
            "description": (
                "Inspects, verifies, and proposes append-only growth for local "
                "Quantum RAPPIDs. It never appends growth; the authenticated "
                "Habitat approval seam owns mutation."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "operation": {
                        "type": "string",
                        "enum": list(OPERATIONS),
                        "description": "Read or proposal operation.",
                    },
                    "rappid": {
                        "type": "string",
                        "description": "Canonical rappid:@owner/slug:<64hex> identity.",
                    },
                    "dimension": {
                        "type": "string",
                        "enum": ["sonic", "stats"],
                        "description": (
                            "Dimension to autocomplete as a non-authoritative proposal."
                        ),
                    },
                },
                "required": ["operation"],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        operation = str(kwargs.get("operation") or "")
        rappid = kwargs.get("rappid")
        rappid = rappid if isinstance(rappid, str) else ""

        if operation == "list":
            try:
                organisms = [
                    _model_safe_summary(summary)
                    for summary in list_organism_summaries()
                ]
            except Exception as error:
                return json.dumps(
                    {"status": "error", "operation": operation, "message": str(error)}
                )
            return json.dumps(
                {"status": "success", "operation": operation, "organisms": organisms}
            )

        if not rappid:
            return json.dumps(
                {
                    "status": "error",
                    "operation": operation,
                    "message": "rappid is required",
                }
            )

        try:
            if operation == "inspect":
                inspection = dict(inspect_organism(rappid))
                inspection["summary"] = _model_safe_summary(inspection["summary"])
                # The habitat path is the operator's filesystem rather than the
                # organism: there is nothing there for a model to read.
                inspection.pop("directory", None)
                result: Any = inspection
            elif operation == "verify":
                result = verify_rappid(rappid).to_wire()
            elif operation == "complete":
                result = complete_rappid(rappid)
            elif operation == "propose":
                dimension = kwargs.get("dimension")
                result = propose_growth(
                    rappid, dimension if isinstance(dimension, str) else "stats"
                ).to_wire()
            elif operation == "playback-manifest":
                result = playback_manifest(rappid).to_wire()
            else:
                return json.dumps(
                    {
                        "status": "error",
                        "operation": operation,
                        "message": (
                            "Unknown or mutating operation. Growth requires the "
                            "authenticated Habitat approval flow."
                        ),
                    }
                )
        except Exception as error:
            return json.dumps(
                {"status": "error", "operation": operation, "message": str(error)}
            )

        return json.dumps(
            {
                "status": "success",
                "operation": operation,
                "result": result,
                "data_slush": {
                    "source_agent": self.name,
                    "rappid": rappid,
                    # Every operation here reads or predicts. None of them write.
                    "mutation": False,
                },
            }
        )
