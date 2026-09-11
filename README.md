# ioBroker Control Surface

A semantic control and presentation layer for [ioBroker](https://www.iobroker.net/):
existing adapters keep owning their devices, and this sits above them so that
*"show the laptop on the projector"* is expressible without knowing which
protocol answers.

**Status: the two decisions that were blocking implementation are settled, and
the engine core has started.** The registry and the binding resolver exist and
are tested; there is no ioBroker adapter yet. See
[`docs/architecture/model.md`](docs/architecture/model.md).

The name is free on npm and absent from the ioBroker adapter catalogue as of
2026-09-11. Worth re-checking before anything is published.

## What exists

| Path | What it is |
|---|---|
| [`src/model.ts`](src/model.ts) | The interfaces: Resource, Capability, Action, Feedback, Scene. |
| [`src/mapping.ts`](src/mapping.ts) | Real adapters expressed against those interfaces — the stress test. |
| [`src/engine/registry.ts`](src/engine/registry.ts) | The declared resources, and the only states this layer may touch. |
| [`src/engine/resolver.ts`](src/engine/resolver.ts) | Semantic values ↔ device values, for all three `ValueSpace` forms. |
| [`src/engine/actions.ts`](src/engine/actions.ts) | An invocation becomes the writes that carry it out, or a typed refusal. |
| [`src/engine/feedback.ts`](src/engine/feedback.ts) | The read direction, and why a reading should or should not be trusted. |
| [`docs/architecture/model.md`](docs/architecture/model.md) | What the mapping proved, what it broke, and the two settled decisions. |
| [`docs/architecture/iobroker-react.md`](docs/architecture/iobroker-react.md) | The production venue system assessed against the model — crossover, and what this layer would take off it. |

`npm run verify` typechecks everything and runs the tests. The mapping compiles
only if the model can represent equipment that actually exists, and the engine
tests run against the value spaces those same adapters really publish — an ATEM
input that routes by `inputId` rather than by its object id, a Blustream C66
whose input ids are zero-padded strings.

Mapped so far: Blackmagic ATEM, Blustream ACM, Blustream MFP, Atlona SW510W,
iiyama ProLite, a Sky box and a Stream Deck — ten resources and two collections
across six adapter instances, 64 bindings. Every state id was read out of adapter
source, and the versions are pinned in `src/mapping.ts`.

## The two decisions, settled

1. **How do surfaces reach this layer?** They don't. It publishes semantics as
   ordinary ioBroker states and defines no surface protocol — so every ioBroker
   consumer gets them for free and none needs special integration. A rendering
   endpoint is itself a resource: `iobroker.streamdeck` already publishes
   `currentPageId`, `connected` and `lastHeartbeat` as states, and the mapping
   binds them like any display. There is no `Surface` type, no socket server and
   no surface registry.
2. **Is the resource registry the authorization boundary?** Yes. A semantic name
   resolves only to bindings an administrator declared, so there is no runtime
   path to an undeclared state — the property `ioBroker.showcontrol` holds today.
   Narrowing below that is ioBroker's own object ACLs, which apply to every
   consumer rather than only to registered endpoints.

Both are argued out in [`docs/architecture/model.md`](docs/architecture/model.md).

## Relationship to the sibling projects

Neither is a dependency, in either direction. This project publishes ordinary
ioBroker objects and does not know what reads them.

- **`ioBroker.showcontrol`** — stays as it is: an Art-Net/sACN output and cue
  adapter. Under this model it is one of the device adapters being orchestrated,
  not a layer of this one. Its cue runner is prior art for the sequence engine,
  and its config-is-the-whitelist property is what decision 2 preserves.
- **TouchBroker** — a panel builder and multi-target runtime, and one possible
  renderer among several. It needs no semantic binding kind to consume this
  layer: a published semantic state is just a state id to its v0 schema.
- **`iobroker-react`** — the live venue control system, and the realistic first
  consumer. It is **not** being replaced: it already hand-implements a resource
  registry, a binding resolver and a sequence engine, and this layer would take
  those off it while its venue application — match day, bookings, scheduling,
  reporting — stays put. Assessed in
  [`docs/architecture/iobroker-react.md`](docs/architecture/iobroker-react.md).

## Building

```bash
npm install
npm run verify    # tsc --noEmit, then the tests
```

Tests are `node:test` run through Node's native type stripping, so there is no
test runner or transpiler dependency. Node 22.6+ is required.

## Licence

MIT.
