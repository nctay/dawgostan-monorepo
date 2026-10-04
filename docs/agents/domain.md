# Domain Docs

## Before exploring

- Read the root `CONTEXT.md`.
- Read relevant ADRs under `docs/adr/`.
- If either is absent, proceed silently.

## Layout

This repository uses a single-context domain layout:

```text
/
├── CONTEXT.md
└── docs/adr/
```

## Vocabulary

Use the domain terms defined in `CONTEXT.md`, including in ticket titles,
tests, proposals, and implementation notes. Avoid synonyms explicitly listed
there.

If a required concept is missing, reconsider whether it belongs in the model
or record the gap for `domain-modeling`.

## ADR conflicts

If proposed work contradicts an existing ADR, state that conflict explicitly
instead of silently overriding the decision.
