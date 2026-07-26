# Builtin Catalog

[日本語](./builtin-catalog.ja.md)

A comprehensive catalog of all builtin workflows and personas included with TAKT.

## Recommended Workflows

| Workflow | Recommended Use |
|----------|-----------------|
| `default` | Standard development workflow. Test-first with draft implementation, AI antipattern self-review, specialist peer review, merge-readiness gate, and supervision. plan → write_tests → draft → peer-review (specialists → merge-readiness → fix loop) → supervise → complete. |
| `default-mini` | Mini development workflow without tests. A lightweight variant of `default` with `write_tests` removed. plan → implement → AI antipattern review → parallel review → complete. |
| `default-high` | Full-spec development workflow. Test-first with team-leader implementation, AI antipattern review with arbitration, specialist peer review, merge-readiness gate, and supervision. plan → write_tests → team-leader draft → peer-review (specialists → merge-readiness → fix loop) → supervise → complete. |
| `frontend` | Frontend workflow with a 5+2 review: architecture/frontend/testing/AI/robustness -> security/coding. |
| `backend` | Backend workflow with six reviewers: architecture/testing/AI/security/robustness/coding. |
| `dual` | Frontend + backend workflow with seven parallel reviewers including a frontend specialist. |

## All Builtin Workflows

Organized by category.

| Category | Workflow | Description |
|----------|----------|-------------|
| 🚀 Quick Start | `default` | Standard development workflow. Test-first with draft implementation, AI antipattern self-review, specialist peer review, merge-readiness gate, and supervision. plan → write_tests → draft → peer-review (specialists → merge-readiness → fix loop) → supervise → complete. |
| | `default-mini` | Mini development workflow without tests. A lightweight variant of `default` with `write_tests` removed. plan → implement → AI antipattern review → parallel review → complete. |
| | `default-high` | Full-spec development workflow. Test-first with team-leader implementation, AI antipattern review with arbitration, specialist peer review, merge-readiness gate, and supervision. plan → write_tests → team-leader draft → peer-review (specialists → merge-readiness → fix loop) → supervise → complete. |
| | `frontend` | Frontend workflow with a 5+2 review: architecture/frontend/testing/AI/robustness -> security/coding. |
| | `backend` | Backend workflow with six reviewers: architecture/testing/AI/security/robustness/coding. |
| | `dual` | Frontend + backend workflow with seven reviewers: architecture/frontend/testing/AI/security/robustness/coding. |
| ⚡ Mini | `default-mini` | Mini development workflow without tests. A lightweight variant of `default` with `write_tests` removed. plan → implement → AI antipattern review → parallel review → complete. |
| | `backend-cqrs-mini` | Mini CQRS+ES workflow: plan -> implement -> parallel review (AI antipattern + supervisor) with CQRS+ES knowledge injection. |
| | `dual-mini` | Mini dual workflow: plan -> implement -> parallel review (AI antipattern + expert supervisor) with frontend + backend knowledge injection. |
| | `dual-cqrs-mini` | Mini CQRS+ES dual workflow: plan -> implement -> parallel review (AI antipattern + expert supervisor) with CQRS+ES knowledge injection. |
| 🎨 Frontend | `frontend` | Frontend-specialized development workflow with React/Next.js focused reviews and knowledge injection. |
| | `frontend-maintenance` | (Experimental) Frontend workflow for modifying existing products: maintenance-scoped plan/implement/test/fix/supervise that respects current conventions and keeps changes within scope. This workflow can be heavy-handed today — use it as a starting point and tune it. |
| ⚙️ Backend | `backend` | Backend workflow with six reviewers: architecture/testing/AI/security/robustness/coding. |
| | `backend-cqrs` | CQRS+ES backend workflow with six reviewers: CQRS/testing/AI/security/robustness/coding. |
| | `backend-maintenance` | Strict backend maintenance workflow with six parallel reviewers followed by a merge-readiness gate. |
| 🔧 Dual | `dual` | Frontend + backend workflow with seven parallel reviewers including a frontend specialist. |
| | `dual-cqrs` | Frontend + CQRS+ES workflow with seven parallel reviewers including CQRS and frontend specialists. |
| 🏗️ Infrastructure | `terraform` | Terraform IaC development workflow: plan → implement → parallel review → supervisor validation → fix → complete. |
| 🔍 Review | `review-default` | Six parallel reviewers for architecture/testing/AI/security/robustness/coding, followed by merge-readiness synthesis. |
| | `review-fix-default` | The same six-reviewer default configuration with a fix loop. |
| | `review-frontend` | Frontend-focused 5+2 two-stage review. |
| | `review-fix-frontend` | The same frontend 5+2 configuration with a fix loop. |
| | `review-backend` | Six parallel reviewers with backend knowledge. |
| | `review-fix-backend` | The same six-reviewer backend configuration with a fix loop. |
| | `review-dual` | Seven parallel reviewers including a frontend specialist. |
| | `review-fix-dual` | The same seven-reviewer dual configuration with a fix loop. |
| | `review-dual-cqrs` | Seven parallel reviewers including CQRS and frontend specialists. |
| | `review-fix-dual-cqrs` | The same seven-reviewer dual-CQRS configuration with a fix loop. |
| | `review-backend-cqrs` | Six parallel reviewers with architecture and contract lifecycle folded into the CQRS reviewer. |
| | `review-fix-backend-cqrs` | The same six-reviewer backend-CQRS configuration with a fix loop. |
| | `audit-unit` | Unit test audit. Enumerates behaviors and coverage gaps, produces an issue-ready report without modifying code. |
| | `audit-e2e` | E2E audit. Enumerates user flows and coverage gaps, produces an issue-ready report without modifying code. |
| | `audit-security` | Full security audit. Reads every project file for security review. |
| | `audit-architecture` | Architecture audit. Enumerates modules and boundaries, produces an issue-ready report without modifying code. |
| | `audit-architecture-frontend` | Frontend-focused architecture audit. Enumerates UI modules and boundaries. |
| | `audit-architecture-backend` | Backend-focused architecture audit. Enumerates service modules and boundaries. |
| | `audit-architecture-dual` | Full-stack architecture audit. Enumerates frontend/backend boundaries and cross-layer wiring. |
| 🧪 Testing | `unit-test` | Unit test focused workflow: test analysis -> test implementation -> review -> fix. |
| | `e2e-test` | E2E test focused workflow: E2E analysis -> E2E implementation -> review -> fix (Vitest-based E2E flow). |
| 🎵 TAKT Development | `takt-default` | TAKT development workflow: plan → write tests → draft (implement + AI self-review) → peer-review (specialists + merge-readiness + fix) → supervise → complete. |
| | `takt-default-team-high` | Team Leader variant of takt-default-high. The leader decomposes implementation and fixes for members, followed by the same six compact specialist reviews, Finding Contract, and final gate. Provider and model remain configurable. |
| | `takt-default-high` | Enhanced high-cost variant of takt-default: direct implementation and fixes, six compact specialist reviews, Finding Contract, and a merge-readiness/supervisor final gate. |
| | `review-fix-takt-default` | TAKT development code review + fix loop: gather → plan → tests → draft → peer-review (specialists + merge-readiness + fix) → supervise. |
| Others | `research` | Research workflow: planner -> digger -> supervisor. Autonomously executes research without asking questions. |
| | `deep-research` | Deep research workflow: plan -> dig -> analyze -> supervise. Discovery-driven investigation that follows emerging questions with multi-perspective analysis. |
| | `magi` | Deliberation system inspired by Evangelion. Three AI personas (MELCHIOR, BALTHASAR, CASPER) analyze and vote. |

