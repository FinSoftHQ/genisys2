# Planning Processor Output Contract (v1)

## Why this exists

The planning processor previously relied on ad-hoc tag parsing (`<<<TASK>>>`, `<<<TITLE>>>`, etc.).
A real failure occurred where the LLM returned many valid task blocks, but with delimiter drift
(for example, `<<<TITLE>>` instead of `<<<TITLE>>>`), causing parse failure and fallback clone behavior.

Result:
- planning produced many candidate tasks
- parser detected zero tasks
- system created one fallback clone child card

## Decision

Use a strict machine-readable JSON contract (`planning.v1`) as the primary protocol.
Do not use strict Markdown as the canonical contract.

Markdown remains allowed for:
- task prose inside fields
- optional human-readable summary generated from validated JSON

## planning.v1 schema (logical)

```json
{
  "version": "planning.v1",
  "pre_flight": {
    "complexity_level": "trivial|standard|complex|epic",
    "justification": "string",
    "primary_type": "implementation|infrastructure|research|refactor|bugfix",
    "ambiguity_status": "none|needs_clarification",
    "missing_info": ["string"],
    "validation": {
      "coverage_complete": true,
      "fits_one_day": true,
      "independently_testable": true,
      "forward_dependencies_only": true,
      "notes": ["string"]
    }
  },
  "clarification_needed": {
    "required": false,
    "questions": ["string"]
  },
  "tasks": [
    {
      "id": "T1",
      "title": "string",
      "type": "implementation|infrastructure|research|refactor|bugfix",
      "body": ["string"],
      "depends_on": ["T0"],
      "acceptance": ["string"],
      "instructions": {
        "agent_name": "none|string",
        "notes": ["string"]
      },
      "risk": ["string"]
    }
  ]
}
```

## Field guidance

- `body`: `string[]`
  - Use paragraph chunks (not one array entry per physical line).
- `acceptance`: `string[]`
  - Each item must be pass/fail and testable.
- `depends_on`: `string[]` of task IDs (`T1`, `T2`, ...)
  - Never depend on title text.
- `instructions.agent_name`
  - When the LLM leaves this as `null`, the planning processor attempts to resolve a team contact from the parent card's `tailor_shop` working protocol (`working_protocol.md`).
  - The contact is derived as: `facilitator` if present, otherwise the first name in the `team:` roster.
  - If resolved, `agent_name` is set to the contact and a coordination note is prepended to `instructions.notes`.
  - If the LLM already assigned a specific agent, that value is preserved.
- `clarification_needed.required = true`
  - `tasks` must be empty.
  - Processor should not create child cards.

## Processor behavior

1. Get model response text.
2. Parse JSON.
3. Validate against schema.
4. Run semantic checks:
   - non-empty tasks unless clarification required
   - dependency IDs exist
   - no self-dependency
   - no cycles
5. Resolve team contact:
   - If the parent card has `tailor_shop` in its payload, read `${tailor_shop}/working_protocol.md`.
   - Derive `contact_agent_name` = `facilitator` || first name in `team:` roster.
   - For each task with `instructions.agent_name === null`, set it to `contact_agent_name` and prepend a coordination note to `instructions.notes`.
   - Store `contact_agent_name` in the parent card payload for traceability.
6. If invalid, perform one repair pass ("return valid planning.v1 JSON only").
7. If still invalid:
   - keep fallback clone behavior
   - persist diagnostics in payload:
     - `planning_raw_output`
     - `planning_parse_errors`
     - `planning_validation_errors`
   - still store `contact_agent_name` if it was resolved

## Human-readable summary (option c)

After successful validation:
- save structured task data in payload (`planned_tasks`)
- also generate and store a Markdown summary on parent card description
  (for human review and editability)

Summary should include:
- pre-flight (complexity, type, ambiguity)
- numbered task list (title, type, deps, acceptance, risk)

## Non-goals

- strict Markdown as primary machine contract
- title-based dependency matching
- silent parse failures without persisted diagnostics

## Test coverage requirements

Add or maintain tests for:
- valid JSON multi-task flow
- dependency linking by task ID
- clarification-needed flow
- malformed output repaired successfully
- malformed output fallback with persisted diagnostics
- markdown summary generation on success
