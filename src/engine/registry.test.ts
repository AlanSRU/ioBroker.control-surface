/**
 * Registry tests. The whitelist cases are the important ones: they are decision
 * 2 being enforced rather than described.
 */

import assert from "node:assert/strict";

import type { Resource, ResourceCollection } from "../model";
import { Registry } from "./registry";
import { allCollections, allMapped } from "../mapping";

/** The real mapping must load without complaint, or the mapping is wrong. */
it("every mapped resource loads cleanly", () => {
    const { registry, problems } = Registry.load(allMapped, allCollections);
    assert.deepEqual(problems, []);
    assert.equal(registry.allResources().length, allMapped.length);
    assert.ok(registry.getResource("display.lobby"));
    assert.ok(registry.getCollection("atem.sources"));
});

it("the whitelist is exactly the declared bindings", () => {
    const { registry } = Registry.load(allMapped, allCollections);

    assert.ok(registry.permits("iiyama-prolite.0.power"));
    assert.ok(registry.permits("blackmagic-atem.0.recording.start"));

    // The broadcast routes are declared now, on the matrix rather than a receiver.
    assert.ok(registry.permits("blustream-acm.0.system.commands.routeAll"));

    // Never declared by any binding.
    assert.equal(registry.permits("iiyama-prolite.0.somethingElse"), false);
    // A real state on a mapped adapter, deliberately not declared: the ACM has
    // seven route layers (`ROUTE_STATES`) and the mapping declares three. Being
    // on a known device is not the same as being declared.
    assert.equal(registry.permits("blustream-acm.0.receivers.rx3.irRoute"), false);
    // The whole point: an unrelated adapter is unreachable.
    assert.equal(registry.permits("admin.0.info.connection"), false);
});

it("the observation set is wider than the write whitelist", () => {
    const { registry } = Registry.load(allMapped, allCollections);
    const observed = registry.observedStates();

    // Owner connection states are derived, never declared by a binding, and are
    // how health is decided — so they must be subscribed but must not be
    // writable.
    assert.ok(observed.has("atlona-sw510w.0.info.connection"));
    assert.equal(registry.permits("atlona-sw510w.0.info.connection"), false);

    // A jsonList document is the same case: the page menu has to refresh when
    // the layout is re-authored, and nothing here may ever write a layout back.
    assert.ok(observed.has("streamdeck.0.decks.reception.layoutJson"));
    assert.equal(registry.permits("streamdeck.0.decks.reception.layoutJson"), false);

    // Everything writable is also observed.
    for (const state of registry.boundStates()) {
        assert.ok(observed.has(state), `${state} is writable but not observed`);
    }
});

it("a jsonList that names something other than a state id is rejected", () => {
    // The state can never resolve, so it is a configuration fault and belongs
    // with the unknown collection rather than with the runtime conditions.
    const resource: Resource = {
        id: "surface.test",
        type: "surface",
        owner: "streamdeck.0",
        capabilities: [
            {
                id: "navigation",
                actions: [
                    {
                        kind: "select",
                        id: "page",
                        binding: {
                            state: "streamdeck.0.decks.test.currentPageId",
                            values: { kind: "jsonList", state: "layoutJson", path: "pages" },
                        },
                    },
                ],
                feedback: [],
            },
        ],
    };

    const { registry, problems } = Registry.load([resource], []);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.reason, /not a full state id/);
    assert.equal(registry.allResources().length, 0);
});

it("owner connection follows the ioBroker convention", () => {
    const { registry } = Registry.load(allMapped, allCollections);
    assert.equal(registry.ownerConnection("display.lobby"), "iiyama-prolite.0.info.connection");
    assert.equal(registry.ownerConnection("surface.reception"), "streamdeck.0.info.connection");
    assert.equal(registry.ownerConnection("nope"), undefined);
});

it("collection member states are not writable through the whitelist", () => {
    // Members are discovered by pattern and read through ObjectSource. They are
    // sources of values, never targets.
    const { registry } = Registry.load(allMapped, allCollections);
    assert.equal(registry.permits("blustream-acm.0.transmitters.007.id"), false);
});

