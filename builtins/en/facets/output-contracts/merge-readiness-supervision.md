```markdown
# Final Merge-Readiness Adjudication

## Result: MERGEABLE / FIX REQUIRED / TASK REPLAN REQUIRED / BLOCKED BY ENVIRONMENT (DEFERRABLE) / BLOCKED BY ENVIRONMENT (NOT DEFERRABLE)

## Requirement and Evidence Summary
| Subject | State | Evidence |
|---------|-------|----------|
| {Decomposed requirement, quality gate, or prior finding} | {met / unmet / verified / unverified / resolved} | {file:line, report, or execution evidence} |

## Actionable Families
| family | Finding ID | Evidence | Problem -> root cause | Affected contract paths | Acceptance criteria | Remediation boundary |
|--------|------------|----------|-----------------------|-------------------------|---------------------|----------------------|
| {Stable family name} | {FINAL-NEW-* / FINAL-PERSIST-*} | {file:line or execution evidence} | {Verified causal chain} | {Entry, production, validation, consumption, and side effects} | {Observable completion conditions} | {Required minimal change; explicitly excluded adjacent work or mechanism} |

## Prior Finding Dispositions
| Finding ID | State | Evidence |
|------------|-------|----------|
| {ID} | {resolved / remains_open / adjudicated_non_actionable} | {Original acceptance criteria or adjudication and current evidence} |

## Unresolved Premises and Environmental Constraints
- {None, or the reason replanning or an environment change is required and the unverified scope}

## Unverified Gate Classification
| Gate ID / target | Result | Relation to changed contracts | Classification basis | Successful direct evidence | Four environmental conditions | Downstream gate and reachability |
|------------------|--------|------------------------------|----------------------|----------------------------|------------------------------|---------------------------------|
| {Configured gate name and command} | {success / failure / unverified / not_applicable} | {Contract ID, SCN ID, or none} | {Basis in the mapping for change_direct / cross_cutting / unknown} | {Test path, declaration name, execution evidence} | {Basis for each condition or failed condition} | {Configuration file, trigger, target, required check, or owner} |

## Deferred Decision
| Condition | Decision | Basis |
|-----------|----------|-------|
| Zero unresolved actionable findings | {yes / no} | {...} |
| Successful direct evidence exists for every changed contract | {yes / no} | {...} |
| Zero failed gates | {yes / no} | {...} |
| Exactly one mandatory gate is unverified | {yes / no} | {...} |
| The unverified gate is cross_cutting | {yes / no} | {...} |
| All four environmental conditions hold | {yes / no} | {...} |
| A downstream gate exists and the changed diff reaches it | {yes / no} | {...} |

## deferred disposition: eligible / ineligible / not_applicable

The mapping between disposition and result label is fixed: eligible corresponds to `BLOCKED BY ENVIRONMENT (DEFERRABLE)`, ineligible to `BLOCKED BY ENVIRONMENT (NOT DEFERRABLE)`, and not_applicable to every other result. A mismatched mapping is a report defect.
```

**Cognitive-load rules:**
- MERGEABLE -> include only the requirement and evidence summary plus prior finding dispositions
- FIX REQUIRED -> consolidate every confirmed blocker into families without omitting finding IDs or acceptance criteria
- TASK REPLAN REQUIRED / BLOCKED BY ENVIRONMENT -> record why remediation cannot resolve the issue in unresolved premises and environmental constraints
