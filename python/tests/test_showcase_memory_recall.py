import pytest
from openrappter.memory.chunker import chunk_content, generate_snippet
from openrappter.memory.manager import MemoryManager


def test_overlapping_window_chunking():
    """Verify overlap between adjacent chunks (shared content)."""
    content = 'a' * 600  # longer than default chunk_size=512
    chunks = chunk_content(content, chunk_size=100, overlap=20)
    assert len(chunks) >= 2
    # Adjacent chunks share 'overlap' characters
    first_end = chunks[0][-20:]
    second_start = chunks[1][:20]
    assert first_end == second_start, "Adjacent chunks must share overlapping content"


def test_short_content_single_chunk():
    """Short content stays as a single chunk."""
    content = 'Hello, world!'
    chunks = chunk_content(content, chunk_size=512, overlap=50)
    assert len(chunks) == 1
    assert chunks[0] == content


def test_add_content_creates_chunks():
    """add() stores content; get_status() reports total_chunks > 0."""
    manager = MemoryManager(chunk_size=512, chunk_overlap=50)
    manager.add('Some interesting content about memory management.', source='doc1')
    status = manager.get_status()
    assert status['total_chunks'] > 0


def test_fts_search_returns_results_with_score():
    """FTS search returns relevant results with score > 0."""
    manager = MemoryManager()
    manager.add('Python memory management uses garbage collection.', source='python_docs')
    results = manager.search_fts('memory management')
    assert len(results) > 0
    assert results[0]['score'] > 0


def test_source_filtering():
    """Search with sources=['src1'] returns only src1 results."""
    manager = MemoryManager()
    manager.add('Machine learning and neural networks are fascinating topics.', source='src1')
    manager.add('Machine learning is used in many applications today.', source='src2')

    results = manager.search_fts('machine learning', sources=['src1'])
    assert len(results) > 0
    for r in results:
        assert r['chunk']['source'] == 'src1', "All results must come from src1"


def test_snippet_generation_highlights_query_term():
    """generate_snippet returns a snippet that contains the query term."""
    content = (
        'This is an introductory paragraph. ' * 5
        + 'The concept of recursion is fundamental in computer science. '
        + 'More text follows here. ' * 5
    )
    snippet = generate_snippet(content, 'recursion', max_length=200)
    assert 'recursion' in snippet.lower(), "Snippet must contain the query term"


def test_clear_resets_chunk_count():
    """clear() resets total_chunks to 0."""
    manager = MemoryManager()
    manager.add('First document content here.', source='doc1')
    manager.add('Second document content here.', source='doc2')
    assert manager.get_status()['total_chunks'] > 0

    manager.clear()
    assert manager.get_status()['total_chunks'] == 0


def test_remove_chunk():
    """remove(id) returns True; subsequent get_chunk returns None."""
    manager = MemoryManager()
    first_id = manager.add('Content to be removed later.', source='temp')
    assert first_id is not None

    # Verify chunk exists
    assert manager.get_chunk(first_id) is not None

    # Remove it
    result = manager.remove(first_id)
    assert result is True, "remove() must return True for an existing chunk"

    # Verify it's gone
    assert manager.get_chunk(first_id) is None