it("lookups reach actions and feedback by name", () => {
    const { registry } = Registry.load(allMapped, allCollections);

    const on = registry.getAction("display.lobby", "power", "on");
    assert.equal(on?.kind, "set");

    const route = registry.getAction("display.stage", "routing", "video");
    assert.equal(route?.kind, "route");
    assert.equal(route?.kind === "route" ? route.layer : undefined, "video");

    assert.ok(registry.getFeedback("atem.recording", "transport", "status"));
    assert.equal(registry.getAction("display.lobby", "power", "nope"), undefined);
    assert.equal(registry.getFeedback("nope", "power", "power"), undefined);
});

/**
 * Minimal valid resource, for mutating into each invalid case.
 *
 * @param over
 */
function resourceOf(over: Partial<Resource> = {}): Resource {
    return {
        id: "test.thing",
        type: "display",
        owner: "test.0",
        capabilities: [
            {
                id: "power",
                actions: [{ kind: "set", id: "on", binding: { state: "test.0.power" }, value: true }],
                feedback: [{ id: "power", binding: { state: "test.0.power" }, presentation: "boolean" }],
            },
        ],
        ...over,
    };
}

it("a bad declaration is dropped without taking the others down", () => {
    const good = resourceOf({ id: "good.one" });
    const bad = resourceOf({ id: "bad one" });

    const { registry, problems } = Registry.load([good, bad], []);
    assert.ok(registry.getResource("good.one"));
    assert.equal(registry.getResource("bad one"), undefined);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.reason, /would rewrite/);
});

it("semantic ids are rejected when they cannot be object ids", () => {
    // The comma, quote, semicolon, angle brackets and backslash are the ones
    // that matter most: ioBroker rewrites them to _ rather than refusing them,
    // so the control publishes at an id the write map does not hold and the
    // button silently does nothing.
    for (const id of [
        "has space",
        "star*",
        "trailing.",
        ".leading",
        "double..dot",
        "",
        "room1,matrix",
        "display.lobby?",
        "it's",
        'say"what',
        "semi;colon",
        "angle<bracket",
        "back\\slash",
        "square[bracket]",
    ]) {
        const { problems } = Registry.load([resourceOf({ id })], []);
        assert.equal(problems.length, 1, `expected "${id}" to be rejected`);
    }
    // A dot is a tree level, not an error: display.lobby is legitimate.
    assert.deepEqual(Registry.load([resourceOf({ id: "display.lobby" })], []).problems, []);
});

it("duplicate ids are refused", () => {
    const { registry, problems } = Registry.load([resourceOf(), resourceOf()], []);
    assert.equal(registry.allResources().length, 1);
    assert.match(problems[0]!.reason, /duplicate id/);
});

it("a binding to an unknown collection is refused", () => {
    const resource = resourceOf({
        capabilities: [
            {
                id: "routing",
                actions: [
                    {
                        kind: "route",
                        id: "video",
                        binding: { state: "test.0.route", values: { kind: "resourceIds", collection: "nope" } },
                        layer: "video",
                    },
                ],
                feedback: [],
            },
        ],
    });
    const { registry, problems } = Registry.load([resource], []);
    assert.equal(registry.allResources().length, 0);
    assert.match(problems[0]!.reason, /unknown collection "nope"/);
});

it("a semantic id written where a device id belongs is caught", () => {
    const resource = resourceOf({
        capabilities: [
            {
                id: "power",
                // "display.lobby" is a semantic id, not a full foreign state id.
                actions: [{ kind: "set", id: "on", binding: { state: "power" }, value: true }],
                feedback: [],
            },
        ],
    });
    const { problems } = Registry.load([resource], []);
    assert.match(problems[0]!.reason, /not a full state id/);
});

it("an inverted level range is caught", () => {
    const resource = resourceOf({
        capabilities: [
            {
                id: "volume",
                actions: [{ kind: "level", id: "set", binding: { state: "test.0.vol" }, min: 100, max: 0 }],
                feedback: [],
            },
        ],
    });
    const { problems } = Registry.load([resource], []);
    assert.match(problems[0]!.reason, /min >= max/);
});

it("a collection pattern that matches nothing is refused", () => {
    const collection: ResourceCollection = {
        id: "bad.collection",
        type: "video-source",
        owner: "test.0",
        members: "test.0.transmitters",
    };
    const { registry, problems } = Registry.load([], [collection]);
    assert.equal(registry.getCollection("bad.collection"), undefined);
    assert.match(problems[0]!.reason, /without a \*/);
});

