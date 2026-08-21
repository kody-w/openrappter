# Interim PR9 reference patch

`pr9_reference.py` remains the byte-identical copy of `rapp-1` commit
`392f850`. `pr9_interim.py` applies four isolated runtime fixes requested by
OpenRappter review:

1. deterministic depth-64 and 1 MiB canonicalization failures, including
   `RecursionError` conversion;
2. refusal of legacy numeric host aliases;
3. full-string token matching rather than end-before-newline matches;
4. ASCII word boundaries for decoded secret scanning.

This patch is temporary. Before publication, replace the reference and delete
the interim module after re-vendoring from the forthcoming protocol commit that
contains equivalent fixes.
