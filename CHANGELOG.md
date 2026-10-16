# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-10-16

Fixes measured by the cross-agent bench of 2026-10-16 (16/20 in the morning with 1.3.0, 19/20 after).

### Added
- Drop-down lists: Win32/WinForms combo box opened and closed by `CB_SHOWDROPDOWN`, read back by
  `CB_GETDROPPEDSTATE`; options read by messages as `list`/`listitem` nodes, open or not.
- Windows excluded by class: every console or terminal window (`ConsoleWindowClass`, `PseudoConsoleWindow`,
  `CASCADIA_HOSTING_WINDOW_CLASS`) is refused whatever process Windows attributes it to.
- `tests/postcondition.test.mjs`; `tests/live/bench-forms.mjs` (bench forms hosted by `powershell.exe`, run by
  `test.ps1 -Full`, with a console-class window that must be refused and the foreground sampled every 20 ms).

### Changed
- The tree is read with the COM UI Automation client in one round trip (`CacheRequest`, `Subtree` scope); the managed
  `System.Windows.Automation` client is no longer loaded anywhere. About 50 ms per bench form instead of 150 to 300 ms;
  the bench task takes 1.2 to 1.4 s instead of 4 to 8 s.
- For an action, only the target and its ancestors are read again (by runtime identity); any difference is refused.
- Graphical windows hosted by `powershell.exe`, `cmd` or `pwsh` are allowed (the whole process was refused).

### Fixed
- A postcondition already true before the action no longer skips it unless it is a precise state the action changes;
  a postcondition that only restates the target is refused before any input (1.3.0 skipped "Validate").
- Opening a WinForms list was wrongly `already-satisfied` (its items always exist in the tree).
- Choosing in an open list: the list is closed first (that close is a cancel which restored the previous choice),
  then `CB_SETCURSEL` + `CBN_SELCHANGE` + `CBN_SELENDOK`; the choice is proven by the combo box `value`.
- WPF: following the combo box popup lost every control of the form ("found 0"); transient popups are no longer
  followed, and a combo box is closed again after any choice.

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
