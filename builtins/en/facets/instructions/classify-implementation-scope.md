Inspect the plan and existing code, then classify the development area required for implementation into exactly one category.
Do not implement or edit files. Return the decision only through structured output.

**Report to reference:**
- Plan: {report:plan.md}

**Classification criteria:**
- `frontend`: Changes only UI, client state, or in-screen logic
- `backend`: Changes only APIs, servers, persistence, batches, or other backend concerns without requiring CQRS+ES expertise
- `dual`: Changes both frontend and backend without requiring CQRS+ES expertise
- `backend-cqrs`: Changes only backend concerns and requires CQRS+ES expertise
- `dual-cqrs`: Changes both frontend and backend and requires CQRS+ES expertise

**Actions:**
1. Inspect the existing code to identify the changes required to satisfy the request and plan
2. Classify the scope of this implementation, not the repository as a whole
3. Select a CQRS+ES category only when the request or affected code genuinely requires that design
4. Return the category in `work_type` and a concise justification in `rationale`
