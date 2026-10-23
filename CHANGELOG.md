# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.0.1] - 2026-10-23 — Family naming, release with provenance

### Changed
- Same version as NexusWindows for Claude (now published as `nexus-windows-claude`) and NexusWindows for
  Antigravity; the README family table points to the new Claude package.
- Published to npm from GitHub Actions through trusted publishing, with provenance (3.0.0 was published by hand).

## [3.0.0] - 2026-10-23 — Standalone MCP server, no Sky

The three NexusWindows tools (Claude, Codex, Antigravity) move to 3.0.0 together: one-command install from a package
registry, the same five tool names (`windows`, `look`, `act`, `launch`, `window`), the same step outcomes
(✓ verified, = already done, ~ unknown, ✗ failed or refused), and from now on one version number for the family.

### Added
- MCP server `nexus-windows-codex` on npm (`npx -y nexus-windows-codex`), with a self-contained native helper: no .NET
  install, no dependency on Codex's Computer Use API. Tools `windows`, `look`, `act`, `launch`, `window`; every tool
  carries MCP annotations. The protocol is implemented without any npm dependency.
- The helper lists the desktop's application windows by itself (visible, not cloaked, not tool or owned windows; a
  Store app is named after its content process; password managers never listed), so every window is read, captured
  and driven by the helper alone, its process checked on each request.
- `launch`: an application (name, path or Store app id), a folder, a document or a Settings page, under the shared
  foreground token, the foreground given back each time a new window takes it; other addresses are refused.
- `window` `close`: one close message, read back within 3 s; a "save?" prompt is reported, never answered.
- The server starts and lists its tools outside Windows (MCP directories); each call then says why it cannot run.

### Changed
- The Codex skill stays available from a clone, over Codex's Computer Use API; the MCP server is the default install.
- Version 3.0.0, shared with NexusWindows for Claude and NexusWindows for Antigravity.

### Fixed (pre-release cross review)
- A window named in `look` or `window` is always bound again: after the session had followed a dialog, `close` could
  reach that dialog instead of the named window.
- Tool arguments are checked against the published schema before any action: an unknown `window` action (or none) used
  to close the window. Malformed JSON-RPC requests get `-32600` instead of no answer.
- `launch` takes its window inventory under the foreground token, just before starting, and attributes a new window to
  the launch only on proof: the started process, or a process born after the launch that is the requested application
  (same executable path, same process name for a bare name, same AUMID). A title or a file name proves nothing:
  documents, folders and other matches come back as `candidates`, outcome unknown. Every window is re-read at the end
  (a recycled handle is never kept); the foreground is given back from an already open instance too, even another
  window of the same process; a blocked application (password manager, AUMID included) is refused before starting,
  and a document or folder is never judged by its file name; outside an absolute path (UNC with `/` included) or a
  Store id, only a bare application name is accepted (a relative path or a file name is refused). Each attributed
  window carries its `proof`: `process` or `application`. The Node side waits for the helper's whole launch budget
  instead of killing it mid-way.
- `launch` drops the previous observation; a Settings page opened hidden is bound so `look` and `act` reach it, and
  naming it again brings it back from a dialog followed since, before `look` or `close`.
- `act` with `refresh: "image"` returns the refreshed capture, not only the text summary.
- A window followed through the native provider keeps its process and owner identity; a window handle reused by
  another process is never accepted as the same window.
- Native captures are also purged at server start and at a clean stop.

## [1.9.0] - 2026-10-23 — Self-contained background input across Win32, WinForms, WPF and Chromium

This release makes the helper a complete Windows driver of its own (real input, menus, dialogs, Settings, Explorer) and
closes the gaps found on the common bench of the three NexusWindows tools (Claude, Codex, Antigravity).

