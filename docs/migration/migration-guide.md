# Guía de migración v1 → v2 / Migration Guide v1 → v2

DevOps Manager v2 es la reescritura en **Tauri 2 + Angular** de la aplicación Python
(`customtkinter`) que vive en la raíz del repositorio. Esta guía resume qué cambia para el
usuario. Documentación técnica: [`architecture-v2.md`](architecture-v2.md),
[`ipc-contract.md`](ipc-contract.md), [`ci-v2.md`](ci-v2.md), [`STATUS.md`](STATUS.md).

---

## Español

### Qué cambia para ti

| Aspecto | v1 (Python) | v2 (Tauri) |
|---|---|---|
| **Instalación** | Scripts (`install.bat` / `install.sh`) + `uv` + venv | **Instalador NSIS firmado** (`DevOps Manager_<versión>_x64-setup.exe`) desde GitHub Releases. Sin Python, sin venv, sin scripts |
| **Arranque** | `run.vbs` / `run.bat` / `run.sh` | Acceso directo normal de aplicación instalada |
| **Configuración** | `devops_manager_config.json` junto al código (irrescribible bajo Program Files) | Directorios estándar del SO: `%APPDATA%\devops-manager\` (Windows), `~/.config/devops-manager/` (Linux). Perfiles en el directorio de datos del SO |
| **Tipos de repo personalizados** | Editar YAML dentro de la carpeta de instalación | Carpeta de overrides del usuario: `<config>/devops-manager/repo-types/` — se fusiona sobre los YAML incluidos, sobrevive a actualizaciones |
| **Instancia única** | Protocolo propio PING/PONG por sockets, por workspace | Plugin oficial de Tauri, global: un segundo arranque enfoca la ventana existente |
| **Rendimiento** | Tk en un solo hilo; la GUI lanzaba sus propios subprocesos | Núcleo Rust async (tokio): supervisión de procesos, git y docker fuera del hilo de UI. La UI puede reiniciarse sin perder servicios en ejecución. Logs por lotes (sin saturar la UI en builds de Maven) |
| **Cerrar con servicios activos** | Diálogo de confirmación | Igual — el cierre se bloquea hasta confirmar; el icono de bandeja se mantiene |

Los mismos valores de temporización de v1 se conservan (sondeo de git cada 30 s, docker cada
15 s, recorte de logs a 500 líneas por tarjeta / 1000 global).

### Paridad funcional

| Funcionalidad | v2 |
|---|---|
| Escaneo de workspace + detección por YAML (spring-boot, angular, react, nx, maven-lib, docker-infra) | ✅ |
| Tarjetas con acordeón: start/stop/restart, install/reinstall, logs en vivo | ✅ |
| Git: badge de estado, ramas recientes, pull/fetch/checkout/clone/clean, merge con punto de reversión | ✅ |
| Docker Compose: up/down/stop por servicio, estado, logs, seeds de Flyway | ✅ |
| Perfiles: guardar/cargar/exportar/importar (formato `.json` 100 % compatible con v1) | ✅ |
| Grupos de workspace | ✅ |
| Selector de versión de Java | ✅ |
| Entornos guardados y editor de configuración (Spring/Angular/raw) | ✅ |
| Idiomas español/inglés | ✅ |
| Bandeja del sistema (minimizar, tooltip con servicios corriendo) | ✅ |
| Tema visual | ✅ (tokens SCSS; ya no se edita `ui_theme.yml`) |

### Errores de v1 corregidos por diseño

Resumen de la tabla completa en [`architecture-v2.md` §7](architecture-v2.md):

1. **Auto-kill en Linux**: al parar un servicio, v1 podía matar su propio grupo de procesos. v2 lanza cada servicio en su propio grupo/sesión.
2. **Detector legacy roto**: la ruta de respaldo llamaba a una función inexistente. v2 tiene un único detector.
3. **`must_match_package_json` ignorado**: cualquier repo con `package.json` podía clasificarse como react. v2 lo implementa de verdad.
4. **`stop_cmd` ignorado**: parar docker-infra nunca bajaba los contenedores. v2 ejecuta el `stop_cmd` declarado.
5. **Config en la carpeta de instalación**: fallaba bajo Program Files. v2 usa directorios del SO.
6. **Instancia única artesanal**: sockets y ficheros temporales. v2 usa el plugin oficial.
7. **Overlay de diálogos con capturas de pantalla (Pillow)**: ahora es CSS puro.
8. **Release de CI inutilizable**: v1 publicaba un `.exe` Nuitka sin su carpeta `main.dist/`. v2 publica un instalador NSIS autocontenido y firmado.
9. **Flash blanco al abrir la ventana**: la ventana arranca oculta y se muestra tras el primer pintado.
10. **Eventos fantasma documentados**: el catálogo de eventos se genera del código; docs y código no pueden divergir.

### Primera ejecución: migración automática

Al arrancar v2 por primera vez (si no existe `config.json` de v2), el núcleo Rust migra
automáticamente tus datos de v1:

- `devops_manager_config.json` → `config.json` en el directorio de configuración del SO.
- `.devops-profiles/` → carpeta de perfiles del SO, conservando los subdirectorios por grupo.
- Los valores centinela en español que v1 guardaba como texto se normalizan:
  `"- Sin Seleccionar -"` → clave eliminada (= nada seleccionado) y
  `"Sistema (Por Defecto)"` → `null` (= Java del sistema). El lector seguirá aceptando ambos
  centinelas para siempre, así que los perfiles exportados desde v1 se importan sin problema.
- Se anota `migratedFrom` / `migratedAt` en la nueva config para soporte.

La migración es **de solo lectura**: no toca ningún fichero de v1.

### Vuelta atrás (rollback)

v1 permanece intacta en la raíz del repositorio y sus ficheros de datos no se modifican.
Si necesitas volver: ejecuta `scripts\win\run.vbs` (o `./scripts/linux/run.sh`) como siempre.
Ambas versiones pueden convivir; solo recuerda que a partir de la migración cada una guarda
su configuración en un sitio distinto y los cambios no se sincronizan entre ellas.

---

## English

### What changes for you

| Area | v1 (Python) | v2 (Tauri) |
|---|---|---|
| **Install** | Scripts (`install.bat` / `install.sh`) + `uv` + venv | **Signed NSIS installer** (`DevOps Manager_<version>_x64-setup.exe`) from GitHub Releases. No Python, no venv, no scripts |
| **Launch** | `run.vbs` / `run.bat` / `run.sh` | Regular installed-app shortcut |
| **Configuration** | `devops_manager_config.json` next to the code (unwritable under Program Files) | OS-standard dirs: `%APPDATA%\devops-manager\` (Windows), `~/.config/devops-manager/` (Linux). Profiles in the OS data dir |
| **Custom repo types** | Edit YAML inside the install folder | User override folder: `<config>/devops-manager/repo-types/` — merged over the bundled set, survives updates |
| **Single instance** | Hand-rolled per-workspace PING/PONG sockets | Official Tauri plugin, app-global: a second launch focuses the existing window |
| **Performance** | Single-threaded Tk; the GUI spawned its own subprocesses | Async Rust core (tokio): process supervision, git and docker run off the UI thread. The UI can be restarted without losing running services. Log lines are batched (no UI flooding on chatty Maven builds) |
| **Closing with running services** | Confirmation dialog | Same — close is blocked until confirmed; tray icon preserved |

v1 timing values are deliberately kept (git badge poll 30 s, docker poll 15 s, log trim
500 lines per card / 1000 global).

### Feature parity

| Feature | v2 |
|---|---|
| Workspace scan + YAML-driven detection (spring-boot, angular, react, nx, maven-lib, docker-infra) | ✅ |
| Accordion repo cards: start/stop/restart, install/reinstall, live logs | ✅ |
| Git: status badge, recent branches, pull/fetch/checkout/clone/clean, merge with revert point | ✅ |
| Docker Compose: per-service up/down/stop, status, logs, Flyway seeds | ✅ |
| Profiles: save/load/export/import (`.json` format 100% v1-compatible) | ✅ |
| Workspace groups | ✅ |
| Java version selector | ✅ |
| Saved environments + config editor (Spring/Angular/raw) | ✅ |
| Spanish/English languages | ✅ |
| System tray (minimize, running-services tooltip) | ✅ |
| Visual theme | ✅ (SCSS tokens; `ui_theme.yml` editing is gone) |

### v1 bugs fixed by design

Summary of the full table in [`architecture-v2.md` §7](architecture-v2.md):

1. **POSIX self-kill**: stopping a service could SIGTERM the app's own process group on Linux. v2 spawns every service in its own process group/session.
2. **Broken legacy detector**: the fallback path called an undefined function. v2 has exactly one detector.
3. **Dead `must_match_package_json` key**: any `package.json` repo could classify as react. v2 actually implements it.
4. **Dead `stop_cmd` key**: stopping docker-infra never downed containers. v2 runs the declared `stop_cmd`.
5. **Config in the install dir**: broke under Program Files. v2 uses OS directories.
6. **Hand-rolled single instance**: temp files + loopback sockets. v2 uses the official plugin.
7. **Pillow screenshot dialog overlay**: now plain CSS.
8. **Unusable CI release**: v1 shipped a Nuitka `.exe` without its `main.dist/` folder. v2 ships a self-contained signed NSIS installer.
9. **Window white-flash**: the window starts hidden and is shown after first paint.
10. **Phantom documented events**: the event catalog is generated from code; docs and code cannot diverge.

### First-run migration

On first v2 launch (when no v2 `config.json` exists), the Rust core automatically migrates
your v1 data:

- `devops_manager_config.json` → `config.json` in the OS config dir.
- `.devops-profiles/` → the OS profiles dir, preserving per-group subdirectories.
- The Spanish sentinel strings v1 persisted are normalized:
  `"- Sin Seleccionar -"` → key dropped (= nothing selected) and
  `"Sistema (Por Defecto)"` → `null` (= system Java). The reader keeps accepting both
  sentinels forever, so profiles exported from v1 import cleanly at any time.
- `migratedFrom` / `migratedAt` markers are written into the new config for support.

The migration is **read-only**: no v1 file is modified.

### Rollback

v1 stays untouched at the repository root and its data files are never modified. To go back,
run `scripts\win\run.vbs` (or `./scripts/linux/run.sh`) as before. Both versions can coexist;
just note that after migration each one persists its configuration in a different location
and changes do not sync between them.
