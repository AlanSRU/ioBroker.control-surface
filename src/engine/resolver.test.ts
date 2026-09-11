/**
 * Resolver tests. Every case is taken from equipment in `mapping.ts`, with the
 * object metadata as the adapter actually publishes it — the point is that the
 * resolver handles real value spaces, not tidy ones.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { ObjectSource, Options, StateMeta, StateValue, ValueOption } from "./resolver.ts";
import { optionsFor, toDevice, toSemantic } from "./resolver.ts";
import { Registry } from "./registry.ts";
import { acmTransmitters, atemInputs } from "../mapping.ts";

/** An object tree stubbed from literals, so tests state their own fixtures. */
function treeOf(opts: {
    meta?: Record<string, StateMeta>;
    members?: Record<string, string[]>;
    values?: Record<string, StateValue>;
}): ObjectSource {
    return {
        metaOf: id => opts.meta?.[id],
        membersOf: pattern => opts.members?.[pattern],
        valueOf: id => opts.values?.[id],
    };
}

const collections = Registry.load([], [acmTransmitters, atemInputs]).registry;

/**
 * Asserts a value space resolved, and narrows it so the options are reachable.
 *
 * @param resolved - Result of `optionsFor`
 * @returns The resolved options
 */
function optionsOf(resolved: Options): ReadonlyArray<ValueOption> {
    if (!resolved.ok) {
        assert.fail(`expected resolved options, got ${JSON.stringify(resolved)}`);
    }
    return resolved.options;
}

test("identity space passes values straight through", () => {
    const binding = { state: "iiyama-prolite.0.volume.main" };
    assert.deepEqual(optionsFor(binding, collections, treeOf({})), { ok: true, options: [] });
    assert.equal(toDevice(binding, 42, collections, treeOf({})), 42);
});

test("objectStates on a number state yields numeric values", () => {
    // iiyama publishes inputSource as a number with common.states.
    const binding = { state: "iiyama-prolite.0.inputSource", values: { kind: "objectStates" } } as const;
    const tree = treeOf({
        meta: { "iiyama-prolite.0.inputSource": { type: "number", states: { "1": "HDMI1", "2": "HDMI2" } } },
    });

    assert.deepEqual(optionsOf(optionsFor(binding, collections, tree)), [
        { name: "HDMI1", value: 1 },
        { name: "HDMI2", value: 2 },
    ]);
    assert.equal(toDevice(binding, "HDMI2", collections, tree), 2);
    assert.equal(toSemantic(binding, 2, collections, tree), "HDMI2");
});

test("objectStates on a string state keeps zero-padded keys as strings", () => {
    // Blustream C66: output.<N>.source is a *string* state. Reading "01" as the
    // number 1 sends a value the device rejects.
    const binding = { state: "blustream-mfp.1.output.1.source", values: { kind: "objectStates" } } as const;
    const tree = treeOf({
        meta: {
            "blustream-mfp.1.output.1.source": {
                type: "string",
                states: { "01": "HDMI 1", "06": "HDMI 6" },
            },
        },
    });

    assert.deepEqual(optionsOf(optionsFor(binding, collections, tree)), [
        { name: "HDMI 1", value: "01" },
        { name: "HDMI 6", value: "06" },
    ]);
    assert.equal(toDevice(binding, "HDMI 6", collections, tree), "06");
});

test("an absent object is unresolved, not an error", () => {
    // blackmagic-atem rebuilds its tree from the detected model, so a bound
    // state may not exist yet or may vanish on reconnect.
    const binding = { state: "blackmagic-atem.0.recording.status", values: { kind: "objectStates" } } as const;
    const resolved = optionsFor(binding, collections, treeOf({}));
    assert.equal(resolved.ok, false);
    assert.deepEqual(resolved, {
        ok: false,
        reason: "no-object-states",
        state: "blackmagic-atem.0.recording.status",
    });
    assert.equal(toDevice(binding, "recording", collections, treeOf({})), undefined);
});

