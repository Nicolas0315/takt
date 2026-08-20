Analyze the finished workflow run given in the task and propose prompt improvements that reduce unnecessary loops.

**Input:** The task names the finished run's directory. It contains the session logs under `logs/` (JSONL), `trace.md`, and the run's reports under `reports/`. Read them before proposing anything.

**Analysis:**
1. Reconstruct what the run was trying to do and how its iterations progressed.
2. Identify loop patterns: repeated identical tool calls, files read again without new need, retry cycles without changed strategy, rework loops between steps, iterations that made no observable progress.
3. For each loop, find the prompt-level cause: the instruction, persona, policy, knowledge, or output contract whose text failed to prevent it.

**Proposals:**
- Each proposal names the concrete facet file path (persona / policy / knowledge / instruction / output-contract) and the exact amendment: the text to add or the change to make.
- Each proposal cites the observed loop as evidence.
- Propose only changes that would help runs beyond this one.

**Rework after a review rejection:**
- The previous reviewer response lists rejected proposals with reasons.
- Keep adopted proposals stable, revise or drop rejected ones, and record every rejected proposal with its rejection reason in the report's rejected section.

Write the report to `loop-analysis.md` according to the supplied output contract.
