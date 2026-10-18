# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.0] - 2026-10-18 — One shared guardrail policy

The same policy as NexusWindows for Claude and for Antigravity (`garde-fous.json`, with a `codex` entry).

### Added
- **Confirmation of irreversible gestures**: paying, calling, sending, publishing, deleting permanently, formatting,
  uninstalling, resetting, cancelling a subscription and making a repository public need `confirm:true`, set only on
  the user's explicit order. The check is on what the gesture triggers: click by selector or by coordinates, Enter,
  Ctrl+Enter, Space, Alt+letter, typed line break, menu command, secondary action. Refused before any input, status
  `confirmation-required` in a batch; a learned recipe is never an order.
- Embedded copy of the policy (`garde-fous.json`), checked byte-identical to the shared file in the author's
  workspace; `NEXUS_GARDE_FOUS` points to another file.
- Real validation: every gesture refused and exactly one send after confirmation, on WinForms, Win32 and WPF; hard
  block and fail-closed helper with a real policy file.
- GitHub Actions workflow running `test.ps1` on Windows (node tests and native helper build), with its badge.
- README: Privacy section (what is read, where it goes, what is stored, how to remove it).

### Changed
- **Hard block read from the shared policy** instead of a built-in list: the secure desktop, Windows credential
  prompts, password managers (Dashlane, NordPass, RoboForm and LastPass added) and Codex's own application. Missing or
  invalid policy: everything is refused.
- The helper exposes the access key and the "default button" state of controls.

### Removed
- Refusals the shared policy made free: terminals, consoles (by process and by window class), Windows Security.

## [1.4.1] - 2026-10-18

Defects found by the cross-agent review of 2026-10-16, fixed at the root.

### Fixed
- **No more double click**: after a background click "sent" with no visible effect after 1.618 s, the session used
  to redo a real click (two actions, reported "verified"). The physical fallback now only happens after a "nothing
  took" read back by the helper; otherwise the result is `sent-unconfirmed`: sent, effect not read back, never
  counted as a success nor replayed.
- **The user's pause respected everywhere**: `activate()`, `set_value` and Sky's secondary actions (which can give
  focus) wait for the user's pause and go under the shared token, like real input.
- **Foreground handed back**: under the token, the helper notes the user's active window, then puts it back in front
  at the end if the target application still holds the foreground. If the user switched to another window, nothing
  is taken back from them. The result says so (`foregroundReturned`).
- **Foreground UIA click**: the user's pause is checked again inside the helper once the token is taken (the wait can
  last 8 s). The `--com-worker` child is bound to the helper (Job Object): it dies with it and can no longer act
  afterwards. Node timeouts exceed the helper's (token wait + action).
- **Emergency stop**: the token wait (8 s) stops as soon as the hotkey is pressed, every 50 ms. Physical typing goes
  character by character, with a stop check before each one (before: every 48 letters).
- **Guard restarted**: if the guard (stop hotkey, user presence) crashes, every action restarts it; while presence is
  unknown, physical input is deferred with a clear message, never sent blind.
- **Win32 menus**: a command's disabled state is read after `WM_INITMENU` and `WM_INITMENUPOPUP`, like a real
  opening; without an answer, the command is refused ("not verifiable").
- **Off-screen element**: `IsOffscreen` is read and reported (`flags: ['offscreen']`); a click on an element of which
  nothing is visible in its window is refused.
- **Window closed during a request**: "refused, nothing sent" instead of "unknown result", and never a fallback to a
  window that is gone.
- **Application memory**: a lock left by a dead process no longer blocks forever; it carries the pid and the time,
  and is taken over if its holder is dead or if it is too old.

### Added
- Tests: new and rewritten Node tests for the points above (double action, pause and token, foreground handed back,
  stop while typing, guard restarted, unknown presence, off-screen element, orphan lock).

### Changed
- README renamed to NexusWindows for Codex, the Codex edition of the NexusWindows family: badges, banner, links to
  the other Nexus projects and to the project page (julienpiron.fr/nexuswindows).

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
