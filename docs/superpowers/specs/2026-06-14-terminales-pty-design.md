# Terminales interactivas por repo (PTY) — Diseño

- **Fecha:** 2026-06-14
- **Estado:** Aprobado (pendiente de plan de implementación)
- **Producto:** DevDeck / DevOps Manager (Tauri 2 + Angular 22)

## Objetivo

Permitir abrir **N terminales interactivas reales** asociadas a un repo (o globales),
para ejecutar comandos a mano como en una terminal del sistema operativo: shell
persistente, programas interactivos (`vim`, `htop`, prompts), autocompletado con TAB,
`Ctrl+C`, colores ANSI. Varias terminales por repo y varios repos a la vez, cada una
en su propia ventana nativa.

## Decisiones clave (cerradas en brainstorming)

1. **Fidelidad: terminal real con PTY.** No es un "command runner" sobre pipes. Se
   requiere un pseudo-terminal porque sin TTY los programas desactivan la
   interactividad (sin prompt, sin edición de línea, sin colores). → `portable-pty`
   (Rust, ecosistema WezTerm) + `@xterm/xterm` (frontend).
2. **Superficie UI: ventanas separadas**, reusando el patrón exacto de
   `open_log_window`. Label `term-<id>`, ruta `?terminal=<id>`, capability `term-*`.
3. **Ciclo de vida de la ventana de terminal:** al cerrar la ventana se **mata el
   grupo de procesos del PTY** (vía el `kill.rs` existente) y se cierra. **Sin
   diálogo de confirmación por ventana.**
4. **Confirmación SOLO al cerrar la aplicación:** se muestra el diálogo de salida si
   hay repos ejecutándose **o** hay terminales abiertas. Solo comprueba *existencia*
   de terminales abiertas — **no** inspecciona qué corre dentro de cada una.

## Principio rector de arquitectura

**No mezclar terminales con `ProcessManager`.** El `ProcessManager`
(`src-tauri/src/process/`) modela servicios supervisados: máquina de 6 estados,
`ready_pattern`, install-vs-run mutuamente exclusivos, log batching. Una terminal
interactiva no tiene nada de eso. Vive en un subsistema nuevo y aislado para no
contaminar esa máquina de estados.

```
src-tauri/src/terminal/
├── mod.rs        # API pública del subsistema
├── manager.rs    # TerminalManager: HashMap<TermId, Session> (registro propio)
├── session.rs    # Session: PTY pair, child, writer, reader task
└── pty.rs        # wrapper sobre portable-pty (spawn, resize, kill)
```

Se **reutiliza** lo existente:
- `src-tauri/src/process/kill.rs` — escalado de terminación (SIGTERM→SIGKILL en Unix,
  `taskkill /F /T` en Windows) para matar el grupo del PTY.
- Patrón de aislamiento de proceso: `process_group(0)` (Unix) /
  `CREATE_NEW_PROCESS_GROUP` (Windows).
- Patrón de ventana detached de `commands/app.rs::open_log_window` y el routing por
  query-param de `app.component.ts`.

Frontend:
- `@xterm/xterm` + `@xterm/addon-fit` (resize) + `@xterm/addon-web-links`.
- Componente nuevo `src/app/features/workspace/terminal-window/terminal-window.component.ts`,
  hermano de `log-window/`.
- Botón "abrir terminal" en `card-header.component.ts`.

## Transporte de datos (diferencia crítica vs logs)

Los logs van **line-batched (75 ms), ANSI-stripped, trimmed** — sirven para
*observar*. Una terminal necesita lo OPUESTO: **bytes crudos, ANSI intacto, sin
batching de líneas** (xterm interpreta los escapes).

**Decisión de transporte: `Channel` de Tauri 2 con bytes crudos**, NO un evento
broadcast con base64. Razón: un evento global obliga a difundir cada chunk a TODAS
las ventanas de terminal, que decodifican y descartan el tráfico ajeno (4/5 con 5
terminales), más el ~33% de overhead de base64. El `Channel` es **punto a punto**:
cada ventana abre su propio canal y recibe solo sus bytes, crudos
(`Channel<InvokeResponseBody>` → `InvokeResponseBody::Raw(Vec<u8>)`; el frontend lo
recibe como `ArrayBuffer` vía `channel.onmessage`). Cero base64, cero cross-talk.

Reader task: flush corto (~16 ms) con coalescing y cap de bytes por flush.

### Flujo bidireccional

```
xterm.onData(keys) ──terminal_write──▶ Session.writer ──▶ PTY stdin ──▶ shell
shell ──▶ PTY stdout ──▶ reader task ──Channel.send(Raw)──▶ channel.onmessage ──▶ xterm.write(Uint8Array)
xterm fit() resize ──terminal_resize──▶ pty.resize(cols, rows)   # SIGWINCH
```

### Carrera de arranque (attach)

`open_terminal_window` (invocado desde la ventana **main**) crea la webview
`term-<id>` y registra la `Session` con el PTY ya arrancado — pero la webview nueva
aún no existe para pasar su `Channel`. El PTY ya escupe el primer prompt. Solución:
el reader escribe en un **ring buffer pequeño** hasta que la webview de terminal,
al inicializarse, invoca `attach_terminal(id, channel)`; ahí se vuelca el buffer y se
pasa a streaming en vivo. (Inverso al "subscribe-before-seed" de `log-window`.)

## Contrato IPC (añadidos)

### Comandos (`#[tauri::command]`, snake_case en el wire)

