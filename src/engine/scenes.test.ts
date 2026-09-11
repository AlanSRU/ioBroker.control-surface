/**
 * Scene validation tests. Everything here is a fault that can be found without
 * touching a device, which is the whole reason to look for it at load.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Scene } from "../model.ts";
import { Registry } from "./registry.ts";
import { SceneBook } from "./scenes.ts";
import { allCollections, allMapped } from "../mapping.ts";

const { registry } = Registry.load(allMapped, allCollections);

/**
 * Builds a scene.
 *
 * @param id - Scene id
 * @param over - Fields to override
 * @returns The scene
 */
function sceneOf(id: string, over: Partial<Scene> = {}): Scene {
    return {
        id,
        name: id,
        steps: [{ kind: "do", invoke: { resource: "display.lobby", capability: "power", action: "on" } }],
        ...over,
    };
}

/**
 * Loads scenes and returns the problem reasons.
 *
 * @param scenes - Scenes to load
 * @returns One string per problem
 */
function reasonsFor(scenes: ReadonlyArray<Scene>): string[] {
    return SceneBook.load(scenes, registry).problems.map(p => p.reason);
}

test("a scene over declared actions loads cleanly", () => {
    const { book, problems } = SceneBook.load([sceneOf("presentation.start")], registry);
    assert.deepEqual(problems, []);
    assert.ok(book.get("presentation.start"));
});

test("an action no resource declares is caught at load", () => {
    const reasons = reasonsFor([
        sceneOf("bad", {
            steps: [{ kind: "do", invoke: { resource: "display.lobby", capability: "power", action: "explode" } }],
        }),
    ]);
    assert.match(reasons[0]!, /undeclared action "display\.lobby\.power\.explode"/);
});

test("a wait on undeclared feedback is caught at load", () => {
    const reasons = reasonsFor([
        sceneOf("bad", {
            steps: [
                {
                    kind: "waitFor",
                    resource: "display.lobby",
                    capability: "power",
                    feedback: "nope",
                    equals: true,
                    timeoutMs: 1000,
                },
            ],
        }),
    ]);
    assert.match(reasons[0]!, /undeclared feedback/);
});

test("faults inside a parallel branch are found too", () => {
    const reasons = reasonsFor([
        sceneOf("bad", {
            steps: [
                {
                    kind: "parallel",
                    steps: [
                        { kind: "do", invoke: { resource: "nope", capability: "power", action: "on" } },
                    ],
                },
            ],
        }),
    ]);
    assert.match(reasons[0]!, /undeclared action "nope\.power\.on"/);
});

test("a forward reference to a later scene is legal", () => {
    // Order of declaration must not decide whether a reference works.
    const { problems } = SceneBook.load(
        [sceneOf("first", { steps: [{ kind: "scene", scene: "second" }] }), sceneOf("second")],
        registry,
    );
    assert.deepEqual(problems, []);
});

test("a scene that runs itself is refused", () => {
    const reasons = reasonsFor([sceneOf("loop", { steps: [{ kind: "scene", scene: "loop" }] })]);
    assert.match(reasons[0]!, /scene cycle: loop -> loop/);
});

test("an indirect cycle is refused", () => {
    const reasons = reasonsFor([
        sceneOf("a", { steps: [{ kind: "scene", scene: "b" }] }),
        sceneOf("b", { steps: [{ kind: "scene", scene: "c" }] }),
        sceneOf("c", { steps: [{ kind: "scene", scene: "a" }] }),
    ]);
    assert.equal(reasons.length, 3, "every scene in the cycle should be rejected");
    assert.match(reasons[0]!, /scene cycle/);
});

test("a cycle through a failure fallback is refused", () => {
    // Harder to spot by eye than a direct call, and loops just as surely.
    const reasons = reasonsFor([
        sceneOf("a", {
            steps: [
                {
                    kind: "do",
                    invoke: { resource: "display.lobby", capability: "power", action: "on" },
                    onFailure: { kind: "fallback", scene: "b" },
                },
            ],
        }),
        sceneOf("b", { steps: [{ kind: "scene", scene: "a" }] }),
    ]);
    assert.ok(reasons.some(r => /scene cycle/.test(r)), reasons.join("; "));
});

test("running the same scene twice in sequence is not a cycle", () => {
    const { problems } = SceneBook.load(
        [
            sceneOf("twice", { steps: [{ kind: "scene", scene: "leaf" }, { kind: "scene", scene: "leaf" }] }),
            sceneOf("leaf"),
        ],
        registry,
    );
    assert.deepEqual(problems, []);
});

test("a fallback to a scene that does not exist is caught", () => {
    const reasons = reasonsFor([
        sceneOf("a", {
            steps: [
                {
                    kind: "do",
                    invoke: { resource: "display.lobby", capability: "power", action: "on" },
                    onFailure: { kind: "fallback", scene: "ghost" },
                },
            ],
        }),
    ]);
    assert.match(reasons[0]!, /falls back to unknown scene "ghost"/);
});

test("waits and retries that can never work are caught", () => {
    const zeroTimeout = reasonsFor([
        sceneOf("a", {
            steps: [
                {
                    kind: "waitFor",
                    resource: "display.lobby",
                    capability: "power",
                    feedback: "power",
                    equals: true,
                    timeoutMs: 0,
                },
            ],
        }),
    ]);
    assert.match(zeroTimeout[0]!, /timeout of 0ms/);

    const noRetries = reasonsFor([
        sceneOf("b", {
            steps: [
                {
                    kind: "do",
                    invoke: { resource: "display.lobby", capability: "power", action: "on" },
                    onFailure: { kind: "retry", times: 0, delayMs: 10 },
                },
            ],
        }),
    ]);
    assert.match(noRetries[0]!, /retries 0 times/);
});

test("a faulty scene is dropped whole, and the others survive", () => {
    const { book, problems } = SceneBook.load(
        [sceneOf("good"), sceneOf("bad", { steps: [{ kind: "scene", scene: "ghost" }] })],
        registry,
    );
    assert.ok(book.get("good"));
    assert.equal(book.get("bad"), undefined);
    assert.equal(problems.length, 1);
});

test("duplicate scene ids are refused", () => {
    const reasons = reasonsFor([sceneOf("same"), sceneOf("same")]);
    assert.match(reasons[0]!, /duplicate id/);
});
