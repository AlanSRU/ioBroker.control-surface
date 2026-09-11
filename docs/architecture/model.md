# The semantic model, and what the real adapters did to it

**Status:** both open decisions are settled — see decisions 1 and 2 below — and
the engine core has started. `src/engine/registry.ts` and
`src/engine/resolver.ts` exist and are tested; there is no adapter yet. The interfaces live in
[`src/model.ts`](../../src/model.ts); the six adapters mapped onto them live in
[`src/mapping.ts`](../../src/mapping.ts) and are verified by `npm run check`.

This is the brief's sections 46 and 47 carried out: define the interfaces, then
map the actual equipment onto them before writing any engine.

[`iobroker-react.md`](iobroker-react.md) assesses the production venue system
against this model — what it already implements by hand, what this layer would
take off it, and the two findings below that it broke.

## Why the mapping is TypeScript and not a table

The brief asks for a table. A table cannot be wrong in a way anyone notices. The
mapping is instead typed data that the compiler checks against the model, so
"the abstraction can represent an ATEM" is a claim with a build step behind it.
Every state id in it was read out of the adapter's source, and the versions
mapped are pinned in that file's header.

Verified against: iiyama-prolite 0.1.6, atlona-sw510w 0.1.0, blustream-acm
0.3.2, blustream-mfp 0.5.3, blackmagic-atem 0.2.9, sky-remote 1.0.6, streamdeck
0.5.0. Ten resources and two collections across six adapter instances, 64
bindings.

## What the mapping proved

### Routing and source-selection are one operation

This is the most useful thing to come out of the exercise. The brief treats
`source.select` (section 9) and `route(source, destination)` (section 13) as
different ideas. Against real hardware they are not. Every router surveyed
implements routing as *write a source identifier into a state belonging to the
destination*:

| Device | State written | Value written |
|---|---|---|
| Blustream ACM receiver | `receivers.rx3.videoRoute` | transmitter id, string |
| Atlona SW510W | `control.matrix.hdbasetOutput` | input number |
| ATEM mix effect | `me0.programInput` | input number |
| iiyama display | `inputSource` | input code |

A display selecting its own input is a one-output matrix. So the model has one
`route` action kind and no separate `select`, and `display.lobby` and
`atem.me1.program` end up the same shape. That is a real simplification, not a
tidy-up.

**Corrected 2026-09-11: the second half of that claim is wrong.** Reading the
production system (see [`iobroker-react.md`](iobroker-react.md)) turned up
`blustream-acm.0.system.commands.routeAll` / `routeAllVideo` / `routeAllAudio`,
in the *same adapter version this mapping already pins*. They take a transmitter
id and route every display at once, and they belong to `system` — to no
destination at all. The Blustream MFP has the same shape at `output.allSource`.

"Write a source identifier" survives and the single `route` kind survives.
"Into a state belonging to the destination" does not. See *Broadcast routing has
no destination* below.

### Breakaway forced a `layer` onto routing

Blustream ACM routes video, audio, IR, RS232, USB and CEC independently —
`ROUTE_STATES` in its `main.js` lists seven. A model where a destination has
*one* source cannot express that at all. So `route` carries a `RouteLayer`, and
a router without breakaway declares `all` only. Had the model been designed
against the ATEM and the iiyama alone, this would have been missed and would
have been a breaking change later.

### Actions and feedback need separate bindings

Most states surveyed are read/write and echo an acknowledged value back, which
hides this. The ATEM does not: `recording.start`, `recording.stop` and
`recording.switchDisk` are `read: false, write: true` buttons, while the
observable truth is `recording.status`. The adapter states the split itself in
the description on `macros.run` — *"write-only trigger, use macros.runningIndex
to read the active macro"*.

Binding therefore sits on each `ActionDef` and each `FeedbackDef`, never once
per capability. A capability-level binding would have made ATEM transport
inexpressible.

### Declaration and invocation had to be split

