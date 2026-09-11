/**
 * Publisher tests.
 *
 * Several of these encode constraints repochecker enforces rather than
 * preferences — an invented role is E1008, a write-only `level` is E1010, and a
 * state whose parent objects were never created is E3009. They are cheap to
 * satisfy here and expensive to discover against a live object dump.
 */

import assert from "node:assert/strict";

import { Registry } from "./registry";
import type { PublishedObject } from "./publisher";
import { objectsFor, ROOT, statesFor, writeTargets } from "./publisher";
import { allCollections, allMapped } from "../mapping";
import { treeOf } from "./testing";

const { registry } = Registry.load(allMapped, allCollections);
const empty = treeOf({});

const acmTree = treeOf({
    values: {
        "blustream-acm.0.info.connection": true,
        "blustream-acm.0.transmitters.007.id": "007",
        "blustream-acm.0.transmitters.007.name": "Laptop",
        "blustream-acm.0.receivers.rx3.videoRoute": "007",
    },
    members: { "blustream-acm.0.transmitters.*": ["blustream-acm.0.transmitters.007"] },
});

/**
 * Finds one published object.
 *
 * @param id - Published id
 * @param objects - Objects to search
 * @returns The object
 */
function objectAt(id: string, objects = objectsFor(registry, empty)): PublishedObject {
    const found = objects.find(o => o.id === id);
    assert.ok(found, `no published object at ${id}`);
    return found;
}

it("every state has its parent objects published, and parents come first", () => {
    // E3009: ioBroker tolerates an orphan state at runtime, so nothing looks
    // wrong until the adapter is reviewed against a live dump.
    const objects = objectsFor(registry, empty);
    const seen = new Set<string>();

    for (const object of objects) {
        const parent = object.id.slice(0, object.id.lastIndexOf("."));
        if (parent !== "" && object.id !== ROOT) {
            assert.ok(seen.has(parent), `${object.id} is published before its parent ${parent}`);
        }
        seen.add(object.id);
    }
});

it("a dotted resource id becomes tree levels, not one flat segment", () => {
    assert.equal(objectAt(`${ROOT}.display`).type, "folder");
    assert.equal(objectAt(`${ROOT}.display.lobby`).type, "device");
    assert.equal(objectAt(`${ROOT}.display.lobby.power`).type, "channel");
});

it("a momentary action publishes as a write-only button", () => {
    // `power.on` means "do the on thing", never "are you on".
    const on = objectAt(`${ROOT}.display.lobby.power.on`).common;
    assert.deepEqual(on, { name: "on", type: "boolean", role: "button", read: false, write: true });

    // Same for toggle, and for a one-way remote with no readable state at all.
    assert.equal(objectAt(`${ROOT}.display.lobby.power.toggle`).common.role, "button");
    assert.equal(objectAt(`${ROOT}.lounge.skybox.navigation.up`).common.role, "button");
});

it("a level publishes readable, because role level requires it", () => {
    // A write-only `level` fails E1010.
    const volume = objectAt(`${ROOT}.display.lobby.volume.set`).common;
    assert.equal(volume.role, "level");
    assert.equal(volume.read, true);
    assert.equal(volume.write, true);
    assert.equal(volume.min, 0);
    assert.equal(volume.max, 100);
    assert.equal(volume.step, 1);
});

it("a level with no declared step publishes none", () => {
    assert.equal("step" in objectAt(`${ROOT}.display.lobby.brightness.set`).common, false);
});

it("read-only feedback never uses a writable role", () => {
    // `value` is read-only and `level` is writable; swapping them fails E1010.
    const objects = objectsFor(registry, acmTree);
    for (const object of objects) {
        if (object.type !== "state" || object.common.write !== false) {
            continue;
        }
        assert.notEqual(object.common.role, "level", `${object.id} is read-only but uses a writable role`);
        if (object.common.type === "number") {
            assert.equal(object.common.role, "value", `${object.id}`);
        }
        if (object.common.type === "boolean") {
            assert.equal(object.common.role, "indicator", `${object.id}`);
        }
    }
});

it("only roles ioBroker actually defines are published", () => {
    // E1008 rejects invented roles.
    const allowed = new Set(["button", "level", "text", "value", "indicator"]);
    for (const object of objectsFor(registry, acmTree)) {
        if (object.type === "state") {
            assert.ok(allowed.has(object.common.role!), `${object.id} publishes role "${object.common.role}"`);
        }
    }
});

it("a value space becomes common.states, keyed by the device value", () => {
    // `{"007": "Laptop"}` is the idiom every existing consumer reads, including
    // TouchBroker's map:{fromStates:true}.
    const route = objectAt(`${ROOT}.display.stage.routing.video`, objectsFor(registry, acmTree)).common;
    assert.deepEqual(route.states, { "007": "Laptop" });
    assert.equal(route.type, "string");
    assert.equal(route.role, "text");
});

it("zero-padded string ids publish as strings, not numbers", () => {
    // The Blustream C66 trap, reached by a second route. Its output.<N>.source
    // is a string state whose states are {"01": "HDMI 1", ...}; publishing
    // type number would send 1 for "01" and the device would reject it.
    const tree = treeOf({
        values: { "blustream-mfp.0.output.1.audioSource": "01" },
        meta: {
            "blustream-mfp.0.output.1.audioSource": {
                type: "string",
                states: { "01": "HDMI 1", "06": "HDMI 6" },
            },
        },
    });
    const audio = objectAt(`${ROOT}.room1.projector-feed.routing.audio`, objectsFor(registry, tree)).common;
    assert.equal(audio.type, "string");
    assert.deepEqual(audio.states, { "01": "HDMI 1", "06": "HDMI 6" });
});