| CMD (TS) | wire | Quién lo llama | Descripción |
|---|---|---|---|
| `openTerminalWindow` | `open_terminal_window` | ventana main | Genera `TermId`, crea ventana `term-<id>`, arranca PTY (shell + cwd=repo), registra `Session`. Devuelve el `TermId` |
| `attachTerminal` | `attach_terminal` | webview terminal | Pasa el `Channel`; vuelca ring buffer + streaming en vivo |
| `terminalWrite` | `terminal_write` | webview terminal | Escribe bytes (teclas) al stdin del PTY |
| `terminalResize` | `terminal_resize` | webview terminal | `{ id, cols, rows }` → `pty.resize()` |
| `closeTerminal` | `close_terminal` | webview terminal | Mata el grupo + des-registra (al cerrarse la ventana) |

### Eventos

Ninguno nuevo. La salida del PTY va por `Channel` (punto a punto), no por el bus de
eventos. `EVT` se mantiene en 7.

### Identificador de terminal (`TermId`)

Generado por el **backend**: `<repoId>::term::<n>`, contador monótono por repo (nunca
reusa). Coherente con la convención `repo::module` existente. Se sanea para el label
de ventana con el helper de `log_window_label`. Para terminal global sin repo:
`__global__::term::<n>`.

### Actualizaciones acopladas (regla no-negociable de CLAUDE.md)

Todo en el mismo cambio:
- `core/ipc/commands.ts` (`CMD`): 61 → 66, y la aserción de conteo en `commands.spec.ts`.
- `core/ipc/events.ts` (`EVT`): **sin cambios** (sigue en 7); `events.spec.ts` intacto.
- `src-tauri/src/lib.rs`: registrar los 5 comandos en `generate_handler!`.
- `docs/migration/ipc-contract.md`: documentar los 5 comandos (sin eventos nuevos).
- `capabilities/default.json`: añadir `"term-*"` a `windows`.
- `app.component.ts`: `isTerminalWindow = params.has('terminal')` → `<terminal-window/>`.

## Shell, cwd y multiplicidad

- **cwd** = ruta del repo; terminal global sin repo → workspace root.
- **Shell por defecto** (configurable, con fallback):
  - Unix: `$SHELL` → `/bin/bash` → `/bin/sh`.
  - Windows: `pwsh` → `powershell` → `cmd`.
  - Override opcional en config global (`dirs::config_dir()/devops-manager/`). **No** en
    los YAML de repo-types (esos son para detección). Per-repo queda fuera de scope (YAGNI).
- **N terminales:** cada `openTerminalWindow` genera un `TermId` `<repoId>::term::<n>`
  (contador monótono por repo, ver sección IPC). `TerminalManager` =
  `HashMap<TermId, Session>`, sin límite. Cada terminal: su ventana, su PTY, su shell.

## Cierre de aplicación (extensión del flujo existente)

El flujo de cierre ya existe: `lib.rs` intercepta `WindowEvent::CloseRequested` (solo
ventana `"main"`), y si `state.tray.any_active()` hace `prevent_close()` + emite
`app://close-requested`; el frontend (`workspace-page.component.ts::onCloseRequested`)
muestra el diálogo y responde con `app_exit { force }`.

Extensión:
- `state.rs`: añadir `TerminalManager` a `AppState` con `any_open() -> bool`.
- `lib.rs:101` y `lib.rs:385`: condición pasa a
  `state.tray.any_active() || state.terminals.any_open()`.
- Frontend `onCloseRequested`: el diálogo adapta el texto según qué hay activo
  ("Hay repos ejecutándose y/o terminales abiertas. ¿Salir?"). Claves i18n nuevas en
  `en.json`/`es.json` con estructura idéntica.
- `RunEvent::Exit` (cleanup): iterar `TerminalManager` y matar todas las sesiones vía
  `kill.rs`.

## Riesgos y bordes

1. **`portable-pty` bajo `cargo-xwin` (cross-compile Windows desde WSL).** En Windows
   usa ConPTY vía API de Windows. **Riesgo nº1.** Hacer un spike de compilación que
   linke un PTY mínimo ANTES de construir la UI encima.
2. **ConPTY requiere Windows 10 1809+.** Target asumido moderno. Documentar el límite.
3. **`Cargo.lock` pin de `time 0.3.47`.** Añadir `portable-pty` puede arrastrar deps;
   vigilar que no fuerce `cargo update` y rompa `cookie 0.18.1` (E0119). Añadir con cuidado.
4. **Saturación del IPC** con output masivo (`cat` de un fichero enorme, build verboso).
   Mitigación: el reader hace coalescing por canal con cap de bytes por flush (~16 ms).
   El `Channel` crudo ya elimina el overhead de base64 y el broadcast a ventanas ajenas.
5. **Carrera de arranque attach** (ver sección de transporte): si el ring buffer se
   desborda antes del `attach_terminal`, se perderían las primeras líneas. Dimensionar
   el buffer con holgura (el arranque de un shell hasta el primer prompt es pequeño).

## Fuera de scope (YAGNI)

- Detección idle/busy por terminal (`tcgetpgrp`) — descartada: cerrar ventana = matar, sin preguntar.
- Reattach / scrollback persistente en background (no hay `LogCache` equivalente para terminales).
- Dock con pestañas o pop-out — superficie elegida: ventanas separadas.
- Shell override per-repo en YAML.

## Pasos de verificación temprana

1. Spike: compilar un PTY mínimo con `portable-pty` bajo `cargo-xwin` → exe Windows que
   arranque un shell y eco de bytes. **Gate**: si esto no compila/linka, replantear la
   librería PTY antes de seguir.
2. Confirmar que `cargo add portable-pty` no mueve el pin de `time`.