The brief's section 28 gives one `Action` interface with `command` and
`parameters`, and one `Feedback` with `value` and `timestamp`. Those are two
different things with different lifetimes: *what can be done* belongs to the
model and changes when configuration changes; *what is being done* belongs to
the engine and changes constantly. The model now has `ActionDef` /
`ActionInvocation` and `FeedbackDef` / `FeedbackValue`. Conflating them would
have put a mutable value inside the resource registry, which is exactly the
duplicate-source-of-truth the brief's section 30 warns against.

### A surface is a resource, so there is no `Surface` type

Added after decision 1, and it is what made that decision safe to take rather
than merely arguable. `iobroker.streamdeck` 0.5.0 publishes per deck
`currentPageId`, `connected`, `lastHeartbeat`, `model`, `firmware` and `host` —
the brief's section 20 fleet list, already shipping, as ordinary states.

`surface.reception` in the mapping binds to them and needed no new concept:
navigation is a `select`, health is the same `health` capability the iiyama
uses. A rendering endpoint is a thing that can be controlled and observed, which
is the definition of a resource. `Surface`, `SurfaceCapabilities`, `SurfaceState`
and `SurfaceGrant` are deleted accordingly.

### Feedback has to say *why* it should not be trusted

Found while writing the feedback engine. A boolean `healthy` is not enough for
the thing per-binding health exists to prevent: "the adapter is down", "this has
never reported" and "someone wrote a command that has not been confirmed" want
different things on screen, and TouchBroker's `onUnhealthy` already
distinguishes dim from hide. `FeedbackValue` therefore carries an
`UnhealthyReason` alongside the flag.

Two orderings fell out of it, both of which could reasonably have gone the other
way:

- **An offline owner outranks the reasons it causes.** An adapter that is down
  explains every one of its resources at once, so reporting `owner-offline`
  beats reporting `unacknowledged` on each of them separately.
- **An adapter that publishes no `info.connection` reads as healthy, not as
  offline.** `<instance>.info.connection` is a convention, not a guarantee.
  Failing closed would mark every resource of a well-behaved adapter unhealthy
  for following a different convention, which is worse than assuming nothing.

The unmappable-value case went the same way. When an ACM route reads `007` and
the transmitter list has not loaded, the reading is the raw `007` and stays
healthy: the device is reporting correctly and only the label is missing. A
panel showing `007` is degraded; a panel showing nothing is wrong.

### A scene cycle has to be caught before the scene starts

Scenes nest, and `fallback` hands control to another scene too, so a cycle is
reachable two ways — and the fallback route is much harder to spot by eye. A
runner that discovers one at runtime has already begun doing things to
equipment, and there is no good way to unwind that. `SceneBook.load` therefore
walks the reference graph statically, through both `scene` steps and `fallback`
policies, and rejects every scene in a cycle.

The same pass takes the other decidable faults with it: an action no resource
declares, a wait on undeclared feedback, a fallback to a scene that does not
exist, a `waitFor` with a zero timeout, a `retry` of zero times. Each of those
is a typo that would otherwise surface mid-show.

A scene is dropped **whole** where a bad resource is dropped individually. The
reasoning inverts because the risk does: half a resource registry is still
usable, whereas half a scene leaves equipment in a state nobody designed.

### `fallback` replaces the rest of a scene; it does not resume it

Written down because the first implementation got it wrong and a test caught it.
Running the backup and then carrying on with the original scene's remaining
steps is almost never wanted — those steps were aimed at the projector that just
died. So a successful fallback ends the scene, and the run still counts as
completed, because switching to the backup *is* the designed outcome rather than
a degraded one.

That distinction is why a step's result is not a boolean. "Stop, and that is
fine" and "stop, this failed" are different answers.

### `waitFor` must require a healthy reading

An unacknowledged value that happens to equal the target is a command somebody
wrote, not the device confirming anything. A scene that carried on from one
would be acting on an assumption at the exact moment it explicitly asked not
to — which is the entire reason the step exists. So the match requires
`healthy`, and this is where the feedback engine's `UnhealthyReason` earns its
keep beyond rendering.

### The published tree carries device values, not semantic names

Decided while writing the publisher, and it went against the first instinct.

