/**
 * Action engine tests, driven from the real mapping rather than fixtures. The
 * refusal cases matter as much as the successes: this writes to live equipment,
 * so "did nothing, and said why" has to be a first-class outcome.
 */

import assert from "node:assert/strict";

import type { ActionInvocation, StateValue } from "../model";
import type { Plan, StateWrite } from "./actions";
import { plan } from "./actions";
import { Registry } from "./registry";
import { allCollections, allMapped } from "../mapping";
import { treeOf } from "./testing";

const { registry } = Registry.load(allMapped, allCollections);

const empty = treeOf({});

/** The ACM transmitter list, as the adapter publishes it. */
const acmTree = treeOf({
    members: { "blustream-acm.0.transmitters.*": ["blustream-acm.0.transmitters.007"] },
    values: {
        "blustream-acm.0.transmitters.007.id": "007",
        "blustream-acm.0.transmitters.007.name": "Laptop",
    },
});

/**
 * Asserts an invocation planned, and returns its writes.
 *
 * @param result - Result of `plan`
 * @returns The planned writes
 */
function writesOf(result: Plan): ReadonlyArray<StateWrite> {
    if (!result.ok) {
        assert.fail(`expected a plan, got ${JSON.stringify(result)}`);
    }
    return result.writes;
}

/**
 * Builds an invocation.
 *
 * @param resource - Semantic resource id
 * @param capability - Capability id
 * @param action - Action id
 * @param value - Value to supply, if any
 * @returns The invocation
 */
function invoke(resource: string, capability: string, action: string, value?: StateValue): ActionInvocation {
    return value === undefined ? { resource, capability, action } : { resource, capability, action, value };
}

it("a set action writes its declared value, unacknowledged", () => {
    const writes = writesOf(plan(invoke("display.lobby", "power", "on"), registry, empty));
    assert.deepEqual(writes, [{ state: "iiyama-prolite.0.power", value: true, ack: false }]);
});

it("every write is unacknowledged", () => {
    // An acked write is read as the device reporting, and adapters ignore it as
    // a command. This must hold for every action kind, not just by convention.
    const cases: ReadonlyArray<ActionInvocation> = [
        invoke("display.lobby", "power", "on"),
        invoke("display.lobby", "volume", "set", 40),
        invoke("atem.recording", "transport", "start"),
    ];
    for (const c of cases) {
        for (const write of writesOf(plan(c, registry, empty))) {
            assert.equal(write.ack, false);
        }
    }
});

it("a set action ignores a redundant supplied value", () => {
    const writes = writesOf(plan(invoke("display.lobby", "power", "off", true), registry, empty));
    assert.deepEqual(writes, [{ state: "iiyama-prolite.0.power", value: false, ack: false }]);
});

it("a write-only ATEM transport button plans without any feedback state", () => {
    // recording.start is read:false; the observable truth is recording.status.
    const writes = writesOf(plan(invoke("atem.recording", "transport", "start"), registry, empty));
    assert.deepEqual(writes, [{ state: "blackmagic-atem.0.recording.start", value: true, ack: false }]);
});

it("toggle inverts the current value", () => {
    const tree = treeOf({ values: { "iiyama-prolite.0.power": true } });
    const writes = writesOf(plan(invoke("display.lobby", "power", "toggle"), registry, tree));
    assert.deepEqual(writes, [{ state: "iiyama-prolite.0.power", value: false, ack: false }]);
});

it("toggle refuses rather than guesses when nothing has reported", () => {
    // Guessing would be a coin flip that switches equipment during a show.
    const result = plan(invoke("display.lobby", "power", "toggle"), registry, empty);
    assert.deepEqual(result, { ok: false, reason: "unresolved", state: "iiyama-prolite.0.power" });
});

it("a level is clamped to the declared range", () => {
    const at = (v: number): StateValue =>
        writesOf(plan(invoke("display.lobby", "volume", "set", v), registry, empty))[0]!.value;
    assert.equal(at(40), 40);
    assert.equal(at(500), 100);
    assert.equal(at(-20), 0);
});

it("a level is quantised onto its step", () => {
    // The iiyama volume declares step 1, so fractions land on whole numbers.
    const writes = writesOf(plan(invoke("display.lobby", "volume", "set", 40.4), registry, empty));
    assert.equal(writes[0]!.value, 40);
});

