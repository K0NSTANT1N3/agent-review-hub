# Contributing

This repository starts with the agreed product specification. The first implementation work is listed in [tasks/todo.md](tasks/todo.md).

## Working together

1. Open or claim a GitHub issue with a specific deliverable and acceptance criteria.
2. State the files/modules and shared schemas you expect to change. Coordinate overlapping work before editing.
3. Work on a feature branch and submit a pull request.
4. Explain the resulting behavior, validation performed, and any remaining limitations.
5. Have a teammate review before merging into `main`.

Keep coordinator state, connectors, and desktop UI boundaries clear so different people can work in parallel. Stabilize shared message schemas before building clients against them.

## Validation

Use deterministic fake adapters to verify queue and routing behavior without paid model calls. Exercise concurrent claims, exact session routing, duplicate replies, stale candidate approval, restart recovery, and bounded review loops. Run live CLI checks separately and report exactly what was tested.

There is no runnable app or test command yet. Add setup instructions and meaningful checks alongside the first implementation.

## Local data

Never commit provider credentials, connector tokens, local databases, or raw private transcripts. Example configuration must use placeholders. Provider credentials remain on the developer's machine.
