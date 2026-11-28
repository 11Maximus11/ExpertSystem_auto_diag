# aideal-auto — LeCodes app

Guidance for AI assistants working in this folder. Human docs: README.md. The whole SDK is
available as globals (`UIScreen`, `UIText`, `Scene2D`, …) — no SDK imports. `main.ts` is
the entry point; split code into other `.ts` files and import them (relative imports only) —
a file no other file imports is treated as an entry candidate, so keep everything reachable
from `main.ts`.

## Feedback loop — run the app headless instead of guessing

```
lecodes render                    # semantic JSON of the launched UI (structure, text, names, values)
lecodes render --png shot.png     # pixels (the renderer + @napi-rs/canvas install themselves on first use; --yes skips the prompt)
lecodes render --png card.png --clip card   # ONE component/region: a node name or x,y,w,h
lecodes render src/screens/cart.ts   # ONE screen module, without booting the app: any file that
                                  # `export default`s a UIScreen (or a (state) => UIScreen —
                                  # --state <name> picks the branch). Same flags as above.
lecodes render --desktop --png shot.png  # NATIVE render: real Filament 3D + UI + 2D composited —
                                  # use this to SEE 3D scenes / procedural geometry (headless
                                  # renders record 3D as JSON — simulated, not drawn). Windows/Linux; downloads
                                  # the renderer on first use. --frames <n> for slow loads.
lecodes render --script <file>    # drive the app through a scenario (format below)
lecodes render --desktop --view iso --png iso.png   # 3D: inspection camera fitted to the WHOLE
                                  # scene (iso|top|front|side|back [--fov N]) — or --camera x,y,z
                                  # --look-at x,y,z; the app's camera is untouched. In scripts:
                                  # { "view": "iso", "screenshot": "iso.png" } then { "view": "off" }
lecodes render --desktop --script <file>  # the same scenario on the NATIVE host (real GPU, the
                                  # real hit-test): the same steps, targets and expects as
                                  # headless (only expect.audio / expect.toast / the json output are headless-only)
lecodes render --sim --script <file>      # the WINDOWLESS native host (lecodes-server): the real
                                  # engines, no GPU, no pixels, no UI hit-test — expect.log /
                                  # expect.paint only; runs on CI and beside an open desktop window
lecodes test                      # all tests/*.flow.json + design-derived flows; run before "done"
bunx -p typescript tsc --noEmit   # typecheck against .lecodes/types (the SDK's globals); also before "done"
lecodes test --desktop            # the file flows on the NATIVE host (design flows stay headless)
lecodes test --sim                # the windowless twin: coordinates + expect.log / expect.paint only
lecodes dev --android --time 12 --png phone.png   # the REAL phone over adb (USB): launches the app on
                                  # the dev url via adb reverse, streams device logs as [device:log],
                                  # screenshots after 12 s, force-stops, exit 1 on a crash. --serial
                                  # <id> with several devices, --apk <file> to install a build first.
                                  # Without --time it runs until Ctrl+C (which stops the app).
lecodes dev --ios --time 12 --png sim.png   # the same on a booted iOS simulator or a plugged-in iPhone
                                  # (Mac + Xcode): --udid <id|name>, --app <LeCodesApp.app> to install.
```

Iterate with `--script` scenarios and keep the useful ones as `tests/<name>.flow.json` — they
are the regression suite. A failing step dumps the failing frame (JSON + PNG) under
`tests/.artifacts/` so a red step explains itself.

## Scenario format (tests/*.flow.json and --script files)