it("a level with no step keeps fractional values", () => {
    // brightness declares min/max but no step.
    const writes = writesOf(plan(invoke("display.lobby", "brightness", "set", 42.5), registry, empty));
    assert.equal(writes[0]!.value, 42.5);
});

it("a level refuses a non-numeric value", () => {
    assert.deepEqual(plan(invoke("display.lobby", "volume", "set", "loud"), registry, empty), {
        ok: false,
        reason: "not-numeric",
        value: "loud",
    });
});

it("a level with no value refuses rather than defaulting", () => {
    assert.deepEqual(plan(invoke("display.lobby", "volume", "set"), registry, empty), {
        ok: false,
        reason: "value-required",
    });
});

it("a route resolves a source name to the device's own id", () => {
    const writes = writesOf(plan(invoke("display.stage", "routing", "video", "Laptop"), registry, acmTree));
    assert.deepEqual(writes, [{ state: "blustream-acm.0.receivers.rx3.videoRoute", value: "007", ack: false }]);
});

it("a broadcast route writes the matrix's own state, not a receiver's", () => {
    // RouteScope "all": one command instead of one per receiver, which at the
    // ACM's 500ms inter-command delay is five seconds saved on ten displays.
    const writes = writesOf(plan(invoke("room1.matrix", "routing", "allVideo", "Laptop"), registry, acmTree));
    assert.deepEqual(writes, [{ state: "blustream-acm.0.system.commands.routeAllVideo", value: "007", ack: false }]);
});

it("a route refuses a source that is not in the value space", () => {
    assert.deepEqual(plan(invoke("display.stage", "routing", "video", "Nonexistent"), registry, acmTree), {
        ok: false,
        reason: "value-rejected",
        value: "Nonexistent",
    });
});

it("an unresolvable value space is reported as unresolved, not as a bad value", () => {
    // The operator should not be sent hunting for a typo when the adapter is
    // simply down. Same invocation as above, but with an empty object tree.
    assert.deepEqual(plan(invoke("display.stage", "routing", "video", "Laptop"), registry, empty), {
        ok: false,
        reason: "unresolved",
        state: "blustream-acm.0.receivers.rx3.videoRoute",
    });
});

it("unknown resources, capabilities and actions are told apart", () => {
    assert.deepEqual(plan(invoke("nope", "power", "on"), registry, empty), {
        ok: false,
        reason: "unknown-resource",
        resource: "nope",
    });
    assert.deepEqual(plan(invoke("display.lobby", "nope", "on"), registry, empty), {
        ok: false,
        reason: "unknown-capability",
        capability: "nope",
    });
    assert.deepEqual(plan(invoke("display.lobby", "power", "nope"), registry, empty), {
        ok: false,
        reason: "unknown-action",
        action: "nope",
    });
});

it("a sky-remote button plans even though nothing can ever read it back", () => {
    // One-way IR/IP control: the capability has no feedback at all.
    const writes = writesOf(plan(invoke("lounge.skybox", "navigation", "up"), registry, empty));
    assert.deepEqual(writes, [{ state: "sky-remote.0.buttons.up", value: true, ack: false }]);
});

it("navigating a surface is an ordinary action", () => {
    // A Stream Deck page change goes through the same path as a projector
    // input; there is no surface-specific branch anywhere.
    const writes = writesOf(plan(invoke("surface.reception", "navigation", "page", "matchday"), registry, empty));
    assert.deepEqual(writes, [{ state: "streamdeck.0.decks.reception.currentPageId", value: "matchday", ack: false }]);
});

it("planning never writes to an undeclared state", () => {
    // The whitelist property, asserted over every action the mapping declares.
    for (const resource of registry.allResources()) {
        for (const capability of resource.capabilities) {
            for (const action of capability.actions) {
                const result = plan(invoke(resource.id, capability.id, action.id, "Laptop"), registry, acmTree);
                if (result.ok) {
                    for (const write of result.writes) {
                        assert.ok(
                            registry.permits(write.state),
                            `${resource.id}.${capability.id}.${action.id} planned an undeclared write to ${write.state}`,
                        );
                    }
                }
            }
        }
    }
});
