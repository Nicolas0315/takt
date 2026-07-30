Inspect the cumulative diff after the fix and expand the current review scope only when required.
Do not implement or edit files. Return only the structured output.

**Current review scope:** `backend`

**Steps:**
1. Inspect the cumulative diff from the task baseline
2. Always include `backend` and take its union with any additional changed areas
3. Do not change to a scope narrower than `backend`
4. Output `backend`, `dual`, `backend-cqrs`, or `dual-cqrs` in `work_type`
5. Put concise diff evidence and whether expansion is required in `rationale`
