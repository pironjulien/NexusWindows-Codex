# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-10-16

Version numbers now follow the upstream project (1.1.x and 1.2.x were never published here).

### Added
- Background-first actions in the .NET helper, tried before Codex's physical input: direct Win32 messages
  (`BN_CLICKED`, `BM_SETCHECK`, `EM_SETSEL` + `EM_REPLACESEL`, `CB_SETCURSEL`/`LB_SETCURSEL` with notification,
  `TCM_SETCURFOCUS`, menu `WM_COMMAND`) and COM UI Automation with `AutoSetFocus = FALSE`. New `select` and `menu` actions.
- COM-only child process (`--com-worker`) for UIA patterns: measured that a COM Invoke/Toggle from a process that has
  used `System.Windows.Automation` activates the target window despite `AutoSetFocus = FALSE`.
- Per-technique read-back (`applied`, `none`, `sent`); physical fallback only when nothing applied, or when the
  postcondition is unmet and nothing observable changed; `fallback:false`; results report `technique`, `mechanism`,
  `foregroundTaken`, `attempts`.
- Native capture `observe({capture:'native'})`: `PrintWindow(PW_RENDERFULLCONTENT)`, per-monitor DPI, DWM frame crop,
  blank-image detection with fallback to Sky's screenshot.
- `actBatch(obs, steps)`: up to 32 verified steps in one call, stopping at the first unmet step.
- Related windows followed without a new `bind` (owned dialogs, modals, same-process popups); `windowStack`,
  `windowChange`.
- User presence through Raw Input in the `--stop-guard` process; wait for a 1.618 s pause before physical input,
  chunked typing interrupted when the user takes over; `presenceStatus()`.
- Shared emergency stop (Ctrl+Alt+Shift+Esc, `%USERPROFILE%\.nexus\stop`) in the session and in the helper;
  `emergencyStopStatus()`.
- Shared foreground token (`%USERPROFILE%\.nexus\foreground.lock`) for physical input and foreground UIA.
- `install.ps1` (builds the helper, installs the skill) and a real validation `tests/live/background.live.mjs`
  run by `test.ps1 -Full`.

### Changed
- 100 JavaScript tests (95 offline, 5 real-environment tests run by `-Full`).

## [1.0.0] - 2026-10-14

### Added
- Native Microsoft UI Automation helper on isolated MTA thread in C# (.NET 8).
- Observation coordinator with verified postconditions and dynamic cache invalidation.
- Deterministic session manager preventing focus theft, stale observations and duplicate actions.
- 59 comprehensive unit and integration tests passing in under 1 second.
- OpenAI Codex desktop integration skill and documentation.
