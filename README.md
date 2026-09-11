# ioBroker Control Surface

A semantic control and presentation layer for [ioBroker](https://www.iobroker.net/):
existing adapters keep owning their devices, and this sits above them so that
*"show the laptop on the projector"* is expressible without knowing which
protocol answers.

**Status: design stage. There is no adapter here yet — deliberately.**

The name is not settled, and unlike its sibling `ioBroker.showcontrol` it has
had no npm or adapter-catalogue availability check.

## What exists

| Path | What it is |
|---|---|
| [`src/model.ts`](src/model.ts) | The interfaces: Resource, Capability, Action, Feedback, Scene, Surface. |
| [`src/mapping.ts`](src/mapping.ts) | Real adapters expressed against those interfaces — the stress test. |
| [`docs/architecture/model.md`](docs/architecture/model.md) | What the mapping proved, what it broke, and the two open decisions. |

`npm run check` typechecks both. That is the whole test suite, and it is the
point: the mapping compiles only if the model can represent equipment that
actually exists.

## The two decisions blocking implementation

1. **Does TouchBroker provide the surface layer?** Its existing layout schema,
   renderer tiers and fleet agent overlap this project's proposed surface layer
   almost exactly. Settled before the engine is written, because it decides
   whether feedback ships as ioBroker states or a bespoke socket protocol.
2. **Does the resource registry act as the authorization boundary?**
   `ioBroker.showcontrol` holds a config-is-the-whitelist property that runtime
   semantic resolution would discard. Recommendation is to keep it.

Both are argued out in [`docs/architecture/model.md`](docs/architecture/model.md).

## Relationship to the sibling projects

- **`ioBroker.showcontrol`** — stays as it is: an Art-Net/sACN output and cue
  adapter. Under this model it is one of the device adapters being orchestrated,
  not a layer of this one. Its cue runner is prior art for the sequence engine.
- **TouchBroker** — a panel builder and multi-target runtime. See decision 1.

## Licence

MIT.
