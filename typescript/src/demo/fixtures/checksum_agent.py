import hashlib
import json

from openrappter.agents.basic_agent import BasicAgent


class ChecksumAgent(BasicAgent):
    def __init__(self):
        metadata = {
            "name": "ChecksumAgent",
            "description": "Deterministically computes the SHA-256 digest of a query.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "UTF-8 text to hash.",
                    }
                },
                "required": ["query"],
            },
        }
        super().__init__(name="ChecksumAgent", metadata=metadata)

    def perform(self, **kwargs):
        query = kwargs.get("query", "")
        if not isinstance(query, str):
            raise TypeError("query must be a string")
        digest = hashlib.sha256(query.encode("utf-8")).hexdigest()
        return json.dumps(
            {
                "status": "success",
                "output": {
                    "algorithm": "sha256",
                    "digest": digest,
                },
            },
            separators=(",", ":"),
        )
