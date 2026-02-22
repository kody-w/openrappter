import re


def chunk_content(content, chunk_size=512, overlap=50):
    """Split content into overlapping chunks."""
    if not content:
        return []
    if len(content) <= chunk_size:
        return [content]

    chunks = []
    step = max(1, chunk_size - overlap)
    pos = 0
    while pos < len(content):
        chunk = content[pos:pos + chunk_size]
        if chunk.strip():  # skip empty chunks
            chunks.append(chunk)
        if pos + chunk_size >= len(content):
            break
        pos += step
    return chunks


def generate_snippet(content, query, max_length=200):
    """Generate a snippet highlighting query terms."""
    if not content or not query:
        return content[:max_length] if content else ''

    terms = [t.lower() for t in query.split() if len(t) > 2]
    if not terms:
        return content[:max_length]

    # Find first term match
    lower_content = content.lower()
    match_pos = -1
    for term in terms:
        pos = lower_content.find(term)
        if pos != -1:
            match_pos = pos
            break

    if match_pos == -1:
        return content[:max_length]

    # Extract around match
    half = max_length // 2
    start = max(0, match_pos - half)
    end = min(len(content), start + max_length)
    if end - start < max_length:
        start = max(0, end - max_length)

    snippet = content[start:end]
    prefix = '...' if start > 0 else ''
    suffix = '...' if end < len(content) else ''
    return f'{prefix}{snippet}{suffix}'