test("ATEM inputs route by inputId, not by the object id segment", () => {
    // The member is `inputs.input3`, but me0.programInput takes the number 3.
    const binding = {
        state: "blackmagic-atem.0.me0.programInput",
        values: { kind: "resourceIds", collection: "atem.sources" },
    } as const;
    const tree = treeOf({
        members: { "blackmagic-atem.0.inputs.input*": ["blackmagic-atem.0.inputs.input3"] },
        values: {
            "blackmagic-atem.0.inputs.input3.inputId": 3,
            "blackmagic-atem.0.inputs.input3.longName": "Camera 3",
        },
    });

    assert.deepEqual(optionsOf(optionsFor(binding, collections, tree)), [{ name: "Camera 3", value: 3 }]);
    assert.equal(toDevice(binding, "Camera 3", collections, tree), 3);
});

test("ACM transmitters keep their zero-padded ids", () => {
    const binding = {
        state: "blustream-acm.0.receivers.rx3.videoRoute",
        values: { kind: "resourceIds", collection: "room1.sources" },
    } as const;
    const tree = treeOf({
        members: { "blustream-acm.0.transmitters.*": ["blustream-acm.0.transmitters.007"] },
        values: {
            "blustream-acm.0.transmitters.007.id": "007",
            "blustream-acm.0.transmitters.007.name": "Laptop",
        },
    });

    assert.deepEqual(optionsOf(optionsFor(binding, collections, tree)), [{ name: "Laptop", value: "007" }]);
    assert.equal(toDevice(binding, "Laptop", collections, tree), "007");
});

test("a member with no name falls back to its value", () => {
    const binding = {
        state: "blustream-acm.0.receivers.rx3.videoRoute",
        values: { kind: "resourceIds", collection: "room1.sources" },
    } as const;
    const tree = treeOf({
        members: { "blustream-acm.0.transmitters.*": ["blustream-acm.0.transmitters.007"] },
        values: { "blustream-acm.0.transmitters.007.id": "007" },
    });

    assert.deepEqual(optionsOf(optionsFor(binding, collections, tree)), [{ name: "007", value: "007" }]);
});

test("a collection whose members are not in the tree yet is unresolved", () => {
    const binding = {
        state: "blackmagic-atem.0.me0.programInput",
        values: { kind: "resourceIds", collection: "atem.sources" },
    } as const;
    const resolved = optionsFor(binding, collections, treeOf({}));
    assert.deepEqual(resolved, { ok: false, reason: "no-members", collection: "atem.sources" });
});

test("a device value is accepted in place of its semantic name", () => {
    const binding = { state: "iiyama-prolite.0.inputSource", values: { kind: "objectStates" } } as const;
    const tree = treeOf({
        meta: { "iiyama-prolite.0.inputSource": { type: "number", states: { "1": "HDMI1" } } },
    });
    assert.equal(toDevice(binding, 1, collections, tree), 1);
});

test("a value outside the space is refused rather than written", () => {
    const binding = { state: "iiyama-prolite.0.inputSource", values: { kind: "objectStates" } } as const;
    const tree = treeOf({
        meta: { "iiyama-prolite.0.inputSource": { type: "number", states: { "1": "HDMI1" } } },
    });
    assert.equal(toDevice(binding, "SCART", collections, tree), undefined);
    assert.equal(toSemantic(binding, 9, collections, tree), undefined);
});

test("an explicit table needs no object tree at all", () => {
    const binding = {
        state: "some-adapter.0.mode",
        values: { kind: "table", entries: [{ name: "Show", value: 1 }, { name: "Rehearse", value: 2 }] },
    } as const;
    assert.equal(toDevice(binding, "Rehearse", collections, treeOf({})), 2);
    assert.equal(toSemantic(binding, 1, collections, treeOf({})), "Show");
});
