/**
 * Resolver tests. Every case is taken from equipment in `mapping.ts`, with the
 * object metadata as the adapter actually publishes it — the point is that the
 * resolver handles real value spaces, not tidy ones.
 */

import assert from "node:assert/strict";

import type { Options, ValueOption } from "./resolver";
import { optionsFor, toDevice, toSemantic } from "./resolver";
import { treeOf } from "./testing";
import { Registry } from "./registry";
import { acmTransmitters, atemInputs } from "../mapping";

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

it("identity space passes values straight through", () => {
    const binding = { state: "iiyama-prolite.0.volume.main" };
    assert.deepEqual(optionsFor(binding, collections, treeOf({})), { ok: true, options: [] });
    assert.equal(toDevice(binding, 42, collections, treeOf({})), 42);
});

it("objectStates on a number state yields numeric values", () => {
    // iiyama publishes inputSource as a number with common.states.
    const binding = { state: "iiyama-prolite.0.inputSource", values: { kind: "objectStates" } } as const;
    const tree = treeOf({
        meta: { "iiyama-prolite.0.inputSource": { type: "number", states: { 1: "HDMI1", 2: "HDMI2" } } },
    });

    assert.deepEqual(optionsOf(optionsFor(binding, collections, tree)), [
        { name: "HDMI1", value: 1 },
        { name: "HDMI2", value: 2 },
    ]);
    assert.equal(toDevice(binding, "HDMI2", collections, tree), 2);
    assert.equal(toSemantic(binding, 2, collections, tree), "HDMI2");
});