Publishing `display.lobby.source = "HDMI2"` looks like the point of the whole
project. It is not, because the model deliberately refuses a universal
vocabulary (section 29) — so "HDMI2" is whatever the iiyama happens to call it,
and an Atlona need not agree. A name is no more portable than a number, and it
is worse in one specific way: for a `resourceIds` space the name is a display
label, and two transmitters may share one.

So the tree publishes the raw device value with `common.states` supplying the
labels, which is the idiom every existing ioBroker consumer already reads —
vis, Blockly, and TouchBroker's `map: {fromStates: true}`. The semantic gain is
the *addressing* and the *grouping*: `display.lobby` instead of
`iiyama-prolite.0`, capabilities instead of a flat tree. Scenes still work in
names, because that is what a person writes, and the action engine accepts
either. `FeedbackValue` gained a `raw` beside `value` for this reason.

### Publishing has rules that are checked, not chosen

The published `common` is constrained by what `repochecker` accepts, and three
of those constraints are not obvious:

- `value` is a **read-only** number; a writable one must be `level`, and a
  write-only `level` fails E1010. So a level action publishes `read: true`.
- A momentary trigger must be `button` with `read: false`. `power.on` means
  "do the on thing", never "are you on", so `set` and `toggle` publish that way
  and are never readable.
- Every intermediate `folder`, `device` and `channel` must be created
  explicitly. ioBroker tolerates an orphan state at runtime, so a missing parent
  looks fine until E3009 fires against a live object dump.

Worth noting the direction: this layer *publishes* roles while refusing to
*read* them. Role inference is what the mapping disproved; emitting one as a
hint for renderers is the opposite direction and costs nothing.

### The C66 trap has two entrances

The rule that value coercion must follow `common.type` rather than the shape of
a key was established for the resolver. The publisher reintroduced the same bug
by a different route — deriving the published `common.type` from whether the
`common.states` keys *looked* numeric, which makes a Blustream C66's `"007"`
into `7` and produces a value the device rejects.

The fix is to trust the resolved options' own types, since `optionsFor` has
already coerced them correctly. The general lesson is that this trap is not a
one-off: anywhere a device value meets a type decision, the declared type
decides. Both entrances now have a test named after the device.

### Some things genuinely do not generalise, and that is fine

The Blustream MFP microphone mixer exposes `autoBg`, `bgDelay`, `rampUp`,
`rampDown` and `mixMode`. Nothing generic can render those meaningfully. The
model accommodates them only because capability ids are an open vocabulary. The
honest position is that such a capability is addressable and scriptable but not
automatically renderable — which is the cost of section 29's "do not
over-normalize", and worth stating out loud rather than discovering later.

## What the mapping broke

### Mode 1 — automatic discovery from roles — does not work

The brief's section 15 proposes inferring semantics from `common.role` first,
with explicit descriptors as optional enrichment. That ordering is wrong.

Here is the same concept — *select the source feeding this output* — across five
adapters written by one author:

| Adapter | State | type | `role` |
|---|---|---|---|
| iiyama ProLite | `inputSource` | number | `level` |
| Atlona SW510W | `control.input` | number | `level` |
| Blackmagic ATEM | `me0.programInput` | number | `media.input` |
| Blustream ACM | `receivers.rx3.videoRoute` | string | `text` |
| Blustream MFP | `output.1.audioSource` | number | `media.input` |

Three roles, two data types, one concept. `role: 'level'` on the iiyama is
indistinguishable from `role: 'level'` on its contrast control. `role: 'text'`
on a Blustream route carries nothing at all. Routing — the single most important
AV capability — is exactly what role inference cannot recover.

If it does not work across five adapters by the same author, it will not work
across the ecosystem. **Explicit mapping is the primary mechanism, not the
fallback.** Role inference survives only as a UI convenience when an operator is
hand-building a resource: pre-selecting likely states in a picker, never
producing a resource unattended.

This is the most consequential finding here and it changes the build order:
there is no discovery engine to write in Phase 1.

### Value spaces are not uniform, so `ValueSpace` has three forms

