# The semantic model, and what the real adapters did to it

**Status:** design stage. Nothing is implemented. The interfaces live in
[`src/model.ts`](../../src/model.ts); the five adapters mapped onto them live in
[`src/mapping.ts`](../../src/mapping.ts) and are verified by `npm run check`.

This is the brief's sections 46 and 47 carried out: define the interfaces, then
map the actual equipment onto them before writing any engine.

## Why the mapping is TypeScript and not a table

The brief asks for a table. A table cannot be wrong in a way anyone notices. The
mapping is instead typed data that the compiler checks against the model, so
"the abstraction can represent an ATEM" is a claim with a build step behind it.
Every state id in it was read out of the adapter's source, and the versions
mapped are pinned in that file's header.

Verified against: iiyama-prolite 0.1.6, atlona-sw510w 0.1.0, blustream-acm
0.3.2, blustream-mfp 0.5.3, blackmagic-atem 0.2.9, sky-remote 1.0.6.

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

## Open decision 1 — the surface layer, and TouchBroker

`src/model.ts` deliberately stops at surface registration, identity and health.
It does **not** define a logical-UI schema, widget set, renderer contract or
deployment format, because TouchBroker already has those and is at the same
stage of maturity.

The overlap is not partial:

| Brief | TouchBroker, as it exists |
|---|---|
| §24 Logical UI, declarative, renderer-independent | `schema/layout.v0.schema.json`, machine-checked |
| §25 renderer per surface class | Tier A React renderer / Tier B ESPHome LVGL generator |
| §26 small component library, later expansion | closed widget set, deliberately short for Tier B |
| §22 browser runtime package | Tier A runtime, browser/Capacitor/Tauri |
| §21 registration, heartbeat, §20 fleet | panel agent, deploy, rollback, fleet component |
| §39 `-runtime` `-components` `-esphome` `-hub75` packages | the same products, already named |
| Phase 4 designer after runtime | build order step 3, builder after renderer |

TouchBroker has also already solved problems this model would otherwise hit
cold, and solved them against real constraints:

- **No expressions, ever** — because Tier B compiles to declarative ESPHome YAML
  with no JavaScript. An expression in a layout is a layout that cannot target a
  constrained panel. The same argument applies to this project's §12 96×48 LED
  renderer, and it is a constraint worth inheriting rather than rediscovering.
- **Per-binding health** — a GO button whose adapter is down still looks
  pressable. That is why `health` appears as an ordinary capability in the
  mapping above.
- **`mode: "write"` and `ack: false`** — for states like sky-remote's buttons
  that have no readable value, and for adapters that ignore acknowledged writes.

The realistic options:

1. **TouchBroker is the surface layer.** This project defines Resource,
   Capability, Action, Feedback, Scene and the engine, and exposes them to
   TouchBroker through ioBroker states plus a socket API. TouchBroker's schema
   gains a binding kind that targets a semantic action instead of a raw state id.
   Two repositories, one product each, one seam to design.
2. **This project defines its own surface protocol.** Independent, and duplicates
   a renderer, a builder, a fleet agent and an ESPHome generator that already
   have a design and a build order.

Option 1 is the recommendation on the evidence. The work it implies is a
*binding kind*, not a platform: TouchBroker binds to `display.lobby.power`
instead of `iiyama-prolite.0.power`, and inherits value maps and health from the
semantic layer rather than restating them per design.

Either way the decision must be made before the engine is written, because it
determines whether feedback is delivered as ioBroker states (which TouchBroker
already consumes) or over a bespoke socket protocol.

## Open decision 2 — how targets resolve, and what replaces the whitelist

`iobroker.showcontrol` holds a deliberate safety property: every cue target is
declared in instance configuration, so there is no runtime path to an
undeclared foreign state. Cues write to live AV equipment during events, and a
mis-designed or compromised panel that could name any state is a genuinely bad
failure mode.

The semantic layer does not automatically inherit this. Sections 16, 21 and 31
describe runtime resolution of semantic names, and self-registering surfaces
reporting their own capabilities.

The mapping gives the cost side of this concretely. Eight resources and two
collections across five adapter instances needed **54 explicit bindings**, for
what is a partial mapping of a single room. That is the real number to reason
about: small enough that a declared registry is clearly workable, large enough
that hand-authoring it for a venue would be tedious without a builder UI to
generate it.

The two options:

1. **Declared registry, surfaces cannot exceed it.** The resource registry *is*
   the whitelist — a semantic name resolves only to bindings an administrator
   declared, and a surface can invoke only declared actions. `SurfaceGrant`
   narrows further, never widens. The property from showcontrol survives intact.
   Cost: the registry must be authored, so a builder UI becomes necessary
   sooner than the brief's Phase 4.
2. **Permissioned runtime resolution.** The engine resolves arbitrary states and
   section 42's identity, roles and permissions are the only control. More
   flexible; a materially larger security surface that has to be designed,
   tested and kept correct from the first release.

Option 1 also falls out of the Mode 1 finding above: if explicit mapping is
required anyway because role inference does not work, then the registry exists
regardless, and making it the authorization boundary costs almost nothing extra.

Recommendation: option 1, with `SurfaceGrant` as a narrowing layer on top.

## Consequences for the build order

The brief's Phase 1 is "Resource Registry, Capability model, Action Engine,
Feedback Engine, Sequence Engine, Surface Registry, WebSocket server". Two
changes fall out of the above:

- **There is no automatic discovery component.** Cut it. What replaces it is an
  authoring path for the registry, which is a UI concern and lands earlier than
  the brief expects.
- **The WebSocket server is contingent on open decision 1.** If TouchBroker is
  the surface layer, the engine publishes to ioBroker states and there may be no
  bespoke socket protocol to write at all.

What is uncontested and can be built first: the resource registry, the binding
resolver (including the three value-space forms and unresolved bindings), the
action engine, the feedback engine, and the sequence engine. `showcontrol`'s cue
runner is prior art for the last of these.

## Still unanswered

- The repository name is not settled, and unlike `iobroker.showcontrol` it has
  had no npm or adapter-catalogue availability check.
- Scenes reference resources by id; nothing yet says what happens when a scene
  references a resource whose binding is unresolved at execution time. The
  `FailurePolicy` shapes exist but the engine semantics do not.
- `ResourceCollection` assumes members are discoverable from the object tree by
  pattern. That holds for Blustream and ATEM. It has not been checked against an
  adapter that publishes a list as a single JSON state — ATEM's
  `tally.programInputs` is `role: 'json'`, so that case exists nearby.
- **The mapping is now entirely AV.** The brief's section 35 valued a
  completely different resource domain as proof the vocabulary is genuinely
  open, and that case is no longer covered: sky-remote is the least AV-shaped
  resource mapped, and it is still an entertainment device. The model permits
  arbitrary capability ids by construction, but nothing tests it. `mixergy`
  (hot water cylinder) or `transport-edinburgh` (transit data) would close this
  cheaply if it is worth closing.