it("duplicate actions within a capability are caught", () => {
    const resource = resourceOf({
        capabilities: [
            {
                id: "power",
                actions: [
                    { kind: "set", id: "on", binding: { state: "test.0.power" }, value: true },
                    { kind: "set", id: "on", binding: { state: "test.0.power" }, value: false },
                ],
                feedback: [],
            },
        ],
    });
    const { problems } = Registry.load([resource], []);
    assert.match(problems[0]!.reason, /duplicate action "power.on"/);
});

it("a structurally incomplete declaration is a problem, not a crash", () => {
    // These arrive as hand-written JSON through a textarea with no schema and
    // are cast, not parsed, so every one of them used to throw a TypeError out
    // of onReady — which js-controller answers by restarting the instance with
    // the same configuration, forever.
    const cases: ReadonlyArray<[string, unknown]> = [
        ["not an object", 42],
        ["no capabilities", { id: "a.b", type: "t", owner: "x.0" }],
        ["capabilities not an array", { id: "a.b", type: "t", owner: "x.0", capabilities: {} }],
        [
            "capability with no actions",
            {
                id: "a.b",
                type: "t",
                owner: "x.0",
                capabilities: [{ id: "health", feedback: [] }],
            },
        ],
        [
            "capability with no feedback",
            { id: "a.b", type: "t", owner: "x.0", capabilities: [{ id: "power", actions: [] }] },
        ],
        [
            "action with no binding",
            {
                id: "a.b",
                type: "t",
                owner: "x.0",
                capabilities: [{ id: "power", actions: [{ kind: "set", id: "on" }], feedback: [] }],
            },
        ],
    ];

    for (const [what, declaration] of cases) {
        const { registry, problems } = Registry.load([declaration as Resource], []);
        assert.equal(problems.length, 1, `expected "${what}" to be reported`);
        assert.equal(registry.allResources().length, 0, `expected "${what}" to be dropped`);
    }
});

it("a collection with no members pattern is a problem, not a crash", () => {
    const { registry, problems } = Registry.load([], [{ id: "c", type: "t", owner: "x.0" } as ResourceCollection]);
    assert.equal(problems.length, 1);
    assert.equal(registry.getCollection("c"), undefined);
});

it("a level with no bounds is rejected rather than writing NaN", () => {
    // `undefined >= undefined` is false, so this passed the min/max comparison,
    // published with no min/max, and then quantise returned NaN — which plan
    // reported as a successful write and sent to live equipment as null.
    const resource = resourceOf({
        id: "a.b",
        capabilities: [
            {
                id: "volume",
                actions: [{ kind: "level", id: "set", binding: { state: "x.0.volume" } }],
                feedback: [],
            },
        ],
    } as unknown as Partial<Resource>);

    const { problems } = Registry.load([resource], []);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.reason, /without numeric min and max/);
});

it("an unknown action kind and an unknown presentation are rejected", () => {
    const withKind = resourceOf({
        id: "a.b",
        capabilities: [{ id: "c", actions: [{ kind: "summon", id: "x", binding: { state: "x.0.y" } }], feedback: [] }],
    } as unknown as Partial<Resource>);
    assert.match(Registry.load([withKind], []).problems[0]!.reason, /unknown kind/);

    const withPresentation = resourceOf({
        id: "a.b",
        capabilities: [
            { id: "c", actions: [], feedback: [{ id: "x", binding: { state: "x.0.y" }, presentation: "dial" }] },
        ],
    } as unknown as Partial<Resource>);
    assert.match(Registry.load([withPresentation], []).problems[0]!.reason, /unknown presentation/);
});

it("capability, action and feedback ids are charset-checked like resource ids", () => {
    // They are published as path segments too, so an id ioBroker would rewrite
    // produces a control at one id and a write map keyed to another: the button
    // does nothing, and nothing is logged.
    for (const capabilityId of ["音量", "pre'set", "a,b"]) {
        const resource = resourceOf({
            id: "a.b",
            capabilities: [
                {
                    id: capabilityId,
                    actions: [{ kind: "set", id: "on", binding: { state: "x.0.y" }, value: true }],
                    feedback: [],
                },
            ],
        } as unknown as Partial<Resource>);
        const { problems } = Registry.load([resource], []);
        assert.equal(problems.length, 1, `expected "${capabilityId}" to be rejected`);
    }
});