- iiyama and Atlona publish `common.states` on the source state, so the value
  space is discoverable — `{ kind: "objectStates" }`.
- Blustream transmitter ids and ATEM input numbers exist only at runtime and
  come from elsewhere in the object tree — `{ kind: "resourceIds" }`, which is
  why `ResourceCollection` exists at all.
- Anything else needs an explicit table.

A single mapping mechanism would have failed on ACM.

**`resourceIds` also needed a `valueState`, found by implementing it.** The
first cut assumed a member's own id segment was the value it routes as. That is
true for the ACM — `transmitters.007` routes as `007` — and false for the ATEM,
whose member is `inputs.input3` while `me0.programInput` takes the number `3`.
Both adapters publish the value explicitly (`id` and `inputId`), so the resolver
reads it rather than parsing an object id, and `ResourceCollection` gained a
`valueState` beside `nameState`.

The same exercise found the ATEM collection pattern was simply wrong —
`blackmagic-atem.0.input.*` does not exist; the tree is `inputs.input<N>`. That
is the **third** state id in this mapping written from memory rather than read
out of source, after the two caught in the first cut. The rule in the file
header is not ceremony.

**Coercion has to follow `common.type`, not the shape of the key.**
`common.states` keys are always strings, but the bound state often is not — the
iiyama publishes `inputSource` as a number, so a "1" would never match a 1.
Reading a numeric-looking key as a number is equally wrong: the Blustream C66's
`output.<N>.source` is a *string* state whose states are zero-padded
(`{'01': 'HDMI 1', … '06': 'HDMI 6'}`), and sending `1` for `"01"` is a value
the device does not accept. The production venue system carries a note about
exactly this, so it is a live bug class rather than a hypothetical.

### Broadcast routing has no destination

Found by reading `iobroker-react`, not by the original survey, which read the
ACM's receivers and never looked at `system.commands.*`. It corrects the routing
finding above.

A broadcast route is not an optimisation that can be desugared into N per-output
writes. The ACM enforces a 500 ms inter-command delay, so ten receivers cost five
seconds individually against one command for the broadcast, and the production
system routes "all displays" through the broadcast for exactly that reason.
`venue-config.json` treats it as first-class — `paths.routeAll`, with validation
that rejects an `{output}` token in it, because a broadcast state must not be
per-destination.

**Settled while writing the action engine.** `route` gained an optional
`scope: RouteScope` — `"self"` (the default, and what every pre-existing mapping
entry means) or `"all"`, every destination the owning device serves. The
broadcast hangs off the matrix rather than a destination, so `mapping.ts` gained
`room1.matrix` to carry the three ACM broadcast routes.

Two things fell out of mapping it that are worth recording:

- **A broadcast has no feedback at all.** It leaves no state of its own to read —
  what changes is every receiver's own route — so `acmMatrix`'s routing
  capability declares an empty `feedback` array. This is the ATEM transport split
  taken to its limit: there, an action and its feedback bound to *different*
  states; here there is no readable counterpart to bind to.
- **The engine does not synthesise a broadcast.** Where no broadcast state
  exists, `iobroker-react` falls back to writing every output in turn
  (`getSwitcherRouteAllPaths`). Doing that here needs the set of destinations,
  which nothing in this model expresses, so it is deliberately not done — a
  scene writes N route steps instead. Whether a resource should be able to
  declare the destinations it serves is now the open question, and it is a
  smaller one than the original gap.

### One logical route may write several states

Weaker evidence than the above, and flagged as such. `VenueConfig.js` lets a
switcher model declare `paths.outputSource` as an array — one route writes every
listed state, and the first is the read-back path. It exists for Extron ties,
which write `tieVideo` and `tieAudio` together.

`StateBinding` holds a single `state`, so the model would split this across the
`video` and `audio` route layers, misrepresenting a device on which those layers
do not move independently. What is wanted is a write fan-out with one designated
read path.

Not acted on: the mechanism is live in the production resolver, but no model in
the current venue config uses the array form and `iobroker.extron` is at hardware
validation pending. Confirm against hardware first.

### ATEM's tree shape is capability-dependent

