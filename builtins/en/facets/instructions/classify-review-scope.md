Compare the planned implementation scope with the cumulative diff from the task baseline, then classify the review scope into exactly one category.
Do not implement or edit files. Return only the structured output.

**Planned implementation scope:** `{structured:classify_implementation_scope.work_type}`

**Steps:**
1. Always include the planned implementation scope in the review
2. Inspect the cumulative diff from the task baseline and add every area actually changed
3. Classify using `review scope = planned implementation scope ∪ actual changed areas`
4. Do not narrow the scope when a planned change is absent from the diff, because that may indicate missing implementation
5. Retain or expand to a CQRS category when the planned scope is `backend-cqrs` / `dual-cqrs` or the actual changes involve CQRS+ES; use a non-CQRS category only when neither applies
6. Put the classification in `work_type` and concise evidence from the plan and diff in `rationale`
