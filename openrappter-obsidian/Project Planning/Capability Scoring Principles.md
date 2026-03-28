# Capability Scoring Principles

Design rules for the [[OuroborosAgent]] capability assessment system. These ensure fair, meaningful scoring across evolution generations.

## Rules

### 1. Graduated Thresholds Over Binary Checks

Never treat the mere presence of data as a passing check.

| Metric | Minimum | Statistical |
|--------|---------|-------------|
| Word counts | >= 3 | >= 10 |
| Frequency distributions | >= 3 entries | — |
| Sentiment evidence | >= 2 words | — |

### 2. Inclusive Boundaries

Use `>=` not `>` for ratio thresholds. Natural text often lands exactly on boundaries (e.g., 50% unique word ratio). Excluding the boundary penalizes legitimate input.

### 3. Polarity-Agnostic Sentiment

Sentiment quality measures **detection accuracy**, not tonal range. Pure positive text ("amazing wonderful great") should score 100% if detected correctly. Never require both positive AND negative words.

### 4. Pass/Fail Where Appropriate

Some checks are inherently binary:
- Caesar cipher roundtrip (works or doesn't)
- Pattern detection (breadth across categories)
- Reflection checks (correctness validation)

Don't force graduated thresholds where binary is the right model.

### 5. Equal Weight Scoring

**Quality** = (passed checks / total checks) * 100

Each check contributes equal weight. Adding a new check changes the denominator for all scores. When adding checks, verify downstream tests and integration expectations.

## Assessment Functions

| Function | What It Scores | Model |
|----------|---------------|-------|
| `checkWordStats` | Word count, unique ratio, distribution | Graduated |
| `checkSentiment` | Positive/negative detection accuracy | Graduated |
| `checkCaesarCipher` | Encryption roundtrip | Binary |
| `checkPatterns` | Category breadth | Graduated |
| `checkReflection` | Correctness | Binary |

## Files
- `typescript/src/agents/OuroborosAgent.ts`
- Tests: `typescript/src/__tests__/parity/ouroboros.test.ts`

## Related
- [[OuroborosAgent]]
- [[WatchmakerAgent]]

---

#project #scoring
