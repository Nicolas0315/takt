Review the loop-analysis report below.

{report:loop-analysis.md}

**Purpose:** Remove over-specialized proposals. Analyzing agents tend to propose prompt changes that only fit the single run they read; those changes degrade the prompt for every other run.

**Review each adopted proposal and reject it when:**
- It only applies to the analyzed run's specific task, domain, or incidental context, and would not generalize to other runs
- It duplicates what the target facet file already says
- Its amendment text does not match the log evidence it cites

**Verdict:**
- `approved`: every adopted proposal is general, non-redundant, and evidence-backed
- `rejected`: at least one proposal fails the checks above

When rejecting, list each rejected proposal with the concrete reason (over-specialized, redundant, or ungrounded) so the analyzer can revise it. Do not rewrite proposals yourself.

**Final report:** Whether you approve or reject, finalize the report. Rewrite `loop-analysis.md` according to the supplied output contract so it carries the adopted proposals and every rejected proposal with its rejection reason, including the rejections from this review. This review is the last writer of the report: even when the rework loop reaches its limit, the file must still show the final verdict's rejections and their reasons.
