---
name: ipc-sync
description: >
  Checklist for adding, renaming, or removing a DevDeck IPC command or event.
  Trigger: any change to a #[tauri::command] fn, an emitted event, CMD/EVT
  maps, or the IPC contract doc.
user-invocable: false
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## When to Use

- Adding/renaming/removing a `#[tauri::command]` function
- Adding/renaming/removing an emitted event
- Any edit to `CMD`, `EVT`, or `docs/migration/ipc-contract.md`

## Critical Patterns

An IPC change touches FIVE places in lockstep. Missing one is the most likely
recurring bug in this repo. Wire names are snake_case commands / camelCase arg
keys; error envelope is `{ kind, message }`.

### Command checklist

1. **Rust**: the `#[tauri::command]` fn + register it in the `generate_handler![]` list in `src-tauri/src/lib.rs`
2. **`src/app/core/ipc/commands.ts`**: add the name to `CMD` + a typed wrapper method on `IpcCommands` (no stringly-typed `invoke` outside this folder)
3. **`src/app/core/ipc/commands.spec.ts`**: bump the count assertion (`expect(names.length).toBe(N)`) — the assertion is the AUTHORITATIVE count, read the current value before bumping
4. **`docs/migration/ipc-contract.md`**: document the command (args, result, errors) and update its count
5. **Types**: request/response interfaces in `core/ipc` mirror the Rust structs (serde camelCase on the wire)

### Event checklist

Same shape: `src-tauri/src/events.rs` → `core/ipc/events.ts` (`EVT`) → count assertion in `events.spec.ts` → contract doc.

## Commands

```bash
npm test                 # verifies both count assertions
```