it("a genuinely numeric value space still publishes as a number", () => {
    const tree = treeOf({
        members: { "blackmagic-atem.0.inputs.input*": ["blackmagic-atem.0.inputs.input3"] },
        values: {
            "blackmagic-atem.0.inputs.input3.inputId": 3,
            "blackmagic-atem.0.inputs.input3.longName": "Camera 3",
        },
    });
    const program = objectAt(`${ROOT}.atem.me1.program.source.select`, objectsFor(registry, tree)).common;
    assert.equal(program.type, "number");
    assert.equal(program.role, "level", "a writable number is level, never value");
    assert.deepEqual(program.states, { 3: "Camera 3" });
});

it("an unresolved value space publishes no options rather than an empty list", () => {
    // A selector with no options is a broken control; one with none declared is
    // a control whose list has not arrived.
    assert.equal("states" in objectAt(`${ROOT}.display.stage.routing.video`).common, false);
});

it("an action and a feedback sharing an id publish as one read/write state", () => {
    const objects = objectsFor(registry, acmTree);
    const matching = objects.filter(o => o.id === `${ROOT}.display.stage.routing.video`);
    assert.equal(matching.length, 1, "published twice");
    assert.equal(matching[0]!.common.read, true);
    assert.equal(matching[0]!.common.write, true);
});

it("every resource publishes an aggregate health state", () => {
    const healthy = objectAt(`${ROOT}.display.lobby.healthy`).common;
    assert.deepEqual(
        { type: healthy.type, role: healthy.role, read: healthy.read, write: healthy.write },
        { type: "boolean", role: "indicator", read: true, write: false },
    );
});

it("published values are raw device values, and always acknowledged", () => {
    const states = statesFor(registry, acmTree);
    const route = states.find(s => s.id === `${ROOT}.display.stage.routing.video`);
    // Raw, not the "Laptop" label: the label lives in common.states.
    assert.equal(route?.val, "007");
    assert.ok(
        states.every(s => s.ack === true),
        "this layer reports, it does not command",
    );
});

it("an unresolved binding publishes a quality code, not a silent null", () => {
    const states = statesFor(registry, empty);
    const status = states.find(s => s.id === `${ROOT}.atem.recording.transport.status`);
    assert.equal(status?.val, null);
    assert.equal(status?.q, 0x11, "general instance problem");
});

it("an offline owner publishes as instance-not-connected", () => {
    const tree = treeOf({
        values: { "iiyama-prolite.0.info.connection": false, "iiyama-prolite.0.power": true },
    });
    const power = statesFor(registry, tree).find(s => s.id === `${ROOT}.display.lobby.power.power`);
    assert.equal(power?.q, 0x12);
});

it("a healthy reading publishes quality good", () => {
    const tree = treeOf({
        values: { "iiyama-prolite.0.info.connection": true, "iiyama-prolite.0.power": true },
    });
    const power = statesFor(registry, tree).find(s => s.id === `${ROOT}.display.lobby.power.power`);
    assert.equal(power?.q, 0x00);
    assert.equal(power?.val, true);
});

it("resource health aggregates its own bindings", () => {
    const tree = treeOf({
        values: {
            "iiyama-prolite.0.info.connection": true,
            "iiyama-prolite.0.power": true,
            "iiyama-prolite.0.inputSource": 1,
            "iiyama-prolite.0.volume.main": 20,
            "iiyama-prolite.0.video.brightness": 50,
            "iiyama-prolite.0.info.operatingHours": 10,
        },
        meta: { "iiyama-prolite.0.inputSource": { type: "number", states: { 1: "HDMI1" } } },
    });
    const healthy = statesFor(registry, tree).find(s => s.id === `${ROOT}.display.lobby.healthy`);
    assert.equal(healthy?.val, true);

    const partial = statesFor(registry, empty).find(s => s.id === `${ROOT}.display.lobby.healthy`);
    assert.equal(partial?.val, false);
});

it("every writable state has a write target, and every target is writable", () => {
    // A write:true state with no handler is a control whose writes vanish.
    const objects = objectsFor(registry, acmTree);
    const targets = writeTargets(registry);

    const writable = objects.filter(o => o.type === "state" && o.common.write === true).map(o => o.id);
    for (const id of writable) {
        assert.ok(targets.has(id), `${id} is writable but nothing handles it`);
    }
    for (const id of targets.keys()) {
        assert.ok(writable.includes(id), `${id} is a write target but is not published writable`);
    }
});

it("a write target resolves to an action the registry declares", () => {
    for (const [id, target] of writeTargets(registry)) {
        assert.ok(
            registry.getAction(target.resource, target.capability, target.action),
            `${id} maps to an undeclared action`,
        );
    }
});

it("objects and states cover the same published ids", () => {
    const objectIds = objectsFor(registry, acmTree)
        .filter(o => o.type === "state")
        .map(o => o.id)
        .sort();
    const stateIds = statesFor(registry, acmTree)
        .map(s => s.id)
        .sort();
    assert.deepEqual(stateIds, objectIds);
});
