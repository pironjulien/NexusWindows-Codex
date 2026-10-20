# Execution API

Use `createWindowsSession(sky)` from the installed `entry.mjs`. It sets the canonical native executable and local state directory. The portable `WindowsSession` class can also be dependency-injected for tests.

## Observations

- `windows()` inventories current windows without choosing one.
- `bind({id?, app?, title?})` requires exactly one exact match and discards prior state.
- `observe({mode:'text'|'image'|'both'})` defaults to text. Image mode is appropriate for a canvas; both is appropriate when visual and semantic evidence are both necessary.
- `observe({mode:'image'|'both', capture:'native'})` captures the window with `PrintWindow(PW_RENDERFULLCONTENT)` without bringing it forward, even covered; DPI-unaware windows are scaled to their displayed size and the image is cropped to the DWM frame. `obs.images` = `[{path, width, height, method:'printwindow'|'printwindow-dpi-scaled', scale, ms, frame}]`: a local PNG under `%LOCALAPPDATA%/NexusCodex/ComputerUse/captures` (10 minutes, 32 files) to open with `view_image`. Blank, minimized or failed: `obs.imageFallback` gives the reason and `obs.screenshots` holds Sky's screenshot (Windows.Graphics.Capture). Native images are never coordinate targets.
- Every observation has `windowStack` (followed window ids, bound window first) and `windowChange` (`null`, or `{reason:'opened'|'closed', from, to}`). `observe()` follows a new owned dialog, or an owned window when the front window is disabled (modal); windows already open at `bind` are not followed. Transient popups (an open drop-down list, a tooltip, a WPF popup: caption-less, non-activatable, or a Win32 `ComboLBox`) are never followed: their content is read through the window's own tree, and they are listed in `obs.popups` (`[{id, className}]`). Bind one explicitly only if its content is missing from the window (a WPF context menu).
- Add `backend:'native'` to inspect controls missing from a nonempty Sky tree, or `backend:'sky'` to return to Sky. The default `auto` retains the selected provider. Inspect the new observation before acting; provider changes never silently retarget an action.
- `activate()` restores/activates the bound window and returns a new combined observation. It is a foreground action: Julien's pause, shared token, his window given back if the target still holds the foreground.
- `beginInteraction({durationMs:30000})` activates the exact bound window and returns a combined observation while keeping the shared foreground lease for a short observe/action sequence. Use only when a transient menu closes on focus loss or a canvas needs continuous focus. The lease has a hard maximum of 30 seconds and ends on Julien's physical input, emergency stop, unknown input, or loss of presence information. `endInteraction()` gives the foreground back and invalidates observations; always call it in a `finally` when finished. `close()` also ends it. Each action retains its ordinary presence, confirmation, identity, freshness and postcondition checks. Background semantic actions remain available; a native semantic foreground fallback is refused inside the interaction to avoid nesting another lock, so use freshly observed coordinates for that fallback. Do not bind another window or start another session while holding this lease. After timeout or interruption, observe again; never replay an input automatically.
- Native elements carry `expanded` (`true`/`false`, `null` without an ExpandCollapse state). A combo box's `value` is its chosen option: Value pattern, else the Selection pattern (WPF), else `CB_GETCURSEL` for Win32/WinForms. The options of a Win32/WinForms combo box are read by messages, list open or closed, as `list` and `listitem` children (runtime identity `[-1, window, kind, rank]`); a click on such an option chooses it by its rank.
- Hard block from the shared policy `garde-fous.json` (entry `codex`): secure desktop (UAC, lock, sign-in), Windows credential prompts, password managers, Codex's own app (Codex, ChatGPT). Refused before any read (`refused`); a missing or invalid policy refuses everything. Console and terminal windows, Explorer and administration tools are free.
- `close()` invalidates the session and closes its native worker. It does not close the application.
- `summarize(obs)` emits tree, focus, source and screenshot metadata without duplicating image payloads.

Keep the original observation object. A clone, an old observation, an observation from another session or an observation older than 30 seconds cannot authorize input. Fresh observations from another session using the same Sky object invalidate it too. Direct calls to Sky cannot be intercepted by this layer: after any external UI operation, observe again.

## Actions

Every `act(obs, request)` performs one action (a background attempt, then at most one physical fallback, see below) and refreshes the state. The supported request forms are:

```js
{kind:'click', selector:{automationId:'...',role:'button',ancestor:{automationId:'...'}}}
{kind:'setValue', selector:{automationId:'...'}, value:'...'}
{kind:'typeText', focus:{role:'document',name:'...'}, text:'literal text\nsecond line'}
{kind:'key', key:'Control_L+s'}
{kind:'secondary', selector:{automationId:'...'}, action:'Expand'}
{kind:'select', selector:{automationId:'...'}, option:'Bravo'}          // list or combo box, background only
{kind:'menu', path:'File > Save'}                                       // Win32 HMENU command, background only
{kind:'click', screenshotId:obs.screenshots[0].id, point:{x:100,y:150}, button:'left', count:1}
{kind:'scroll', screenshotId:obs.screenshots[0].id, point:{x:100,y:150}, scrollY:500, scrollX:0}
{kind:'drag', screenshotId:obs.screenshots[0].id, from:{x:100,y:150}, to:{x:200,y:250}}
```

Use a screenshot ID you actually inspected; if multiple regions are returned, choose the intended one, not blindly `[0]`. The points above illustrate syntax, not reusable coordinates. Semantic actions never emulate a double/right click. Use a fresh screenshot for those operations.

### Background first

Semantic `click` (one left click), `setValue`, `typeText`, `secondary` (Expand/Collapse), `select` and `menu` go first to the native helper in background mode, for Sky and native observations alike (a Sky observation is matched again by selector in the helper's own tree; a native one also by runtime identity):

- Win32 controls: `BN_CLICKED` to the parent (plus `BM_SETCHECK` for auto check boxes and auto radio groups), `EM_SETSEL`+`EM_REPLACESEL` (`setValue`; `typeText` inserts at the caret; a single-line field refuses line breaks), combo box: `secondary` Expand/Collapse by `CB_SHOWDROPDOWN` read back by `CB_GETDROPPEDSTATE`, `select` or a click on an option (open list included) by `CB_SETCURSEL`+`CBN_SELCHANGE`+`CBN_SELENDOK` after closing an open list first (closing is a cancel that restores the previous choice), `LB_SETCURSEL`+`LBN_SELCHANGE` (also a click on a list item), `TCM_SETCURFOCUS`, `WM_COMMAND` for menus; UIA Toggle. Never UIA Invoke (foreground) nor UIA Select on a list (silent).
- WinForms: UIA Invoke/Toggle; Edit, ComboBox (as Win32) and ListBox by messages.
- WPF, UWP/WinUI, Chromium/Electron: COM UI Automation with `AutoSetFocus = FALSE` in the `--com-worker` child process (Invoke, Toggle, Value, SelectionItem, ExpandCollapse read back by its state). A combo box is always closed again after a choice: `select` (published option, else expand, choose, collapse) or a click on an option of the open list.

Options match exactly (whitespace-normalised), then case-insensitively; never partially; duplicates are refused. Menu paths match the full path, else a unique suffix; a disabled command or a disabled window (modal dialog) is refused. The command state is read after `WM_INITMENU` and `WM_INITMENUPOPUP` are sent to the owner (as a real opening does); without an answer, or if the menu changed meanwhile, the state is not verifiable and nothing is posted.

The helper re-reads the effect: `applied`, `none` or `sent`. **Physical fallback** (Sky under the foreground token, after Julien's pause) only when no background technique applies, or when `expect` is unmet and the helper read back `none`. After `sent` with an unmet `expect` and an identical values/states digest (no window change), the status is `sent-unconfirmed` (attempt outcome `effect-not-read`): never verified, never repeated, since a slow effect would be doubled. A changed state with an unmet `expect` stays `unmet`, never repeated. `fallback:false` disables the physical path. `select` and `menu` have no physical path; a native observation's physical path for a semantic click is UIA under the token (`foreground:uia`: Invoke, or SetFocus on an editable surface), and it has no physical `setValue`/`secondary`. Errors with `refused:true` (password, hard-blocked application, missing confirmation (`confirmationRequired:true`), changed identity, window closed during the request, off-screen target with no visible part, disabled target or window) or `beforeInput:true` sent nothing and are never retried. A click whose target has the `offscreen` flag (UIA `IsOffscreen`) and no part inside its window is refused before input.

Physical `typeText` is sent one grapheme at a time; the emergency stop is checked before each. If Julien presses the stop, types or uses the mouse, the rest is not sent: `status:'interrupted'`, `interrupted:'julien'|'emergency-stop'`, `typed:{chunks,total}`, `verified:false`.

Request fields are specific to each action. Unrelated fields are rejected, and a coordinate point may contain only finite `x` and `y`. In particular, `typeText` cannot accept screenshot coordinates as an alternative to its focus check.

Focus an observed editable surface and inspect the refresh before `typeText`. The function checks fresh keyboard focus and the original field's identity and ancestor context. Native runtime IDs must remain unchanged, even when labels match. `setValue` only uses a writable ValuePattern; an unsupported operation is reported, never silently redirected to keyboard input. Password controls are refused. A line break in `typeText` is judged like Enter by the confirmation check (see below).

Append an explicit `expect` to verify the result. It must describe the **effect** of the action:

- A postcondition that only restates the target (`exists:true` on the target, or its label already given by the selector) is refused at validation (`beforeInput`, also for every batch step before any input).
- Already true **before** the action: `already-satisfied` (nothing sent) only for a precise state the action changes, `equals` on the target's `value`, `checked`, `selected`, `expanded` or `focused`, or `equals` on another element (a result label: a send already made is not resent). Otherwise (`exists`, `includes`, the target's label) the action is refused before input: such a condition cannot tell its effect from the previous state.
- Expand/Collapse: `{selector:<the control>, field:'expanded', equals:true|false}`. A combo box choice (`select`, or a click on an option): `{selector:<the combo box>, field:'value', equals:'Bravo'}`; a postcondition on the option element itself is refused (exposed only while the list is open, or always present, depending on the provider).

Examples:

```js
expect:{selector:{automationId:'Result'},field:'value',equals:'expected value'}
expect:{selector:{name:'Completed',role:'text'},exists:true}
expect:{selector:{automationId:'BusyIndicator'},exists:false}
expect:{selector:{role:'document',name:'Editor'},field:'focused',equals:true}
```

Supported fields: `name`, `value`, `selected`, `checked`, `expanded`, `disabled`, `description`, `focused`. An `includes` text condition may replace `equals`; prefer equality when exact output matters. `timeoutMs` bounds additional observation polling (default 1618 ms, maximum 15 seconds), not the underlying SDK input. Native requests have a 10-second worker timeout; a timeout during an action is an unknown outcome, never a safe retry signal. The native MTA process is reused for sequential requests, exits after 30 seconds idle, and is killed on timeout or protocol failure. The next explicit request starts a fresh process; no previous request is replayed.

Missing value, description, selection, check or focus evidence stays `null`; it cannot satisfy `equals:false` or `equals:''`. Sky can omit a checkbox's checked state even when the real checkbox is on. Prefer a separate application result or explicit native evidence for such a condition. Native indeterminate toggle state is also `null`.

An empty or unavailable accessibility tree cannot establish `exists:false`. With an expectation, `refresh:'image'` is promoted to `both` to obtain semantic evidence. Absence is evaluated within the controls exposed by the provider; it is not proof about inaccessible content. Native values longer than 32768 UTF-16 code units expose `valueTruncated:true`; a truncated value cannot satisfy exact equality, but can still prove that a substring is present. The focused document also exposes `accessibility.document_truncated`. For complete long-document verification, compare the saved/exported file or use a dedicated document API.

On Windows, a Sky indexed click also requires current screenshot geometry. The session obtains text and image immediately before that click. It keeps the semantic target and checks its context again; native UIA clicks do not need this image. A captured image can still be occluded, so do not treat it as visual evidence of the target unless it actually shows the target.

`refresh` defaults to text for semantic actions and both for coordinate actions. The return value has `status` (`verified`, `unmet`, `sent-unconfirmed`, `observed`, `already-satisfied`, `interrupted`), `verified`, `performed`, `technique`, `mechanism`, `foregroundTaken` (`true`, `false`, or `null` when unknown), `foregroundReturned` (foreground actions: `restored`, `not-taken`, `kept-by-julien`, `none`, `refused`, or `null` when unknown), `attempts` (`[{technique, mechanism?, effect?, outcome?, reason?}]`), `julienInput` (Julien used keyboard or mouse during a physical input), `presence` and `waitedMs` (physical input only), `windowChange`, `durationMs`, `observation`. Without `expect`, inspect the state yourself and do not call the operation verified.

### Verified batch

```js
globalThis.batch = await win.actBatch(obs, [
  {kind:'setValue', selector:{automationId:'name'}, value:'Julien', expect:{selector:{automationId:'name'}, field:'value', equals:'Julien'}},
  {kind:'click', selector:{automationId:'save', role:'button'}, expect:{selector:{automationId:'status'}, field:'name', equals:'Saved'}},
]);
globalThis.obs = batch.observation; // null after an unknown outcome: observe again
```

1 to 32 steps, each with an `expect`; all steps are validated before any input. Each step uses the observation refreshed by the previous step; an observation younger than 162 ms (the previous step's) is not read a second time before input, the helper re-reading the target and its ancestors at input time anyway. The batch returns `{status:'completed'|'stopped', stoppedAt?, completed, steps:[{index, kind, status, verified, performed, technique, foregroundTaken, julienInput, windowChange, durationMs, error?}], observation}` and stops at the first step that is not `verified`/`already-satisfied`, or is `unknown`, `deferred`, `julien-active`, `confirmation-required`, `refused` or interrupted. An emergency stop is rethrown with `error.batch`.

### Julien's presence

`win.presenceStatus()` returns `{source:'raw-input'|'last-input-info'|'none', available, idleMs}`, fed by the `--stop-guard` process (instants of physical input only, never their content). Before physical input the session waits for 1618 ms without input, at most 8000 ms; still active: error `julienActive:true, deferred:true`, nothing sent. Background techniques never wait. If a guard was started (`createWindowsSession`) but presence is unknown (guard crashed or restarting), every action checkpoint restarts it, the session waits about 1.6 s for it, then defers the input (`presenceUnknown:true, deferred:true`, nothing sent). Only without any planned guard (tests) does physical input proceed with `result.presence` set to `none`.

## Memory and evidence

```js
await win.remember('routine-name', result, {staticUI:true});
await win.inspectRecipe('routine-name', obs);
globalThis.result = await win.runRecipe(obs, 'routine-name');
globalThis.obs = result.observation;
await win.saveMetrics();
```

Only verified single semantic clicks or exposed secondary actions can be learned. The API rejects invented success objects, coordinates and typed content. Recipes contain an app hash, executable metadata fingerprint when observable, hash of control structure, selector, expected result and verification date. Locale, layout and executable changes invalidate reuse. Structure hashes ignore dynamic values and window titles. The native extension identifies Store/UWP applications through their application ID, including content hosted by ApplicationFrameHost; process name alone is insufficient.

Memory writes are atomic and exclusively locked per record. An abandoned lock is an explicit error: inspect it after confirming its writer is gone; do not break a live lock. Metrics (schema 2) contain only action type, status, technique, time and duration, never UI text, screenshots, typed values or window titles. Saving metrics is explicit; there is no resident recorder.

Recipe schema, fingerprints, verification metadata, selectors and action fields are validated on read and write. Invalid records are reported and cannot replace a valid recipe through the write API. Temporary-file cleanup always attempts to release the record lock, even when cleanup itself fails.

## Emergency stop

The session reads `%USERPROFILE%/.nexus/stop` (shared protocol `emergency-stop.md`) every 0.2 s and before each action. A new version (write time + content) younger than 120 s latches a stop in memory on a monotonic clock for the remaining time: deleting the file or changing the wall clock never lifts it, a new press re-arms it. During the stop, `act`, `activate`, `runRecipe`, `NativeUIA.call` for actions, `withForeground` and the native helper itself (`--server` actions, `--foreground-token`) refuse with the message `Arrêt d'urgence demandé par Julien (Ctrl+Alt+Maj+Échap) : plus aucune action pendant encore N s ; ne pas contourner. …`. The error has `emergencyStop:true` and `deferred:true`, the metric status is `stopped`, and the presented observation is consumed. The stop is checked again after the foreground token is acquired, just before the input. A single SDK call already in flight (for example one `typeText`) cannot be interrupted midway.

`createWindowsSession` also starts one `--stop-guard` helper per REPL process. It tries `RegisterHotKey(Ctrl+Alt+Shift+Esc, MOD_NOREPEAT)` and retries every 3 s while another agent holds it. As holder, it writes `stop.owner` every 3 s and, on a press, latches, writes `stop` (`{"by":"NexusCodex","pid","at","hold_s":120,"nonce"}`) and notifies the session. It exits when the REPL closes its stdin. `win.emergencyStopStatus()` returns `{remainingS, stopped, hotkey, guard, directory}`.

`NEXUS_SHARED_HOME` redirects these files for tests only. A guard pointed at such a directory never registers the real hotkey. Tests must never write the real `~/.nexus/stop`: it would freeze Julien's other agents.

## Recovery

- Missing runtime: run `NexusCodex/scripts/installer-computer-use.ps1` through the shell, then `-CheckOnly`.
- Stale/missing window: inventory again and bind the exact returned window.
- Minimized window: `activate()`, inspect, then act.
- Incomplete Sky tree: `observe({backend:'native'})`, inspect and use only controls in that new observation. UIA failure: inspect a Sky screenshot; do not force a semantic success or bypass an app restriction.
- SDK image shows another window: retarget/activate and observe. Independent assistants are not controlled by this module's in-process operation lock.
- Codex or another agent: official chat tools with the user's authorization to message, not private protocols or replayed session tokens.

## Confirmation (`confirm`)

Every action accepts `confirm:true|false` (boolean). Without `confirm:true`, a gesture whose trigger carries a word of the shared policy (pay, buy, order, transfer money, send, publish, post, delete permanently, empty the trash, uninstall, format a disk, reset, cancel a subscription, delete an account or data, make a repository public; or Validate/OK/Start in a payment or formatting window) is refused before input with `error.confirmationRequired`, `refused` and `beforeInput` (metric and batch status `confirmation-required`). What is judged:

| Gesture | Trigger judged |
| --- | --- |
| `click` (left, single or double) by selector | the button, link or menu item carrying the target (a text or icon inside a button counts as the button); non-action roles (list or tree item, tab, field, combo box, check box…) and submenu items are free |
| `click` by coordinates | the deepest element under the point in a fresh native tree, then as above |
| `key` Enter | focused element, default button (UIA legacy state, or WPF access key Enter), action buttons next to the focused field (up to 3 ancestors) |
| `key` Ctrl+Enter | every action button of the window |
| `key` Space | focused element |
| `key` Alt+letter | action with that access key, or a label with that underlined letter (`_Send`, `&Send`) |
| Enter or Space with no known focus | every action button of the window (focus unknown until activation) |
| `typeText` with a line break | as Enter in that field |
| `menu` | the last item of the path |
| `secondary` | the target, except Expand, Collapse, Toggle, Select, scrolling |

Right and middle clicks and scrolls are free; a drag is judged at its start and end points. `runRecipe(obs, name, {confirm:true, accord})` passes the confirmation to a learned action.

**Accord bound to the exact action (`accord`, shared policy v2).** An outward trigger (send, call, pay, publish, transfer; or Validate/OK in a payment window) needs `confirm:true` AND `accord:'<token>'`. Without a valid token the gesture is refused before input (`confirmationRequired`, `accordRequired`, `accord` = a new single-use token, `summary` = gesture, triggers, recipients (value of a field named To, To recipients, Cc, Bcc, À, Cci, Destinataire, E-mail, Courriel, Téléphone, Bénéficiaire, IBAN…; and the chips (buttons, list items, links) inside such a container or next to such a field, except the gesture's own triggers; shown first and in full), the conversation (window title without its unread counter, headings, selected list, grid or tab items: a chat app's recipient), other editable field values (never a password; a document when it is the target field or within three ancestors of the trigger), typed text in full with each line break shown as ⏎ and counted, fields up to 2,000 characters, application and window title). Text is bound as is: line breaks are never collapsed. The binding covers the application and window id, not the title, so a counter in the title does not void a yes. The token is burned only right before input and given back if the input is refused before anything was sent (focus, Julien's presence, emergency stop). A left-button `drag` is judged like a coordinate click at both its start and end points. A coordinate gesture with no element bounds under the point (native reading too large or unavailable) is judged as if it aimed at every named element of the window that carries a trigger (any role), with every document of the window bound; with nothing read at all it is refused before input. Enter in a field is judged on the action buttons of its group, widened ancestor by ancestor (never the root) until one carries a word to confirm. Tab followed by Space or Enter in the same `key` gesture, or a typed tab followed by a space or line break (in a document too: Tab can move the focus to Send), is judged on every action button of the window. The token is valid 10 minutes, once, for that exact description: a changed field, trigger or window is refused with the changed parts named and a new token. Local destructions (`motifs_locaux` of the policy: uninstall, format, empty the trash, reset…) keep `confirm:true` alone. The token proves the exact action was described before running unchanged, not who said yes: Codex shows the summary to Julien and resends only after his own yes in the conversation.