it("a set with no value and a level with a bad step are rejected", () => {
    // Both reached live equipment: the first as {val: undefined}, which
    // js-controller does not refuse, and the second as NaN out of quantise —
    // and in both cases plan reported the write as a success.
    const noValue = resourceOf({
        id: "a.b",
        capabilities: [
            { id: "power", actions: [{ kind: "set", id: "on", binding: { state: "x.0.y" } }], feedback: [] },
        ],
    } as unknown as Partial<Resource>);
    assert.match(Registry.load([noValue], []).problems[0]!.reason, /set with no value/);

    const badStep = resourceOf({
        id: "a.b",
        capabilities: [
            {
                id: "volume",
                actions: [{ kind: "level", id: "set", binding: { state: "x.0.y" }, min: 0, max: 100, step: "half" }],
                feedback: [],
            },
        ],
    } as unknown as Partial<Resource>);
    assert.match(Registry.load([badStep], []).problems[0]!.reason, /step that is not a positive number/);

    // `false` and `0` are values, not omissions.
    const falseValue = resourceOf({
        id: "a.b",
        capabilities: [
            {
                id: "power",
                actions: [{ kind: "set", id: "off", binding: { state: "x.0.y" }, value: false }],
                feedback: [],
            },
        ],
    } as unknown as Partial<Resource>);
    assert.deepEqual(Registry.load([falseValue], []).problems, []);
});

it("a momentary action may not share an id with a feedback", () => {
    // One object id cannot be both a write-only button and a readable reading.
    // Merging them published the device's value into a boolean button — the
    // regression the momentary guard exists to stop — and dropped the
    // feedback's own state, so the declared reading never appeared at all.
    for (const kind of ["set", "toggle"] as const) {
        const resource = resourceOf({
            id: "a.b",
            capabilities: [
                {
                    id: "preset",
                    actions: [{ kind, id: "preset", binding: { state: "amp.0.preset" }, value: 3 }],
                    feedback: [{ id: "preset", binding: { state: "amp.0.preset" }, presentation: "number" }],
                },
            ],
        } as unknown as Partial<Resource>);

        const { problems } = Registry.load([resource], []);
        assert.equal(problems.length, 1, `expected a ${kind} twin to be rejected`);
        assert.match(problems[0]!.reason, /momentary trigger publishes write-only/);
    }

    // A readable action still merges — routing.video is the route and the
    // reading of it, and that is the whole point of allowing a shared id.
    const readable = resourceOf({
        id: "a.b",
        capabilities: [
            {
                id: "routing",
                actions: [{ kind: "route", id: "video", binding: { state: "acm.0.rx3.videoRoute" }, layer: "video" }],
                feedback: [{ id: "video", binding: { state: "acm.0.rx3.videoRoute" }, presentation: "selection" }],
            },
        ],
    } as unknown as Partial<Resource>);
    assert.deepEqual(Registry.load([readable], []).problems, []);
});

it("an unknown value space kind is rejected rather than crashing the adapter", () => {
    // optionsFor switches on this and every case returns, so an unknown kind
    // fell off the end returning undefined — and every caller reads .ok at
    // once. On a feedback binding that threw inside the first publish() that
    // onReady awaits: nothing published, nothing subscribed, and a restart into
    // the same configuration. Forgetting the word "kind" was enough.
    for (const values of [
        { collection: "atem.sources" },
        { kind: "objectstates" },
        { kind: "resourceId", collection: "atem.sources" },
    ]) {
        const resource = resourceOf({
            id: "a.b",
            capabilities: [
                {
                    id: "source",
                    actions: [],
                    feedback: [{ id: "source", binding: { state: "x.0.y", values }, presentation: "selection" }],
                },
            ],
        } as unknown as Partial<Resource>);

        const { problems } = Registry.load([resource], []);
        assert.equal(problems.length, 1, `expected ${JSON.stringify(values)} to be rejected`);
        assert.match(problems[0]!.reason, /unknown value space kind/);
    }
});

it("a settleMs that is not a duration is rejected", () => {
    // `settleMs > 0` is false for "8s", so the load-time impossible-wait check
    // passed, and `waited - matchedAt >= settleMs` is then a NaN comparison
    // that is never true: every waitFor on that feedback times out while the
    // device is answering correctly.
    const resource = resourceOf({
        id: "a.b",
        capabilities: [
            {
                id: "power",
                actions: [],
                feedback: [{ id: "power", binding: { state: "x.0.y" }, presentation: "boolean", settleMs: "8s" }],
            },
        ],
    } as unknown as Partial<Resource>);

    const { problems } = Registry.load([resource], []);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.reason, /settleMs that/);
});
