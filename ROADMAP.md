# Capability Scoring Roadmap

Roadmap for the OuroborosAgent capability assessment system (`typescript/src/agents/OuroborosAgent.ts`).

The scoring system currently uses five deterministic checks (`checkWordStats`, `checkSentiment`, `checkCaesarCipher`, `checkPatterns`, `checkReflection`) with graduated thresholds, inclusive boundaries, polarity-agnostic sentiment, and per-capability trend tracking via `computeTrends`. This document outlines what comes next.

---

## Phase 1: Quick Wins

Low risk, high signal improvements that slot into existing check functions.

### Lexical entropy in `checkWordStats`

Add Shannon entropy of the word frequency distribution as a new check. The frequency map already exists (`freq` in `wordStats()`), so entropy is a few lines:

```
H = -sum(p * log2(p))   where p = count / total
```

Higher entropy = richer vocabulary. Threshold: `H >= 2.0` for a passing check.

**Rationale:** The current `has_diversity` check uses a simple unique/total ratio. Entropy captures distributional shape — a text with 10 unique words used once each scores higher than one where a single word dominates, even if both have the same unique ratio.

### Negation handling in `checkSentiment`

`analyzeSentiment()` currently matches bare words against positive/negative lists. "Not good" scores as positive because "good" is in the list. Add a negation window: if any of `[not, no, never, don't, doesn't, isn't, wasn't, aren't, won't, can't, couldn't, shouldn't]` appears within 2 tokens before a sentiment word, flip its polarity.

**Rationale:** Without negation handling, the sentiment check can be confidently wrong on common phrases. This is the single highest-signal improvement to sentiment accuracy.

### Per-capability trajectory tracking

`computeTrajectory()` currently computes a single linear regression slope on `overall_quality` across runs. Extend it to compute an independent slope per capability using each run's `level_qualities[i]`.

**Rationale:** Overall trajectory masks divergent trends. Word stats might be improving while sentiment declines — the current system can't detect this. Per-capability slopes enable targeted feedback.

### Confidence intervals on trajectory

Only report a trajectory trend (improving/declining) when the slope exceeds 2x its standard error. Currently any nonzero slope gets reported.

**Rationale:** With small run counts (3-5 runs), noise dominates. A trajectory of +0.3 on 4 data points isn't meaningful. Standard error gates prevent false trend signals.

### Input difficulty scoring

Score how well-suited the input text is to each capability. An input with no emails, URLs, or dates will always score 0/4 on pattern detection — that's an input limitation, not a capability failure.

**Rationale:** The current system can't distinguish "the capability is broken" from "the input didn't contain relevant content." Input profiling (already partially implemented via `inputProfile` in `_wrapFinalReport`) provides the denominator for that distinction.

---

## Phase 2: Graduated Scoring

Replace remaining binary checks with graduated quality measures.

### Weighted sentiment words

Assign intensity tiers: `"good" = 0.5`, `"amazing" = 1.0`, `"absolutely amazing" = 1.5`. Replace the current equal-weight word counting with weighted sums. The sentiment score formula becomes `(weighted_pos - weighted_neg) / (weighted_pos + weighted_neg)`.

**Rationale:** "Good" and "amazing" currently contribute equally. Intensity weighting makes the sentiment score more discriminating and enables a graduated `has_confidence` check instead of the current binary `abs(score) > 0.2` threshold.

### Pattern quality scoring

The current `checkPatterns` uses four binary found/not-found checks. Replace with:
- **Well-formedness**: validate that matched patterns are plausible (e.g., emails contain valid TLDs, URLs resolve to valid structure)
- **Density**: patterns found / input length, normalized
- **False-positive penalty**: deduct for matches that fail validation

**Rationale:** Finding "123" as a number match is trivially easy. The current system can't distinguish high-quality pattern detection from noise matches.

### Character-level cipher verification

The current `checkCaesarCipher` verifies roundtrip and transformation but doesn't check individual characters. Add a check that verifies every alphabetic character was shifted by exactly the expected amount and that case was preserved.

**Rationale:** A cipher implementation that only shifts some characters (e.g., skipping non-ASCII) would pass the current checks. Character-level verification catches partial implementations.

### Reflection method verification

`checkReflection` currently checks that `capability_count > 0` and `className` includes "Gen5". Add cross-validation: compare the declared methods list against the actual prototype chain to verify accuracy.

**Rationale:** The reflection capability claims to list its own methods, but the current check doesn't verify the list is correct. A reflection that over-counts or under-counts should score lower.

### Lexical diversity index

Replace the simple `unique / total` ratio in `checkWordStats` with Simpson's Diversity Index or type-token ratio (TTR) with a standardized sample size. Simpson's D accounts for frequency distribution, not just presence/absence.

**Rationale:** The current `has_diversity` check passes at `>= 0.5` unique ratio. This is a blunt instrument — Simpson's D naturally handles the difference between "many words used once" and "a few words used often."

---

## Phase 3: Cross-Capability Intelligence

Track how capabilities affect each other over history.

### Correlation engine

Build a correlation matrix across capability scores using the `lineage-log.json` history. For each pair of capabilities, compute Pearson correlation on their `level_qualities` over the last N runs.

**Rationale:** Capabilities aren't independent. Word diversity likely correlates with sentiment breadth. Understanding these relationships enables smarter recommendations ("improving your vocabulary will likely improve sentiment detection too").

### Target correlations to investigate

- **Word diversity -> sentiment breadth**: richer vocabulary should yield more sentiment-bearing words
- **Pattern density -> entropy relationship**: inputs with many structured patterns (emails, URLs) tend to have lower lexical entropy
- **Reflection accuracy -> actual capability count**: reflection should correctly count available capabilities