### Added
- Common journal: every action is also written, one short line, to `%LOCALAPPDATA%\NexusJournal\windows\codex\` in
  the format shared by the three NexusWindows tools; never screen text, typed values, titles or paths.
- Real mouse and keyboard owned by the helper (`native/Physical.cs`, operation `physical`, SendInput), Sky only as a
  fallback: click, double and right click, wheel, drag, keys and Unicode text, under the shared foreground token. The
  target must come to the front (else nothing is sent); emergency stop, target and point re-read before each batch.
- `key` in the background for Win32/WinForms: keys posted to the target thread's focus, with that thread's keyboard
  layout (an AZERTY target no longer gets "&" for "1"); Alt and Windows keys refused; other frameworks fall back.
- Native coordinate frame: each native capture has an `id` usable as `screenshotId` for `click` and `scroll`; the
  window frame is re-read before input (moved window = refused) and outward-gesture checks apply to the point.
- Wheel in WPF windows by UI Automation `ScrollPattern` on the innermost scrollable container under the point; position
  re-read (changed = applied, unchanged = sent, already at the end = nothing sent).
- Wheel in Chromium/Electron/Edge through DevTools when the target listens on its own `--remote-debugging-port`: the
  page is proved active by briefly showing a random title in that exact window (under 0.5 s, original title always
  restored and verified) and exactly one visible render surface must match the page size; otherwise nothing is sent.
- Chromium "simulated activation": focus an editable surface, choose a `<select>` option by typing its label, and type
  into fields and rich editors without taking the foreground; values re-read, partial typing reported, never replayed.
- WinForms menus (MenuStrip, ContextMenuStrip) driven by the names of the path through UI Automation Invoke; each
  segment searched directly under the previous one, homonyms refused, a submenu opened for the search is folded back.
- Context menus: WinForms and WPF popups are recognised and reported in `obs.popups`; a right click returns the menu
  it opened (`contextMenu`), and its commands are resolved inside that exact menu only.
- Operation `activate`: an interaction lease brings the window forward through the helper, so a transient WPF menu can
  be opened and chosen under the same lease.
- `win.openSettings('ms-settings:…')`: opens a Settings page (only the `ms-settings:` scheme) and gives the foreground
  back; `win.bindOpenedSettings()` binds that window even when Windows opens it hidden.
- `win.openFolder(path)`: the bound Explorer window goes to an existing absolute folder through the shell (no keyboard,
  no foreground); single-tab windows only, arrival re-read and folders compared by their on-disk file identity.
- Click traces (`trace`): target window, thread, points, posted messages and the window actually under the point.
- Self-tests: `--cdp-selftest`, `--wheel-selftest`, `--prove-selftest`, `--prove-live-selftest`, `--menu-selftest`,
  `--chromium-selftest`, `--popup-selftest` and others, plus Node tests for page choice and wheel planning.

### Fixed
- Whole helper is per-monitor DPI aware: the UI Automation tree was read in virtualised coordinates at 125 % while
  capture and gestures used real pixels, so a right click aimed at a list landed on the form.
- Posted clicks are converted to the coordinate system the window reads (logical pixels for non-DPI-aware windows);
  ListBox item rectangles are scaled accordingly.
- Open/Save dialogs that Sky does not list (WinUI Notepad, Paint) are followed when proved owned by the bound window
  and of the same process; read, captured and driven by the helper only, identity re-checked before each read.
- A bound window closed by the action (Alt+F4, Close button) is reported as `closed`, not as an unknown outcome; an
  unreadable state or a hidden window never counts as closed.
- WinForms double click on a covered control is refused before sending (WinForms only raises DoubleClick when the
  control is under the point); the real mouse takes over briefly when allowed.
- Foreground return after a posted gesture that activates the target: held under the shared token, and never done if
  the user touched keyboard or mouse in the meantime; no more queued `SC_HOTKEY` that could reactivate a window later.
- A helper that dies while holding the foreground token makes the action unknown, never a success; only an explicit
  `released` acknowledgement proves a normal release.
- An interaction that expires during preparation sends nothing; typing stops at the next grapheme when it expires.
- `fallback:false` now forbids every physical input, including when no background technique applies.
- WinForms push buttons get a posted `BN_CLICKED` (UI Automation Invoke blocked on a modal opened by the button);
  single-selection ListBox items are read and chosen by messages instead of unstable UI Automation identities.
- Name selectors: a static label with the same name as a single control no longer makes it ambiguous.
- Edge with tabs is recognised from its window title; a test title that cannot be cleaned up is a terminal refusal.
- Window or pane titles are no longer treated as triggers ("Cancel" in a window titled "Send a message").

### Changed
- "Agent at work" indicator: the blue halo is gone; only the logo spins, with its drop shadow.
- Posted keys no longer carry any modifier; Ctrl shortcuts go through the physical fallback or a semantic command.

### Known limits
- A posted gesture is watched for 300 ms under the token; a target busy longer may still activate itself afterwards.
- DevTools wheel needs a page whose title shows in its window and a single visible render surface (multi-view
  Electron apps are refused).

## [1.8.0] - 2026-10-20 — Accord bound to the exact action

### Changed
- **Outward gestures need the user's accord bound to the EXACT action** (shared guard-rail policy v2, same rule as
  NexusWindows for Claude and for Antigravity). Sending, calling, paying, publishing or transferring (or Validate/OK in
  a payment window) needs `confirm:true` AND `accord:"<token>"`. The first try is refused before any input with a
  summary of the exact action and a single-use token (10 min): gesture, triggers, recipients first and in full
  (recipient fields such as To, Cc, À, E-mail, IBAN, and the chips inside or next to them), editable field values
  (never a password), the body document near the trigger, typed text in full with each line break shown (⏎) and
  counted, the open conversation (title without its unread counter, headings, selected list, grid or tab item), the
  application and window. Any change voids the token. Local destructions (uninstall, format, empty the trash…) keep
  `confirm:true` alone. A text read in a window, page or message never authorizes anything.
- The token is burned right before input and given back when the input is refused before anything was sent (focus,
  user presence, emergency stop), so a yes is never lost for nothing; two calls can never use it both.
- Every input path is judged: selector and coordinate clicks, drag (start and end points), Enter, Ctrl+Enter, Space,
  Alt+letter, Tab followed by Space or Enter, typed line breaks and tabs, menu commands, secondary actions, batches and
  recipes. Enter in a field widens to the nearest ancestor holding a button with a word to confirm (an editor nested
  far from its send bar). A coordinate gesture with no element bounds under the point is judged on every trigger of
  the window, with every document bound; with nothing read at all it is refused.
- CI: bump pinned GitHub Actions (actions/checkout v7.0.1, actions/setup-node v7.1.0, actions/setup-dotnet v6.0.0).
- Reviewed adversarially in six rounds; 162 tests.

### Known limits
- No provenance warning yet (a recipient that appears in a text read is not flagged here; the token stays bound to the
  exact action).

## [1.7.0] - 2026-10-20 — "Agent at work" indicator

### Added
- While an action runs (`act`, `actBatch`, `activate`; never an observation), a logo spins on itself in the
  bottom-right corner of the bound window's screen with a breathing blue halo, and goes away 1.6 s after the last
  action. Drawn by the emergency-stop guard (`native/BusyIndicator.cs`, commands `busy <hwnd>` / `idle`): always on
  top, borderless, click-through, never activated, absent from the taskbar, excluded from screen captures.
  `NEXUS_WINDOWS_INDICATOR=0` turns it off. Tests: `tests/indicator.test.mjs` (session wiring, guard commands, and the
  native frames rendered by the built helper in `test.ps1`).

## [1.6.0] - 2026-10-20 — Bounded foreground interactions, hardened supply chain

### Added
- **Bounded foreground interaction** (`beginInteraction`, 100 ms to 30 s): one short observe → act → observe
  sequence on transient menus and canvases keeps the same foreground lease, then gives the foreground back; never an
  open-ended lease, refused while the user is active or after the emergency stop.
- Shared guard-rail policy v2 (nexus-shared): confirmation tied to the exact action, detection of instructions aimed
  at an AI in what is read on screen; currency amounts recognised in any notation (« 4,99 € » = « 4.99 EUR »).
- OpenSSF Scorecard workflow and badge; Dependabot for GitHub Actions and npm (7-day cooldown).

### Changed
- The policy file now travels with every request to the native helper, so the guardrails also hold in the Codex
  REPL runtime (no `process` global); the helper keeps its Windows environment there.
- GitHub Actions pinned by commit SHA, checkout without persisted credentials (zizmor clean).
- Repository renamed to `pironjulien/NexusWindows-Codex`; GitHub redirects the old address.
- Erasing, resetting or formatting the whole device now needs confirmation too; "erase everything" counts only on a
  reset screen.

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
