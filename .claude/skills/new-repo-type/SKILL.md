---
name: new-repo-type
description: >
  Scaffold a new DevDeck repo-type YAML under config/repo-types/ so a new
  framework is detected and runnable — zero code changes.
  Trigger: user invokes /new-repo-type <framework>.
disable-model-invocation: true
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## When to Use

User wants DevDeck to detect a new framework/stack (e.g. `/new-repo-type django`).

## Critical Patterns

- One YAML in `config/repo-types/<name>.yml` is ALL it takes — detection is config-driven, no Rust/Angular changes.
- The file is bundled as a Tauri resource; users can override it in the OS config dir.
- `priority` decides ties when several types match (higher wins). Check existing files so the new one sorts sensibly (spring-boot is 60).
- `logs.ready` / `logs.ports` are regexes matched against process output — test them against real startup logs of the framework.

## Steps

1. Ask (or infer from the framework) the detection markers: required files/dirs, glob patterns.
2. Copy the richest example as a base: [assets/spring-boot.yml](../../../config/repo-types/spring-boot.yml) — it exercises every section (`detect`, `run`, `logs`, `config`, `enrich`, `ui`).
3. Fill: `schema_version: 2`, `type`, `priority`, `detect`, `run.install`/`run.start` (with `unix` variant if the wrapper script differs), `logs.ready`/`error`/`ports`, `ui.icon`/`color`.
4. Omit sections that don't apply (`config`, `enrich`) — they are optional.
5. Verify: run DevDeck against a workspace containing such a repo and confirm the badge/type appears.

## Commands

```bash
ls config/repo-types/          # existing types + priorities to compare against
```