it("objectStates on a string state keeps zero-padded keys as strings", () => {
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

it("an absent object is unresolved, not an error", () => {
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

it("ATEM inputs route by inputId, not by the object id segment", () => {
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

it("ACM transmitters keep their zero-padded ids", () => {
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

it("a member with no name falls back to its value", () => {
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

it("a collection whose members are not in the tree yet is unresolved", () => {
    const binding = {
        state: "blackmagic-atem.0.me0.programInput",
        values: { kind: "resourceIds", collection: "atem.sources" },
    } as const;
    const resolved = optionsFor(binding, collections, treeOf({}));
    assert.deepEqual(resolved, { ok: false, reason: "no-members", collection: "atem.sources" });
});

it("a device value is accepted in place of its semantic name", () => {
    const binding = { state: "iiyama-prolite.0.inputSource", values: { kind: "objectStates" } } as const;
    const tree = treeOf({
        meta: { "iiyama-prolite.0.inputSource": { type: "number", states: { 1: "HDMI1" } } },
    });
    assert.equal(toDevice(binding, 1, collections, tree), 1);
});

it("a value outside the space is refused rather than written", () => {
    const binding = { state: "iiyama-prolite.0.inputSource", values: { kind: "objectStates" } } as const;
    const tree = treeOf({
        meta: { "iiyama-prolite.0.inputSource": { type: "number", states: { 1: "HDMI1" } } },
    });
    assert.equal(toDevice(binding, "SCART", collections, tree), undefined);
    assert.equal(toSemantic(binding, 9, collections, tree), undefined);
});

it("an explicit table needs no object tree at all", () => {
    const binding = {
        state: "some-adapter.0.mode",
        values: {
            kind: "table",
            entries: [
                { name: "Show", value: 1 },
                { name: "Rehearse", value: 2 },
            ],
        },
    } as const;
    assert.equal(toDevice(binding, "Rehearse", collections, treeOf({})), 2);
    assert.equal(toSemantic(binding, 1, collections, treeOf({})), "Show");
});

// ---------------------------------------------------------------------------
// jsonList — the list is inside a state, not in the object tree
// ---------------------------------------------------------------------------

/** The deck's page menu, exactly as `surface.reception` declares it. */
const pages = {
    kind: "jsonList",
    state: "streamdeck.0.decks.reception.layoutJson",
    path: "pages",
    valueKey: "id",
    nameKey: "name",
} as const;

const navigation = { state: "streamdeck.0.decks.reception.currentPageId", values: pages } as const;

/**
 * A deck layout in the shape `streamdeck-types.ts` defines, trimmed to the
 * fields this layer reads. The extra keys are kept deliberately: the resolver
 * has to walk past them rather than assume a tidy document.
 *
 * @param layout - Layout fields to publish
 * @returns A tree with that layout in `layoutJson`
 */
function deckWith(layout: unknown): ReturnType<typeof treeOf> {
    return treeOf({ values: { "streamdeck.0.decks.reception.layoutJson": JSON.stringify(layout) } });
}

const receptionLayout = {
    version: 1,
    defaultPageId: "home",
    model: "streamdeck-xl",
    pages: [
        { id: "home", name: "Home", mode: "mixed", buttons: [] },
        { id: "presentation", name: "Presentation", mode: "direct", buttons: [] },
    ],
};

it("a page list is read out of the deck's layout document", () => {
    // The pages a currentPageId will accept exist nowhere as objects, which is
    // the whole reason this form exists.
    const tree = deckWith(receptionLayout);

    assert.deepEqual(optionsOf(optionsFor(navigation, collections, tree)), [
        { name: "Home", value: "home" },
        { name: "Presentation", value: "presentation" },
    ]);
    assert.equal(toDevice(navigation, "Presentation", collections, tree), "presentation");
    assert.equal(toSemantic(navigation, "presentation", collections, tree), "Presentation");
});

it("a bare array of scalars needs no path and no keys", () => {
    // ATEM publishes tally.programInputs as `role: 'json'` holding [1, 3].
    const binding = {
        state: "blackmagic-atem.0.tally.programInputs",
        values: { kind: "jsonList", state: "blackmagic-atem.0.tally.programInputs" },
    } as const;
    const tree = treeOf({ values: { "blackmagic-atem.0.tally.programInputs": "[1,3]" } });

    assert.deepEqual(optionsOf(optionsFor(binding, collections, tree)), [
        { name: "1", value: 1 },
        { name: "3", value: 3 },
    ]);
    // JSON carries its own types, so no coercion decision arises: 1 stays a
    // number without anything having to consult common.type.
    assert.equal(toDevice(binding, 3, collections, tree), 3);
});

it("an empty layout is unresolved rather than an empty menu", () => {
    // streamdeck declares layoutJson with `def: ""`, so an unconfigured deck
    // reaches here as the empty string.
    const tree = treeOf({ values: { "streamdeck.0.decks.reception.layoutJson": "" } });
    assert.deepEqual(optionsFor(navigation, collections, tree), {
        ok: false,
        reason: "no-json-list",
        state: "streamdeck.0.decks.reception.layoutJson",
    });
});

it("a half-written document is unresolved, not an error", () => {
    // layoutJson is writable and the React editor saves whole documents, so a
    // value that does not parse is a moment, not a fault.
    const tree = treeOf({ values: { "streamdeck.0.decks.reception.layoutJson": '{"pages":[' } });
    assert.equal(optionsFor(navigation, collections, tree).ok, false);
});

it("a path that leads somewhere other than an array is unresolved", () => {
    assert.equal(optionsFor(navigation, collections, deckWith({ version: 1 })).ok, false);
    assert.equal(optionsFor(navigation, collections, deckWith({ pages: { home: {} } })).ok, false);
});

it("an element carrying no usable value is dropped, not invented", () => {
    // Offering an option the device would refuse is worse than offering fewer.
    const tree = deckWith({ pages: [{ name: "Nameless, and with no id" }, { id: "home", name: "Home" }] });
    assert.deepEqual(optionsOf(optionsFor(navigation, collections, tree)), [{ name: "Home", value: "home" }]);
});

it("a page with no name is offered under its id", () => {
    const tree = deckWith({ pages: [{ id: "home" }, { id: "away", name: "" }] });
    assert.deepEqual(optionsOf(optionsFor(navigation, collections, tree)), [
        { name: "home", value: "home" },
        { name: "away", value: "away" },
    ]);
});
