Focus on reviewing **failure behavior and recovery boundaries**.

Procedure:
1. Open the Knowledge and Policy Source Paths with the Read tool and read them in full
2. Enumerate every `##` section without omitting any
3. Check the changed code against the criteria in every enumerated section and detect applicable problems

**This is review iteration {step_iteration}.** On the first review, exhaust each finding family across the cumulative diff. On later reviews, apply every criterion to the previous open findings, their fixes, and directly affected paths without rescanning unchanged areas from scratch. Before issuing APPROVE with no blocking finding in the focused scope, perform one final review of the cumulative diff.
{{include:instructions/review-pr-context}}