`blackmagic-atem` detects the connected model and rebuilds its state structure
accordingly, publishing the result as JSON in `device.capabilities`. So the
resource registry cannot be static configuration validated once at startup: the
states a resource binds to may not exist yet, or may disappear on reconnect. A
binding must be able to be *unresolved* without that being an error.

This is also the closest prior art for the brief's section 40 adapter API — but
note what it actually contains: a hardware inventory (how many mix effects, how
many auxes), not semantics. An adapter volunteering *semantic* descriptors is
still hypothetical.

## Decision 1 — surfaces, and where the seam goes

**Settled: this layer publishes semantics as ordinary ioBroker states, defines
no surface protocol, and has no `Surface` type at all.** TouchBroker is not the
surface layer; it is one renderer among several, and it is no longer a
dependency in either direction.

### What the earlier framing got wrong

This section previously offered two options — *TouchBroker is the surface layer*
or *this project defines its own surface protocol* — and tabulated an overlap
against "TouchBroker, as it exists". That table was wrong on the facts. What
exists in TouchBroker is `schema/layout.v0.schema.json` (302 lines), a checker,
one reference layout and three design documents. The Tier A React renderer, the
Tier B ESPHome generator, the panel agent and the fleet component are build-order
items 2 to 7 and none of them are started. There was no built surface layer to
adopt, so "reuse what exists" was never the choice on offer.

Both options also shared an assumption that turns out to be false: that this
layer has to *reach* surfaces at all.

### A surface is a resource

`iobroker.streamdeck` 0.5.0 publishes, per deck, `currentPageId`, `connected`,
`lastHeartbeat`, `model`, `firmware` and `host` — which is the brief's section 20
fleet list almost line for line, already shipping, as ordinary ioBroker states.
`surface.reception` in [`src/mapping.ts`](../../src/mapping.ts) binds to them and
needed no new concept: navigation is a `select`, health is the same `health`
capability the iiyama uses.

So a parallel `Surface` / `SurfaceCapabilities` / `SurfaceState` hierarchy would
have described the same device twice, and a scene step that takes a panel to a
page would have needed a second code path beside the one that switches a
projector input. Those interfaces are deleted. Registration, heartbeat,
capability reporting, deployment and fleet health — sections 20 to 23 — belong to
the panel runtime.

### The seam is ioBroker itself

The dependency pattern is already established and already working in this family
of projects. `TouchBroker/docs/dovetail-showcontrol.md` states it directly:

> showcontrol deliberately exposes cues as ordinary ioBroker objects. TouchBroker
> binds to them through exactly the same `@iobroker/socket-client` path it uses
> for every other adapter. **Neither side needs to know the other exists.**

and

> The dependency direction is strictly one way: TouchBroker consumes, showcontrol
> publishes. […] If TouchBroker needs something, it becomes a general adapter
> feature that any consumer (VIS, a script, Node-RED) benefits from, or it does
> not get built.

This project should be governed by exactly that rule. It publishes
`control-surface.0.resources.display.lobby.power` and does not know what reads
it. That is strictly more flexible than either original option:

- **TouchBroker needs no semantic binding kind.** A state id is a state id. Its
  v0 schema binds `control-surface.0.…` today, unchanged, and `map: {fromStates:
  true}` reads a selector's options straight off the published `common.states`.
- **Every other consumer gets semantics for free** — vis, webui, Blockly,
  JavaScript, the REST adapter, Node-RED, a Companion module. None of them would
  have spoken a bespoke socket protocol.
- **Neither project blocks the other.** Whether TouchBroker is ever built no
  longer affects this build order, which is the substantive thing this decision
  buys. It also means no versioned cross-repo contract and no standing sync rule
  is owed *by* this project — only the ordinary obligation not to break a
  published state tree.
- **There is no socket server to write.** The brief's sections 22, 23 and 39
  leave this project's scope.

### The mechanics, and the one real objection

