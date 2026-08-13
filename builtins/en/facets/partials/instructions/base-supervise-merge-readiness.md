# Final Merge-Readiness Adjudication

{{include:instructions/contract-family-final-preservation}}

**Current review resolution:**
{report:review-resolution.md}

{{include:instructions/final-readiness-checks}}

## Final supervisor decision boundary

This step is a single final adjudication of whether the current deliverable is mergeable, not another broad specialist review.

1. Reconcile the latest code, original requirements, the current review resolution above, fix plan, fix verification, and quality-gate evidence as authoritative inputs. Judge peer-review completion by whether actionable work remains after the latest adjudication, not by a raw verdict from an individual reviewer
2. Do not reopen a finding previously adjudicated as non-actionable unless the post-adjudication code or requirements provide new counter-evidence. A reviewer's original REJECT alone is not grounds to reopen it
3. Limit new evidence to unmet requirements, unmigrated or obsolete paths, one-sided updates, remediation regressions, or remediable verification gaps in declared actionable families. Do not turn another specialist rescan, an improvement suggestion, or a new family into a finding
4. Consolidate evidence with the same root cause and acceptance criteria into its existing family and state acceptance criteria that can be checked after remediation
5. Return `FIX REQUIRED` for problems fixable under the current requirements and design assumptions; return `TASK REPLAN REQUIRED` only for conflicts that require changing those requirements or assumptions
6. Return `BLOCKED BY ENVIRONMENT` only when mandatory evidence cannot be obtained due to the environment, the current prompt provides environmental criteria, and every condition holds. Do not classify a failure fixable in code or repository configuration as environmental
7. Return `MERGEABLE` only when no open findings remain and requirement fulfillment plus required quality-gate evidence are established
8. When mandatory evidence is unverified, use the original requirements and the Completion Contract-Test Matrix as the source of truth and classify the gate as `change_direct`, `cross_cutting`, or `unknown`
   - `change_direct`: The gate is mapped to the primary evidence for a contract or requirement scenario changed in this diff, or it is the only gate that can observe an acceptance condition
   - `cross_cutting`: The gate is not `change_direct`, every contract changed in this diff has a separate direct verification that succeeded against the current diff, and the missing gate does not remove direct evidence for a changed contract
   - `unknown`: No mapping exists, primary and supporting evidence cannot be distinguished, or more than one classification is plausible
9. Never infer `unknown` as `cross_cutting`. Do not classify by change-file count, line count, docs/core heuristics, or other change-size heuristics
10. If an executed gate reports an assertion, type-check, build, or lint failure, treat it as a failure rather than unverified and do not use `deferred`. Treat a gate as an unverified candidate only when OS, capability, external service, credential, or hardware absence prevented execution
11. Allow `deferred` only when every condition below holds
    - There are zero unresolved actionable findings
    - Every contract changed in this diff has successful direct verification
    - Every required requirement and quality gate other than the unverified gate is satisfied or successful
    - There are zero failed gates
    - Exactly one mandatory gate is unverified at the configured gate-unit level
    - That gate is classified as `cross_cutting`
    - All four environmental inability conditions hold
    - A downstream gate exists that executes the same target or contains the same target
    - The downstream gate's configuration, trigger event, target path, required check name, or execution owner has been verified
12. Do not allow `deferred` when an unverified gate is `change_direct` or `unknown`, when multiple unverified gates exist, when unverified evidence is mixed with failures, when no downstream gate exists, or when the changed diff does not reach the downstream gate
13. If repository implementation, configuration, or test preparation can add or obtain direct evidence, return `FIX REQUIRED`. When only an environment blocker that cannot be resolved in the repository remains, return `BLOCKED BY ENVIRONMENT (DEFERRABLE)` only if every condition in item 11 holds, and `BLOCKED BY ENVIRONMENT (NOT DEFERRABLE)` when any of them fails. Record the deferred disposition (eligible / ineligible) and its grounds in the report

For `FIX REQUIRED`, record a finding ID, evidence, cause, affected contract paths, acceptance criteria, and the narrow remediation boundary. Explicitly exclude adjacent cleanup, refactoring, compatibility behavior, new guarantees, and suggested mechanisms that are not required to clear the confirmed merge blocker, so the following fix-plan can use this step's report directly as its authoritative target.
