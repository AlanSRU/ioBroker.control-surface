/**
 * Feedback engine tests. The unhealthy cases carry the weight: this engine
 * exists so that a control whose device has gone does not look like one showing
 * the truth.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { read, readAll } from "./feedback.ts";
import { Registry } from "./registry.ts";
import { allCollections, allMapped } from "../mapping.ts";
import { NOW, treeOf } from "./testing.ts";

const { registry } = Registry.load(allMapped, allCollections);

/** Owners reporting connected, so health cases can be isolated one at a time. */
const owners = {
    "iiyama-prolite.0.info.connection": true,
    "blustream-acm.0.info.connection": true,
    "blackmagic-atem.0.info.connection": true,
    "streamdeck.0.info.connection": true,
} as const;

test("a healthy boolean reads back as a boolean, not as text", () => {
    const tree = treeOf({ values: { ...owners, "iiyama-prolite.0.power": true } });
    assert.deepEqual(read("display.lobby", "power", "power", registry, tree), {
        resource: "display.lobby",
        capability: "power",
        feedback: "power",
        value: true,
        raw: true,
        healthy: true,
        timestamp: NOW,
    });
});

test("a selection is mapped into the capability's vocabulary", () => {
    const tree = treeOf({
        values: { ...owners, "iiyama-prolite.0.inputSource": 2 },
        meta: { "iiyama-prolite.0.inputSource": { type: "number", states: { "1": "HDMI1", "2": "HDMI2" } } },
    });
    assert.equal(read("display.lobby", "source", "source", registry, tree)?.value, "HDMI2");
});

test("an unmappable value is reported raw rather than dropped", () => {
    // The ACM reports a route of 007 but the transmitter list has not loaded.
    // 007 is still the truth; showing nothing would be wrong.
    const tree = treeOf({ values: { ...owners, "blustream-acm.0.receivers.rx3.videoRoute": "007" } });
    const reading = read("display.stage", "routing", "video", registry, tree);
    assert.equal(reading?.value, "007");
    assert.equal(reading?.healthy, true);
});

test("a missing state is unresolved, with no invented timestamp", () => {
    const reading = read("atem.recording", "transport", "status", registry, treeOf({ values: owners }));
    assert.equal(reading?.value, null);
    assert.equal(reading?.healthy, false);
    assert.equal(reading?.unhealthy, "unresolved");
    assert.equal(reading?.timestamp, 0);
});

test("a state that exists but has never reported is told apart from a missing one", () => {
    const tree = treeOf({
        values: owners,
        states: { "iiyama-prolite.0.power": { val: null, ack: true, ts: 0 } },
    });
    assert.equal(read("display.lobby", "power", "power", registry, tree)?.unhealthy, "never-reported");
});

test("an unacknowledged value is not presented as fact", () => {
    // ack:false is a command someone wrote, not the device reporting.
    const tree = treeOf({
        values: owners,
        states: { "iiyama-prolite.0.power": { val: true, ack: false, ts: NOW } },
    });
    const reading = read("display.lobby", "power", "power", registry, tree);
    assert.equal(reading?.unhealthy, "unacknowledged");
    assert.equal(reading?.healthy, false);
    // The value still comes through: a panel should show it, dimmed.
    assert.equal(reading?.value, true);
});

test("an offline owner outranks the per-state reasons it causes", () => {
    // The adapter being down explains every one of its resources at once, so it
    // is the more useful thing to say than "unacknowledged".
    const tree = treeOf({
        values: { ...owners, "iiyama-prolite.0.info.connection": false },
        states: { "iiyama-prolite.0.power": { val: true, ack: false, ts: NOW } },
    });
    assert.equal(read("display.lobby", "power", "power", registry, tree)?.unhealthy, "owner-offline");
});

test("an adapter publishing no info.connection reads as healthy, not as offline", () => {
    // Marking every resource of such an adapter unhealthy for following a
    // different convention would be worse than assuming nothing.
    const tree = treeOf({ values: { "iiyama-prolite.0.power": true } });
    assert.equal(read("display.lobby", "power", "power", registry, tree)?.healthy, true);
});

test("health is an ordinary capability, read through the same path", () => {
    const tree = treeOf({ values: { ...owners, "iiyama-prolite.0.info.connection": true } });
    assert.equal(read("display.lobby", "health", "online", registry, tree)?.value, true);
});

test("an undeclared feedback returns nothing", () => {
    assert.equal(read("display.lobby", "power", "nope", registry, treeOf({})), undefined);
    assert.equal(read("nope", "power", "power", registry, treeOf({})), undefined);
});

test("readAll covers every declared feedback and skips none", () => {
    const declared = registry
        .allResources()
        .flatMap(r => r.capabilities.flatMap(c => c.feedback.map(f => `${r.id}.${c.id}.${f.id}`)));

    const readings = readAll(registry, treeOf({}));
    assert.equal(readings.length, declared.length);
    assert.deepEqual(
        readings.map(r => `${r.resource}.${r.capability}.${r.feedback}`).sort(),
        [...declared].sort(),
    );
});

test("readAll reports an empty tree as unresolved rather than omitting it", () => {
    // A control whose device has gone still needs publishing, or a panel cannot
    // tell "gone" from "never existed".
    const readings = readAll(registry, treeOf({}));
    assert.ok(readings.length > 0);
    assert.ok(readings.every(r => !r.healthy && r.unhealthy === "unresolved"));
});

test("a broadcast route declares no feedback to read", () => {
    // Nothing to bind to: what a broadcast changes is every receiver's own
    // route, so the matrix has no readable counterpart of its own.
    const matrix = registry.getResource("room1.matrix");
    const routing = matrix?.capabilities.find(c => c.id === "routing");
    assert.deepEqual(routing?.feedback, []);
    assert.equal(readAll(registry, treeOf({})).some(r => r.resource === "room1.matrix"), false);
});

test("a one-way remote contributes no readings at all", () => {
    // sky-remote is write-only; every button is read:false.
    assert.equal(readAll(registry, treeOf({})).some(r => r.resource === "lounge.skybox"), false);
});