One action per step (`tap`, `type`+`text`, `fill`, `scroll` [+`by`], `wait`, `hover` (the
mouse over a node: `$hovered` + `onMouseEnter`; hovering elsewhere ends it), and for
games: `frames` (advance N fixed 1/60 steps, no sleeping), `drag`+`to` [+`ms`], `hold`+`ms`,
`key`+`ms` / `keyDown` / `keyUp` (KeyboardEvent.code: "ArrowRight", "KeyW", "Space" — mouse
buttons are keys too: "MouseLeft"/"MouseRight"), `look: [dx, dy]` [+`ms`] (mouse motion for
`Input.mouse.delta`), `mouseTo: [x, y]` (cursor position), `wheel: [dx, dy]`, gamepad:
`stick: { left: [x, y], right: [x, y], triggers: [l, r] }` (values persist; `index` = pad),
`gamepad: "connect" | "disconnect"`, pad buttons as keys: `keyDown: "GamepadSouth"`), then an
optional `expect` (`screen`, `node`/`notNode`, `text`/`notText`,
`value: { target, equals }`, `log` — a `console.log` line contains it,
`paint: { "<name>": { color: "#rrggbbaa", fontSize: 18, present: [...], absent: [...] } }` — the
resolved style of a named node, `audio: { played, playing }`), then outputs
(`screenshot` [+`clip`: a node name or `{ x, y, width, height }`], `json`, `dump` — the
runtime's tree with every node's box + resolved paint, identical on every host). Targets resolve
by `name` → exact visible text → substring → input placeholder. A named target of `tap`, `hold`,
`drag`, `hover` or `type` is scrolled into view first (no `scroll` step needed) and pressed
only where the press reaches it; one covered by another element (a floating bar, a dialog's scrim)
or outside the screen fails the step, naming what is on top. `{ x, y }` is pressed as given — a
tap/drag on empty space reaches the 2D scene (sprite `click`/`touchstart`, `ev.track()`). Envelope keys: `name`,
`width`/`height`, `settle`, `fixtures`, `timeout`, `clients`, `nativeViews`, `location`, `permissions`,
`push`, `steps`.

**A map, a camera, the person's location** (headless): `"nativeViews": { "map": "Map" }` in the
envelope draws the named native views as placeholders, so the app's branch for a host that HAS them
runs (their widgets, sheets and buttons are in the tree; what the view itself draws is not).
`"location": { "latitude": 58.01, "longitude": 56.24 }` (with `accuracy`, `heading`, `speed`)
or `"none"` (no fix yet) gives the app the geolocation service — without the
key `Geolocation.supported` is false — and a step `{ "location": … }` then moves the device: a
live watch is told, a waiting `getCurrent` answered. A client of `clients` may have a `location` of its own.

**What the person answered to a permission dialog** (headless): `"permissions": { "camera": "denied",
"notifications": "prompt" }` in the envelope (or in a client's entry) — kinds `camera`, `microphone`,
`location`, `speech`, `notifications`; a kind not named is `"granted"`. `"denied"`: `permissions.query`
/ `request` answer it, and the feature behind it refuses. `"prompt"`: never asked — the app's request is
the dialog, the person says yes. A step `{ "permissions": { "camera": "denied" } }` changes the answers
from then on (set `"denied"` before the tap that asks, for a refusal at the dialog).

**Push notifications** (headless, a project with `pushChannel()`): `"push": true` in the envelope gives
every client a device with remote push — `subscribe()` registers it, and what the backend sends reaches
the clients subscribed and nobody else (nothing leaves the machine). A notification the app handles
in the foreground (`onMessage`) goes to that handler; any other is a banner in the client's tray:
`"expect": { "push": "Order ready" }` / `{ "notPush": … }` look there (title or body), and a step
`{ "tapPush": "Order ready" }` taps it — the app's `onTap`; on a client a `close` step ended, the
tap STARTS the app with that notification, as on a phone.

An `expect` WAITS by itself until it holds — up to `timeout` ms (default 5000; per step, or the
envelope's `timeout`), stepping frames meanwhile at the pace of real time, so what the backend sends
lands; `notText`/`notNode` pass as soon as they hold; a failing one says what was on screen. An
action's target is waited for the same way. So no `wait` before an expect: `wait` is for time
itself to pass. `save` keeps a value for later steps: `{ "tap": "create", "save": { "code": "room-code" } }`
reads the named node's text (an input's value) once the step settled; `${code}` then stands for it
in any later step's strings (targets, `text`, `args`, expect values), and `${client}` for the
name of the client the step runs on. A variable no earlier step saved is an error naming the step.

**A case has one clock.** The app's `Date.now()` / `new Date()` / `performance.now()` read the
flow's virtual clock (from the real time the case started), and so does the backend: `wait` moves
both by its ms; `{ "clock": "+92s" }` (`"+1500ms"`, `"+2m"`) JUMPS every client and the server
at once without stepping frames — the timers due meanwhile fire once, as on a phone that was asleep
(a `setLoop` sees one long frame; the 2D/3D simulations do not run the span). Past a server
deadline: jump its length plus a margin — the server's clock also runs in real time between steps.

**Several clients** (headless, `lecodes test`): `"clients": { "ann": {}, "bob": {}, "eve": { "height": 640 } }`
starts the app once per client (each its own storage, socket and session token; a client may set its
own `width`/`height`/`device`/`safeArea`), all against the project's backend. Every step then
says where it runs — `"client": "ann"`, `"clients": ["bob", "eve"]` or `"clients": "*"` (in
parallel, one verdict) — except `clock` and `call`; after each step every client is at the same
time. `{ "client": "bob", "offline": true }` takes bob off the network (his calls fail, his socket
drops, `online` turns false; `false` brings him back); `{ "restart": "bob" }` starts his app again
on the same storage (`signal().stored()` values and his session survive, as a phone's restart);
`{ "clients": "*", "close": true }` ends clients (their sockets close; `restart` opens one again). A
`screenshot` on several clients is ONE picture, side by side in envelope order, each under its name.
A failure dumps every client's frame: tests/.artifacts/<case>/<client>/failure.json + .png.

`call` calls a server function directly: `{ "call": "game.server.ts#submitVote", "as": "bob", "args":
["${code}", "x"], "expect": { "result": { "ok": true } }, "save": { "id": "players.0.id" } }` — as
client bob's device (his session token), or, for a name no client has, as a device of its own
(`"as": "guest1"`; a list calls once per name, all at once). Its expect: `result` (matched by the
keys it names), `error: { status?, message?, count? }`, `ok: <how many answered>`. A case of only
`call`/`clock` steps and no `clients` starts no app: a server test.

Three hosts run the same file, at a fixed 16 ms clock on all of them:

| host | flag | what it is | targets | expects |
|---|---|---|---|---|
| headless | (none) | Bun: the runtime + UI renderer + a recording 3D core (no GPU) | names or `{ x, y }` | all |
| sim | `--sim` | the windowless native server: real engines, no pixels, no UI | `{ x, y }`, straight to the scene | `log`, `paint` |
| desktop | `--desktop` | the hidden desktop window: pixels, GL materials, the real hit-test | names or `{ x, y }` | all but `audio` / `toast` |

One flow file, the same verdict on headless and desktop: names resolve the same way (`name` →
exact text → substring → placeholder), every step runs (`hover`, `type`, `fill`, `scroll`,
`clip` included) and the semantic expects read the same tree. Only `expect.audio`,
`expect.toast` (the last `toast()` message — a toast is not in the tree) and the
`json` output are the headless renderer's. On the desktop `type` taps the input and types into
it (appends); the sim has no UI, so it takes coordinates and `expect.log` / `expect.paint` only.

```json
{ "steps": [
  { "expect": { "screen": "home", "text": "Taps: 0" } },
  { "tap": "tap", "expect": { "text": "Taps: 1" }, "screenshot": "after.png" },
  { "key": "ArrowRight", "ms": 500, "expect": { "log": "hero x=" } },
  { "frames": 60, "screenshot": "hud.png", "clip": "hud" }
] }
```

```json
{ "clients": { "ann": {}, "bob": {} },
  "steps": [
  { "client": "ann", "tap": "create", "expect": { "screen": "lobby" }, "save": { "code": "room-code" } },
  { "client": "bob", "type": "code", "text": "${code}" },
  { "client": "bob", "tap": "join", "expect": { "text": "2 players" } },
  { "clock": "+46s" },
  { "clients": "*", "expect": { "text": "Time is up" }, "screenshot": "both.png" },
  { "call": "game.server.ts#join", "as": "guest", "args": ["${code}"], "expect": { "error": { "status": 409 } } }
] }
```

Game time is deterministic on every host: the Aspect / System phases (`updateBefore` / `update`),
2D physics and animation advance in fixed 1/60 steps driven by `wait`/`frames`/`drag`/`key` —
never by a wall clock — so a flow that passes once passes every time. `Input.key(code)` reads the
keys a flow holds and `Input.on('keydown' | 'keyup', e => e.code)` fires for each
`key`/`keyDown`/`keyUp` step (events land before the next loop tick); `stick` values are what
`Input.gamepad(0).axis()` reads. Headless draws UI + the 2D scene (sprites, tilemaps, Box2D); 3D is
captured as JSON with REAL Jolt physics (bodies fall, characters collide, triggers fire, ragdolls
drop — a character with no ground under it falls, like on device) — use `--desktop` for 3D pixels,
`--sim` for engine behaviour on a box without a GPU. `console.log` + `expect.log` is the
assertion channel for game state that has no UI.

## Make the app testable

- Give interactive elements a `name`: `UIButton(...).named("login")` (or `el.name = "login"`;
  it is not a style key).
- Name every screen's ROOT node with the screen's id — `expect.screen` reads it.
- If the project has a `design/` folder, keep the design's screen ids and activator `name`s
  in the app code: `lecodes test` then checks the built app against the designed navigation
  automatically (conventions in design/CLAUDE.md).
- Backend-gated screens: canned responses in `tests/fixtures.json` (URL pattern →
  `{ status?, json?, text? }`; `*` wildcards full-match, plain strings substring-match, first
  match wins). A key may name a server function, `"game.server.ts#submitGuess"` (or `…%23submitGuess`):
  its body is then the RPC envelope, `{ "json": { "ok": true, "result": … } }`. Fixtures are
  headless-only, and a `computed` subscription can't be mocked (it goes over the socket to the real
  backend). `lecodes test` auto-loads it for design-derived flows; a scenario file opts in
  with `"fixtures": "fixtures.json"` in its envelope.
- A project with `*.server.ts` files: `lecodes test` runs its backend for the run, on a database
  of its own that is EMPTY before every case (a flow signs up, it never finds yesterday's data). A
  step waits for the server calls it started — no `wait` after a tap that saves. Test a backend
  app with its real backend and several `clients`, not fixtures; `lecodes call <file#fn> [args]
  [--as <name>]` calls one function from the terminal.
- **One backend per project on this machine: while `lecodes dev` runs, the other commands talk to
  it.** `render` (headless, `--desktop`, `--sim`), `desktop run`, `lecodes call` and `lecodes web
  dev` use the running dev's backend — its database and data (the room open on the phone) — instead of
  opening `.lecodes/db`; `render --fresh` empties it first, and a `render --script` beside it runs on
  real time (no `clock` step). With no dev running they run the backend themselves (`call`: on the
  test database). `lecodes test` never uses the dev's: its own database, always.
- Bots for a multiplayer app: `lecodes dev --bots tests/bots.flow.json --var code=4821` — the flow's
  `clients` join the dev backend as headless players beside the phone, on REAL time (a `clock` step is
  refused, `wait` waits; wait for the human with `"expect": {…}, "timeout": 600000`), run the flow once
  and stay in the game until Ctrl+C (unless it ends with `{ "clients": "*", "close": true }`). A failing
  step is printed (`[bots] ✗ …`) and the next runs. `--var` sets `${code}`; the envelope's
  `"vars": ["code"]` names what the flow needs, and `lecodes test` skips such a file.
- A file dialog (`openFilePicker`) is answered by `pick`, on the step whose action opens it:
  `{ "tap": "attach", "pick": "cat.png" }` — a file beside the flow file, a list of them, or a
  file made for the run: `{ "name": "me.png", "width": 400, "height": 300 }`,
  `{ "name": "notes.txt", "text": "hello" }`. Without `pick` the dialog is cancelled.
- `fill` fills every empty input — use it before tapping a disabled-until-filled submit.
- Visual state is a `$class` in the style (`$pressed`, `$hovered`, `$focused`, your own
  `$selected` set with `el.class.selected = true` or bound with `.class({ selected: () => … })`);
  the interaction states read back as `button.isPressed` / `button.isHovered`.
  A flow asserts the EFFECT through `expect.paint` on a named node (the resolved `color` /
  `backgroundColor` from the dump), never the class name — that works headless and native alike.
- Hover is the mouse's: `{ "hover": "login" }`, a `frames` step, then `expect.paint` on the node's
  resolved colour (`$hovered`) and `expect.log` from `onMouseEnter`; hover somewhere else to see
  it end. Works headless and on `--desktop`; `mouseTo: [x, y]` is the same cursor by coordinates.
  `$focused` is the desktop renderer's; a keyboard-driven highlight (your own `$focus` class moved
  by arrow keys) is assertable everywhere: `key` steps, then `expect.paint` on the highlighted node.

## 3D scenes

- A HUD over a `Scene` is one of the scene's WIDGETS: `const hud = UIWidget(...).style({ left: 16,
  bottom: 16, pointerEvents: "none" }); scene.widgets(hud)` — shown with the scene. Never a `UIScreen`:
  a screen is a destination, so `UIScreen(...).open()` after `scene.open()` CLOSES the scene
  (the host logs "3D scene closed" and you see only the screen) — no background makes it transparent.

## SDK documentation

`.lecodes/types/` is the exact API surface (signatures only; generated and gitignored — run
`lecodes update` if it's missing, never commit `.lecodes/`). For semantics and examples,
fetch the docs — they are served as raw markdown for AI tools:

- https://le.codes/llms.txt — the docs map; fetch it first to find the right page. It opens with the
  CLI: every `lecodes` command with what it is for, the agent page (running without a terminal,
  `--entry`, login) and the editors that expose MCP tools — `lecodes design` (the screen board)
  and `lecodes scene` (the 3D scene editor for `.scene.ts` files). `lecodes <command> --help`
  is the authority on flags.
  **Building a whole thing — a game, enemies, a crowd of characters, a native plugin? llms.txt opens
  with a COOKBOOK: read the matching recipe BEFORE you design the structure.** It has the file
  layout, a skeleton per part, how to verify, and the traps already paid for (start with
  "Project architecture for a game" for any game bigger than one file).
- https://le.codes/docs/api/<area>/<page>.md — one reference page as raw markdown
  (e.g. `ui/styling.md`, `2d/scene2d.md`, `3d/scene.md`, `runtime/storage.md`)
- https://le.codes/docs/guide/<page>.md — guide pages (project anatomy, CLI, tracks)
- https://le.codes/llms-full.txt — everything in one file (large; prefer per-page)

Always fetch the `.md` URLs — the HTML routes are a JS app and return an empty shell.

## Other commands

`lecodes dev` (run on a device with hot reload + QR), `lecodes compile -o app.js`
(single-file bundle), `lecodes design` (screen-design board — the living spec).
