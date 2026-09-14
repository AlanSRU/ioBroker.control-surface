# ioBroker Control Surface

A semantic control and presentation layer for [ioBroker](https://www.iobroker.net/):
existing adapters keep owning their devices, and this sits above them so that
*"show the laptop on the projector"* is expressible without knowing which
protocol answers.

**Status: Phase 1 is built.** Registry, resolver, action engine, feedback
engine, sequence engine and state publisher all exist and are tested with no
ioBroker anywhere near them; the adapter applies them. It has not yet been run
against live equipment and the admin UI is JSON rather than a builder. See
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
| [`src/engine/scenes.ts`](src/engine/scenes.ts) | Scene validation: the faults findable before a device is touched. |
| [`src/engine/sequence.ts`](src/engine/sequence.ts) | Running a scene — delays, waits, retries, fallbacks. |
| [`src/engine/publisher.ts`](src/engine/publisher.ts) | The semantic state tree, as data an adapter can apply. |
| [`src/main.ts`](src/main.ts) | The adapter: `ObjectSource` and `Effects` over ioBroker, and nothing else. |
| [`docs/architecture/model.md`](docs/architecture/model.md) | What the mapping proved, what it broke, and the two settled decisions. |

`npm run verify` typechecks everything and runs the tests. The mapping compiles
only if the model can represent equipment that actually exists, and the engine
tests run against the value spaces those same adapters really publish — an ATEM
input that routes by `inputId` rather than by its object id, a Blustream C66
whose input ids are zero-padded strings.

Mapped so far: Blackmagic ATEM, Blustream ACM, Blustream MFP, Atlona SW510W,
iiyama ProLite, a Sky box, a Stream Deck and a Samsung TV through two different
adapters — eleven resources and two collections across seven adapter instances,
86 bindings. Every state id was read out of adapter
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
  reporting — stays put.

## What it publishes

Each declared resource becomes a branch of an ordinary ioBroker state tree:

```
control-surface.0.resources.display.lobby.power.on        button, write-only
control-surface.0.resources.display.lobby.power.power     boolean, read-only
control-surface.0.resources.display.lobby.source.select   with common.states
control-surface.0.resources.display.lobby.healthy         boolean, read-only
```

Values are the device's own, with `common.states` carrying the labels, because
that is what every existing ioBroker consumer already reads. The gain is the
addressing: `display.lobby` rather than `iiyama-prolite.0`, and the same shape
whichever adapter answers.

## Building

```bash
npm install
npm run verify    # tsc --noEmit, then the unit tests
npm run build     # build-adapter ts
npm run lint
npm test          # unit + package tests
```

## Licence

MIT.
