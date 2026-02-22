import time
import uuid
from .chunker import chunk_content, generate_snippet


class MemoryChunk:
    def __init__(self, chunk_id, content, source='', source_path='', metadata=None):
        self.id = chunk_id
        self.content = content
        self.source = source
        self.source_path = source_path
        self.metadata = metadata or {}
        self.created_at = time.time()


class MemoryManager:
    def __init__(self, chunk_size=512, chunk_overlap=50):
        self._chunks = {}  # id -> MemoryChunk
        self._chunk_size = chunk_size
        self._chunk_overlap = chunk_overlap
        self._counter = 0

    def _next_id(self):
        self._counter += 1
        return f'mem_{int(time.time())}_{self._counter}'

    def add(self, content, source='', source_path='', metadata=None):
        """Add content, chunk it, store chunks. Return first chunk id."""
        chunks = chunk_content(content, self._chunk_size, self._chunk_overlap)
        if not chunks:
            return None
        first_id = None
        for chunk_text in chunks:
            chunk_id = self._next_id()
            self._chunks[chunk_id] = MemoryChunk(chunk_id, chunk_text, source, source_path, metadata)
            if first_id is None:
                first_id = chunk_id
        return first_id

    def search_fts(self, query, sources=None):
        """Full-text search across chunks."""
        terms = [t.lower() for t in query.split() if len(t) > 2]
        if not terms:
            return []

        results = []
        for chunk in self._chunks.values():
            if sources and chunk.source not in sources:
                continue
            lower = chunk.content.lower()
            matches = sum(1 for t in terms if t in lower)
            if matches > 0:
                score = matches / len(terms)
                results.append({
                    'score': score,
                    'chunk': {
                        'id': chunk.id,
                        'content': chunk.content,
                        'source': chunk.source,
                    },
                })

        results.sort(key=lambda r: r['score'], reverse=True)
        return results

    def get_status(self):
        return {'total_chunks': len(self._chunks)}

    def get_chunk(self, chunk_id):
        chunk = self._chunks.get(chunk_id)
        if not chunk:
            return None
        return {'id': chunk.id, 'content': chunk.content, 'source': chunk.source}

    def list_chunks(self, source=None):
        chunks = self._chunks.values()
        if source:
            chunks = [c for c in chunks if c.source == source]
        return [{'id': c.id, 'content': c.content, 'source': c.source} for c in chunks]

    def remove(self, chunk_id):
        return self._chunks.pop(chunk_id, None) is not None

    def clear(self):
        self._chunks.clear()
