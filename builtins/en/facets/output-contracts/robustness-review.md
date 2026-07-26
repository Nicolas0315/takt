```markdown
# Robustness Review

## Result: APPROVE / REJECT

## Summary
{Conclusion in 1-2 sentences}

## New Findings
| # | finding_id | family_tag | Severity | Location | Problem | Failure Condition | Suggested Fix |
|---|------------|------------|----------|----------|---------|-------------------|---------------|
| 1 | ROB-NEW-src-file-L42 | robustness | High / Medium / Low | `src/file.ts:42` | {Problem} | {Failure, retry, or interruption condition} | {Suggested fix} |

## Persisting Findings
| finding_id | Previous Evidence | Current Evidence | Problem | Suggested Fix |
|------------|-------------------|------------------|---------|---------------|
| ROB-PERSIST-src-file-L77 | `src/file.ts:77` | `src/file.ts:77` | {Unresolved problem} | {Suggested fix} |

## Resolved Findings
| finding_id | Original Expected Result | Resolution Evidence |
|------------|--------------------------|---------------------|
| ROB-RESOLVED-src-file-L10 | {Original finding acceptance condition} | Resolved at `src/file.ts:10` |

## Reopened Findings
| finding_id | Reproduction | Expected | Actual | Location |
|------------|--------------|----------|--------|----------|
| ROB-REOPENED-src-file-L55 | {Reproduction steps} | {Expected result} | {Actual result} | `src/file.ts:55` |

## Verification Evidence
- Failure paths: {Target, verification, and result}
- Retry, interruption, and cleanup: {Target, verification, and result}

## REJECT Conditions
- REJECT only when at least one `new`, `persists`, or `reopened` finding exists
- Findings without a `finding_id` are invalid
```

**Cognitive load rules:**
- APPROVE → summary and verification evidence only
- REJECT → only applicable findings in tables (30 lines maximum)
