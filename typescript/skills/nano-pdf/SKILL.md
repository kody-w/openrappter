---
name: nano-pdf
description: Extract text, metadata, and structured content from PDF files.
metadata: {"openclaw":{"emoji":"📄","requires":{"bins":["pdftotext"]},"install":[{"id":"brew","kind":"brew","formula":"poppler","bins":["pdftotext"],"label":"Install poppler (brew)"}]}}
---

# Nano PDF

Extract and process PDF content.

## Extract Text

```bash
pdftotext input.pdf -
```

## Extract Specific Pages

```bash
pdftotext -f 1 -l 5 input.pdf -
```

## Get PDF Info

```bash
pdfinfo input.pdf
```

## Extract as HTML

```bash
pdftohtml input.pdf /tmp/output
```

## Tips

- Use `-layout` flag to preserve formatting
- Use `-raw` for continuous text without page breaks
- Pipe to other tools for further processing
```
