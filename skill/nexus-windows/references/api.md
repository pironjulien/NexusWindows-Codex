# Execution API

Use `createWindowsSession(sky)` from the installed `entry.mjs`. It sets the canonical native executable and local state directory. The portable `WindowsSession` class can also be dependency-injected for tests.

## Observations

- `windows()` inventories current windows without choosing one.
- `bind({id?, app?, title?})` requires exactly one exact match and discards prior state.
- `observe({mode:'text'|'image'|'both'})` defaults to text. Image mode is appropriate for a canvas; both is appropriate when visual and semantic evidence are both necessary.
- Add `backend:'native'` to inspect controls missing from a nonempty Sky tree, or `backend:'sky'` to return to Sky. The default `auto` retains the selected provider. Inspect the new observation before acting; provider changes never silently retarget an action.
- `activate()` restores/activates the bound window and returns a new combined observation.
- `close()` invalidates the session and closes its native worker. It does not close the application.
- `summarize(obs)` emits tree, focus, source and screenshot metadata without duplicating image payloads.

Keep the original observation object. A clone, an old observation, an observation from another session or an observation older than 30 seconds cannot authorize input. Fresh observations from another session using the same Sky object invalidate it too. Direct calls to Sky cannot be intercepted by this layer: after any external UI operation, observe again.

## Actions

Every `act(obs, request)` performs at most one input and refreshes the state. The supported request forms are:

```js
{kind:'click', selector:{automationId:'...',role:'button',ancestor:{automationId:'...'}}}
{kind:'setValue', selector:{automationId:'...'}, value:'...'}
{kind:'typeText', focus:{role:'document',name:'...'}, text:'literal text\nsecond line'}
{kind:'key', key:'Control_L+s'}
{kind:'secondary', selector:{automationId:'...'}, action:'Expand'}
{kind:'click', screenshotId:obs.screenshots[0].id, point:{x:100,y:150}, button:'left', count:1}
{kind:'scroll', screenshotId:obs.screenshots[0].id, point:{x:100,y:150}, scrollY:500, scrollX:0}
{kind:'drag', screenshotId:obs.screenshots[0].id, from:{x:100,y:150}, to:{x:200,y:250}}
```

Use a screenshot ID you actually inspected; if multiple regions are returned, choose the intended one, not blindly `[0]`. The points above illustrate syntax, not reusable coordinates. Native semantic clicks use Invoke, Select, Toggle or editable-surface Focus; they do not emulate a double/right click. Use a fresh screenshot for those operations.

Request fields are specific to each action. Unrelated fields are rejected, and a coordinate point may contain only finite `x` and `y`. In particular, `typeText` cannot accept screenshot coordinates as an alternative to its focus check.

Focus an observed editable surface and inspect the refresh before `typeText`. The function checks fresh keyboard focus and the original field's identity and ancestor context. Native runtime IDs must remain unchanged, even when labels match. `setValue` only uses a writable ValuePattern; an unsupported operation is reported, never silently redirected to keyboard input. Password controls are refused. Literal newlines stay text; submission is a distinct, authorized key action.

Append an explicit `expect` to verify the result:

```js
expect:{selector:{automationId:'Result'},field:'value',equals:'expected value'}
expect:{selector:{name:'Completed',role:'text'},exists:true}
expect:{selector:{automationId:'BusyIndicator'},exists:false}
expect:{selector:{role:'document',name:'Editor'},field:'focused',equals:true}
```

Supported fields: `name`, `value`, `selected`, `checked`, `disabled`, `description`, `focused`. An `includes` text condition may replace `equals`; prefer equality when exact output matters. `timeoutMs` bounds additional observation polling (default 1618 ms, maximum 15 seconds), not the underlying SDK input. Native requests have a 10-second worker timeout; a timeout during an action is an unknown outcome, never a safe retry signal. The native MTA process is reused for sequential requests, exits after 30 seconds idle, and is killed on timeout or protocol failure. The next explicit request starts a fresh process; no previous request is replayed.

Missing value, description, selection, check or focus evidence stays `null`; it cannot satisfy `equals:false` or `equals:''`. Sky can omit a checkbox's checked state even when the real checkbox is on. Prefer a separate application result or explicit native evidence for such a condition. Native indeterminate toggle state is also `null`.

An empty or unavailable accessibility tree cannot establish `exists:false`. With an expectation, `refresh:'image'` is promoted to `both` to obtain semantic evidence. Absence is evaluated within the controls exposed by the provider; it is not proof about inaccessible content. Native values longer than 32768 UTF-16 code units expose `valueTruncated:true`; a truncated value cannot satisfy exact equality, but can still prove that a substring is present. The focused document also exposes `accessibility.document_truncated`. For complete long-document verification, compare the saved/exported file or use a dedicated document API.

On Windows, a Sky indexed click also requires current screenshot geometry. The session obtains text and image immediately before that click. It keeps the semantic target and checks its context again; native UIA clicks do not need this image. A captured image can still be occluded, so do not treat it as visual evidence of the target unless it actually shows the target.

`refresh` defaults to text for semantic actions and both for coordinate actions. The return value has `status`, `verified`, `performed`, `durationMs`, `observation`. Without `expect`, inspect the state yourself and do not call the operation verified.

## Memory and evidence

```js
await win.remember('routine-name', result, {staticUI:true});
await win.inspectRecipe('routine-name', obs);
globalThis.result = await win.runRecipe(obs, 'routine-name');
globalThis.obs = result.observation;
await win.saveMetrics();
```

Only verified single semantic clicks or exposed secondary actions can be learned. The API rejects invented success objects, coordinates and typed content. Recipes contain an app hash, executable metadata fingerprint when observable, hash of control structure, selector, expected result and verification date. Locale, layout and executable changes invalidate reuse. Structure hashes ignore dynamic values and window titles. The native extension identifies Store/UWP applications through their application ID, including content hosted by ApplicationFrameHost; process name alone is insufficient.

Memory writes are atomic and exclusively locked per record. An abandoned lock is an explicit error: inspect it after confirming its writer is gone; do not break a live lock. Metrics contain only action type, status, time and duration, never UI text, screenshots, typed values or window titles. Saving metrics is explicit; there is no resident recorder.

Recipe schema, fingerprints, verification metadata, selectors and action fields are validated on read and write. Invalid records are reported and cannot replace a valid recipe through the write API. Temporary-file cleanup always attempts to release the record lock, even when cleanup itself fails.

## Recovery

- Missing runtime: run `NexusCodex/scripts/installer-computer-use.ps1` through the shell, then `-CheckOnly`.
- Stale/missing window: inventory again and bind the exact returned window.
- Minimized window: `activate()`, inspect, then act.
- Incomplete Sky tree: `observe({backend:'native'})`, inspect and use only controls in that new observation. UIA failure: inspect a Sky screenshot; do not force a semantic success or bypass an app restriction.
- SDK image shows another window: retarget/activate and observe. Independent assistants are not controlled by this module's in-process operation lock.
- Codex or another agent: official chat tools with the user's authorization to message, not private protocols or replayed session tokens.
