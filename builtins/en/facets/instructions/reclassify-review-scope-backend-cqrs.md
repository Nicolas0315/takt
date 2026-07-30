Inspect the cumulative diff after the fix and expand the current review scope only when required.
Do not implement or edit files. Return only the structured output.

**Current review scope:** `backend-cqrs`

**Steps:**
1. Inspect the cumulative diff from the task baseline
2. Always include backend and CQRS+ES in the review
3. Do not change to a scope narrower than `backend-cqrs`
4. Expand to `dual-cqrs` when frontend is changed; otherwise keep `backend-cqrs`
5. Put concise diff evidence and whether expansion is required in `rationale`