### Bottleneck identification

Identify which capability is holding overall quality down. The bottleneck is the capability with the lowest quality that has the highest average correlation with other capabilities — improving it would have the largest ripple effect.

**Rationale:** The current system treats all five capabilities independently. Bottleneck detection converts the report from "here are five scores" to "fix this one thing to improve everything."

---

## Phase 4: Predictive & LLM-Enhanced

Leverage the existing `enhanceWithLLM` pipeline and trajectory data for forward-looking intelligence.

### Root-cause LLM analysis

Change the LLM prompt from "write improvement suggestions" to "diagnose why this capability is weak." Feed the raw capability output (word frequencies, matched patterns, sentiment words) alongside the score breakdown so the LLM can point to specific failure modes.

**Rationale:** The current LLM enhancement produces generic suggestions. With raw data, it can say "sentiment scored low because the only sentiment word was 'good' which appeared in a negation context" instead of "try using more sentiment-bearing words."

### Predictive quality model

Extrapolate the trajectory with confidence bounds. Using the existing `computeTrajectory` linear regression, add prediction intervals: "at current trajectory, overall quality will reach 80 in ~3 runs (p=0.7)."

**Rationale:** Trajectory is currently backwards-looking ("things have been improving"). Prediction makes it actionable ("you're N runs from strong status").

### Input-capability matching assessment via LLM

Use the LLM to evaluate whether the input text is a fair test of each capability. An input with no emails shouldn't penalize pattern detection. The LLM can assess this more nuancedly than rule-based `inputProfile`.

**Rationale:** Phase 1 input difficulty scoring handles obvious cases (no emails = no email detection). LLM assessment handles subtle cases (sarcastic text that confuses sentiment, ambiguous date formats).

### Confidence-scored LLM suggestions

Wrap each LLM suggestion with a confidence score based on how much data supports it. Suggestions backed by 10+ runs of history get high confidence; first-run suggestions get low confidence.

**Rationale:** The current LLM suggestions have no epistemic humility. A suggestion based on one run shouldn't carry the same weight as one based on a clear 10-run trend.

### Multi-run archival summaries

The lineage log currently caps at 20 runs (`MAX_LINEAGE_ENTRIES`). Before evicting old entries, generate a compressed summary: average quality by capability, trend direction, notable events (status changes, quality jumps).

**Rationale:** After 20 runs, history is lost. Archival summaries preserve long-term signal without unbounded storage growth.

### Enriched `data_slush` signals

Expand the `data_slush` output (currently in `_wrapFinalReport`) with:
- Confidence intervals on each capability score
- Volatility metric (standard deviation of quality over recent runs)
- Growth headroom (distance to next status tier)
- Specific recommendations keyed by capability

**Rationale:** Downstream agents consuming `data_slush` currently get raw scores. Enriched signals let them make informed routing decisions ("this agent's sentiment is volatile, route sentiment-heavy queries elsewhere").

---

## Trend System Improvements

Cross-cutting enhancements to `computeTrends` and trajectory tracking.

### Weighted regression

Weight recent runs more heavily in trajectory calculation. The current `computeTrajectory` uses uniform weights. Apply exponential decay: `weight = decay^(n - i)` where `decay = 0.85`.

**Rationale:** A quality improvement 15 runs ago matters less than one 2 runs ago. Weighted regression makes trajectory more responsive to recent changes.

### Magnitude-aware multipliers

The current streak multiplier (`computeTrends`) treats all improvements equally — a +1 quality delta gets the same multiplier as a +20 delta. Scale the multiplier by the average magnitude of improvements in the streak.

**Rationale:** Three consecutive +1 improvements shouldn't earn the same bonus as three consecutive +15 improvements. Magnitude awareness rewards real progress.

### Volatility penalty

If a capability's quality oscillates (e.g., 60, 80, 55, 85), reduce its trend multiplier even if the overall direction is positive. Measure volatility as the standard deviation of run-over-run deltas.

**Rationale:** Erratic scores indicate unreliable capability behavior. The trend system shouldn't reward inconsistency.

### Softer trend thresholds

`computeTrends` currently requires 3 consecutive same-direction changes before applying a multiplier. Lower to 2 consecutive for a reduced multiplier (e.g., `1.02` instead of `1.05`), keeping 3+ for the full multiplier.

**Rationale:** Nascent trends are real but uncertain. Detecting them earlier (with smaller effect) provides earlier signal without overreacting.

### Acceleration tracking

Track the slope of slopes — is the rate of improvement itself increasing or decreasing? If trajectory was +2 over the last 5 runs but +5 over the last 3, the agent is accelerating.

**Rationale:** Trajectory tells you direction. Acceleration tells you momentum. An agent with positive trajectory but negative acceleration is about to plateau — useful for predictive feedback.

---

## Implementation Notes

- Each phase builds on the previous. Phase 2 items assume Phase 1 is in place (e.g., weighted sentiment needs negation handling first).
- All scoring changes must follow the principles in `CLAUDE.md`: graduated thresholds, inclusive boundaries (`>=`), polarity-agnostic sentiment, quality = passed/total * 100.
- Adding a new check changes the denominator for all scores in that capability. Verify downstream tests (`typescript/src/__tests__/parity/ouroboros.test.ts`) after each addition.
- Trend system changes affect all capabilities simultaneously. Test with synthetic lineage logs before deploying.
- LLM-enhanced features (Phase 4) degrade gracefully — `enhanceWithLLM` already returns `false` on failure, keeping deterministic scores intact.
