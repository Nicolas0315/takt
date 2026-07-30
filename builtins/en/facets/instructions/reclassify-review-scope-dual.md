Inspect the cumulative diff after the fix and expand the current review scope only when required.
Do not implement or edit files. Return only the structured output.

**Current review scope:** `dual`

**Steps:**
1. Inspect the cumulative diff from the task baseline
2. Always include both frontend and backend in the review
3. Do not change to a scope narrower than `dual`
4. Expand to `dual-cqrs` when CQRS+ES is changed; otherwise keep `dual`
5. Put concise diff evidence and whether expansion is required in `rationale`
