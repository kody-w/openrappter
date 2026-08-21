# The brainstem is a single-file server in the parent directory — make it
# importable for tests living here (the root stays clean; see CLAUDE.md).
import sys
from pathlib import Path

# Parent (rapp_brainstem/) → import brainstem, local_storage.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
# This dir (tests/) → import soul_hash, the soul-refresh hasher that lives here
# alongside its manifest and enforcing test (the engine root stays grail).
sys.path.insert(0, str(Path(__file__).resolve().parent))
