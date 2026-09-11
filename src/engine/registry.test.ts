/**
 * Registry tests. The whitelist cases are the important ones: they are decision
 * 2 being enforced rather than described.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Resource, ResourceCollection } from "../model.ts";
import { Registry } from "./registry.ts";
import { allCollections, allMapped } from "../mapping.ts";

/** The real mapping must load without complaint, or the mapping is wrong. */
test("every mapped resource loads cleanly", () => {
    const { registry, problems } = Registry.load(allMapped, allCollections);
    assert.deepEqual(problems, []);
    assert.equal(registry.allResources().length, allMapped.length);
    assert.ok(registry.getResource("display.lobby"));
    assert.ok(registry.getCollection("atem.sources"));
});

test("the whitelist is exactly the declared bindings", () => {
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

test("collection member states are not writable through the whitelist", () => {
    // Members are discovered by pattern and read through ObjectSource. They are
    // sources of values, never targets.
    const { registry } = Registry.load(allMapped, allCollections);
    assert.equal(registry.permits("blustream-acm.0.transmitters.007.id"), false);
});

test("lookups reach actions and feedback by name", () => {
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

/** Minimal valid resource, for mutating into each invalid case. */
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

test("a bad declaration is dropped without taking the others down", () => {
    const good = resourceOf({ id: "good.one" });
    const bad = resourceOf({ id: "bad one" });

    const { registry, problems } = Registry.load([good, bad], []);
    assert.ok(registry.getResource("good.one"));
    assert.equal(registry.getResource("bad one"), undefined);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.reason, /may not contain/);
});

test("semantic ids are rejected when they cannot be object ids", () => {
    for (const id of ["has space", "star*", "trailing.", ".leading", "double..dot", ""]) {
        const { problems } = Registry.load([resourceOf({ id })], []);
        assert.equal(problems.length, 1, `expected "${id}" to be rejected`);
    }
    // A dot is a tree level, not an error: display.lobby is legitimate.
    assert.deepEqual(Registry.load([resourceOf({ id: "display.lobby" })], []).problems, []);
});

test("duplicate ids are refused", () => {
    const { registry, problems } = Registry.load([resourceOf(), resourceOf()], []);
    assert.equal(registry.allResources().length, 1);
    assert.match(problems[0]!.reason, /duplicate id/);
});

test("a binding to an unknown collection is refused", () => {
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

test("a semantic id written where a device id belongs is caught", () => {
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

test("an inverted level range is caught", () => {
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

test("a collection pattern that matches nothing is refused", () => {
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

test("duplicate actions within a capability are caught", () => {
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