For local models, configure the provider and model on `takt-default-high` or `takt-default-team-high`; TAKT does not maintain a separate model-specific workflow family.

Run `takt` to choose a workflow interactively.

## Builtin Personas

| Persona | Description |
|---------|-------------|
| **planner** | Task analysis, spec investigation, implementation planning |
| **architect-planner** | Task analysis and design planning: investigates code, resolves unknowns, creates implementation plans |
| **coder** | Feature implementation, bug fixing |
| **ai-antipattern-reviewer** | AI-specific antipattern review (non-existent APIs, incorrect assumptions, scope creep) |
| **architecture-reviewer** | Architecture and code quality review, spec compliance verification |
| **frontend-reviewer** | Frontend (React/Next.js) code quality and best practices review |
| **cqrs-es-reviewer** | CQRS+Event Sourcing architecture and implementation review |
| **security-reviewer** | Security vulnerability assessment |
| **conductor** | Phase 3 judgment specialist: reads reports/responses and outputs status tags |
| **supervisor** | Final validation, approval |
| **dual-supervisor** | Multi-review integration validation and release readiness judgment |
| **research-planner** | Research task planning and scope definition |
| **research-analyzer** | Research result interpretation and additional investigation planning |
| **research-digger** | Deep investigation and information gathering |
| **research-supervisor** | Research quality validation and completeness assessment |
| **test-planner** | Test strategy analysis and comprehensive test planning |
| **testing-reviewer** | Testing-focused code review with integration test requirements analysis |
| **merge-readiness-reviewer** | Cross-cutting quality review for whether the change is ready to merge into a codebase that must be maintained |
| **contract-lifecycle-reviewer** | Contract lifecycle review across definition, producer, consumer, validation, and migration paths |
| **robustness-reviewer** | Robustness review for failure handling, boundary conditions, and operational resilience |
| **terraform-coder** | Terraform IaC implementation |
| **terraform-reviewer** | Terraform IaC review |
| **melchior** | MAGI deliberation system: MELCHIOR-1 (scientist perspective) |
| **balthasar** | MAGI deliberation system: BALTHASAR-2 (mother perspective) |
| **casper** | MAGI deliberation system: CASPER-3 (woman perspective) |
| **findings-manager** | Reconciles raw findings from multiple reviewers into a consolidated ledger with lifecycle tracking |
| **pr-commenter** | Posts review findings as GitHub PR comments |

## Custom Personas

Create persona prompts as Markdown files in `~/.takt/personas/`:

```markdown
# ~/.takt/personas/my-reviewer.md

You are a code reviewer specialized in security.

## Role
- Check for security vulnerabilities
- Verify input validation
- Review authentication logic
```

Reference custom personas from workflow YAML via the `personas` section map:

```yaml
personas:
  my-reviewer: ~/.takt/personas/my-reviewer.md

steps:
  - name: review
    persona: my-reviewer
    # ...
```

## Per-persona Provider Overrides

Use `persona_providers` in `~/.takt/config.yaml` to route specific personas to different providers without duplicating workflows. This allows you to run, for example, coding on Codex while keeping reviewers on Claude.

```yaml
# ~/.takt/config.yaml
persona_providers:
  coder: codex                      # Run coder on Codex
  ai-antipattern-reviewer: claude   # Keep reviewers on Claude
```

This configuration applies globally to all workflows. Any step using the specified persona will be routed to the corresponding provider, regardless of which workflow is being executed.

For Finding Contract manager routing, prefer the workflow-local `finding_contract.manager.provider` and `finding_contract.manager.model` fields. They are explicit to the ledger adjudicator and take priority over `persona_providers.findings-manager`.