Each declared action and feedback is published as a state under
`control-surface.0.resources.<id>.<capability>.<name>`, mirroring the bound
adapter state's shape: a write-only ATEM `recording.start` publishes `read: false,
write: true`, and `recording.status` publishes readable with its `common.states`
carried across. A `resourceIds` value space is resolved at runtime and written
onto the published object as `common.states`, which is how a selector populates
without hardcoding a member list. An unresolved binding is published with
non-zero quality rather than omitted, so a control can dim rather than vanish.

The objection is section 30: this is a second copy of a value the device adapter
owns. It is answered by direction. The semantic tree is a *projection* — always
written from the device state, never the other way, and never the thing the
engine consults to decide anything. Section 30's actual warning is about mutable
values living inside the registry, and that is already handled by the
`ActionDef` / `ActionInvocation` split. ioBroker's own `alias.0` does the same
mirroring for the same reason; aliases are not sufficient here (they cannot carry
capability grouping, route layers, collections or scenes) but they establish that
a semantic projection is idiomatic rather than a smell.

Latency is the other fair question, and the precedent is local:
`iobroker.showcontrol` already fires live-event cues through the state database
and that is considered good enough for a show.

## Decision 2 — the registry is the authorization boundary

**Settled: option 1. A semantic name resolves only to bindings an administrator
declared, and there is no runtime path to an undeclared state.** Narrowing below
that is ioBroker's own object ACLs, not a bespoke `SurfaceGrant`.

`iobroker.showcontrol` holds this property deliberately — every cue action names
its target in instance configuration (`stateId` in `src/lib/cues/schema.ts`), so
the config *is* the list of states a cue may write. Cues drive live AV equipment
mid-show, and a mis-designed or compromised panel that could name any state is a
genuinely bad failure mode.

The flexibility argument appears to favour permissioned runtime resolution, and
it is worth saying plainly why it does not:

**The flexibility it offers is redundant.** The only thing runtime resolution
adds is the ability to address states nobody declared — and ioBroker already
provides that, directly, to every client. A panel that wants a raw state binds
the raw state, with ioBroker's own permissions applying. This layer does not have
to be the universal gateway, so it does not have to be universally permissive.
Flexibility here comes from *not being in the path*, not from being permissive
when it is.

It is also nearly free. The Mode 1 finding above already establishes that
explicit mapping is required regardless, because role inference cannot recover
routing. The registry therefore exists either way; making it the boundary costs
almost nothing beyond the authoring burden that was already owed.

The cost side is concrete: ten resources and two collections across six adapter
instances needed **64 explicit bindings**, for a partial mapping of a single
room. Small enough that a declared registry is clearly workable; large enough
that hand-authoring a venue would be tedious without a builder UI.

### Why `SurfaceGrant` went with it

`SurfaceGrant` keyed on a surface id, and after decision 1 nothing registers with
this layer, so there is no surface identity to key on. The replacement is
ioBroker object ACLs on the published semantic states — a read-only lobby panel
is a user with read permission and no write permission on `resources.*`.

That is better than the interface it replaces, not merely a substitute for it.
ACLs are existing, tested infrastructure; they apply uniformly to every consumer
rather than only to endpoints that registered here; and they cannot be bypassed
by talking to the state database directly, which a `SurfaceGrant` check in this
adapter's socket handler always could have been.

## Consequences for the build order

The brief's Phase 1 is "Resource Registry, Capability model, Action Engine,
Feedback Engine, Sequence Engine, Surface Registry, WebSocket server". Three
things fall out of the findings above:

- **There is no automatic discovery component.** Cut it. What replaces it is an
  authoring path for the registry, which is a UI concern and lands earlier than
  the brief expects.
- **There is no Surface Registry and no WebSocket server.** Cut both, per
  decision 1. Surfaces are resources; consumers are ioBroker clients.
- **State publication is a Phase 1 component**, and it is the one that was not on
  the brief's list. It is what makes everything else reachable. `readAll` is
  what it walks, and `Registry.observedStates()` is what it subscribes to —
  deliberately wider than the write whitelist, because owner connection states
  are derived rather than declared.
- **The semantic layer must be an adapter, not a library.** `iobroker-react`
  implements its binding resolver three times — in `src/VenueConfig.js`, in
  `AreaSchedulerService.js` and in `MacroSchedulerService.js` — because ioBroker
  scripts cannot import from a React app's `src/`. Only a resolver that publishes
  states crosses that boundary. This reinforces decision 1 from a direction that
  decision did not consider.

Phase 1 is therefore: resource registry, binding resolver (three value-space
forms, unresolved bindings), action engine, feedback engine, state publisher,
sequence engine. `showcontrol`'s cue runner is prior art for the last, and two
of its decisions carried over unchanged: steps run sequentially unless something
says otherwise, and a dispatched step is reported as *dispatched* rather than as
*worked*.

Everything on that list now exists and is tested, and all of it is pure. What
remains is the adapter shell itself: `io-package.json`, the lifecycle,
subscriptions over `observedStates()`, applying `objectsFor`/`statesFor`, and
routing `onStateChange` through `writeTargets` into the action engine. The
engine does not decide *when* anything runs — that is a trigger, and ioBroker
already has schedules, scripts and Blockly for it.

## Still unanswered

- The repository name is not settled, and unlike `iobroker.showcontrol` it has
  had no npm or adapter-catalogue availability check.
- ~~Scenes reference resources by id; nothing yet says what happens when a scene
  references a resource whose binding is unresolved at execution time.~~
  Answered by splitting it in two. A reference that can *never* work — an
  undeclared action, an unknown scene, a cycle — is a configuration fault,
  decidable without touching a device, and `SceneBook.load` rejects the scene
  outright. A binding unresolved *right now* is a runtime condition nothing
  static can predict, it surfaces as a `refused` step failure, and
  `FailurePolicy` decides what happens next. Default is `abort`.
- `ResourceCollection` assumes members are discoverable from the object tree by
  pattern. That holds for Blustream and ATEM. It has not been checked against an
  adapter that publishes a list as a single JSON state — ATEM's
  `tally.programInputs` is `role: 'json'`, and the Stream Deck's page list is
  inside `layoutJson`, so `surface.reception` has a `navigation` action with no
  value space for exactly this reason. This is now the most load-bearing gap:
  a fourth `ValueSpace` form reading a path out of a JSON state looks likely.
- Semantic ids become ioBroker object ids once published, so they inherit
  ioBroker's charset rules — no `*`, no whitespace, and a `.` means a tree level.
  `display.lobby` becoming `resources.display.lobby` is desirable, but the
  constraint should be stated in the model rather than discovered by a user.
- **Whether a resource can declare the destinations it serves**, which is what a
  synthesised broadcast would need where no broadcast state exists. The larger
  half of this gap closed with `RouteScope`.
- **Staleness is not computed, and the model no longer claims it is.**
  `FeedbackValue`'s comment used to say a reading is unhealthy when "stale,
  unacknowledged or the owner is down". The engine computes the last two and
  cannot compute the first: nothing says what window is right, and one window
  cannot fit both `operatingHours`, which moves hourly, and `power`, which may
  not move for weeks. The one concrete case is a Stream Deck whose Pi service
  dies without clearing `connected` — `lastHeartbeat` reveals it while
  `connected` stays true — and that is a *heartbeat* problem, not a value-age
  one. Closing it properly wants something like TouchBroker's per-binding health
  source rather than a timeout on every reading.
- **Relative level actions are not expressible.** The brief's section 9 lists
  `volume.up` and `volume.down`, but an `ActionInvocation` carries a value and no
  direction, so `level.step` is read by the engine as granularity — a slider's
  step — and quantises an absolute set. Either a relative marker on the
  invocation or a separate action kind would close it. Nothing in the mapping or
  in `iobroker-react`'s 77 macro actions needs it yet, so it is recorded rather
  than built.
- **The mapping is still almost entirely AV.** `surface.reception` is a different
  *kind* of thing but not a different domain. The brief's section 35 valued a
  genuinely unrelated resource domain as proof the vocabulary is open;
  `mixergy` (hot water cylinder) or `transport-edinburgh` (transit data) would
  close this cheaply if it is worth closing.
