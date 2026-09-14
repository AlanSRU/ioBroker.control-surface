/**
 * Sequence engine tests. The failure-policy and waitFor cases are the point:
 * this is the part of the system that runs unattended during a show.
 */

import assert from "node:assert/strict";

import type { Scene } from "../model";
import { Registry } from "./registry";
import { SceneBook } from "./scenes";
import { run } from "./sequence";
import { allCollections, allMapped } from "../mapping";
import { FakeTree, recorderOn } from "./testing";

const { registry } = Registry.load(allMapped, allCollections);

/** The mapped adapters reporting connected, so health is not the variable. */
const connected = {
    "iiyama-prolite.0.info.connection": true,
    "blustream-acm.0.info.connection": true,
    "blackmagic-atem.0.info.connection": true,
};

/**
 * Loads scenes, asserting they are valid.
 *
 * @param scenes - Scenes to load
 * @returns The book
 */
function bookOf(scenes: ReadonlyArray<Scene>): SceneBook {
    const { book, problems } = SceneBook.load(scenes, registry);
    assert.deepEqual(problems, [], "test scenes must be valid");
    return book;
}

const powerOn = { kind: "do", invoke: { resource: "display.lobby", capability: "power", action: "on" } } as const;
const powerOff = { kind: "do", invoke: { resource: "display.lobby", capability: "power", action: "off" } } as const;

it("steps run in order, and a scene reports completion", () => {
    const tree = new FakeTree({ values: connected });
    const effects = recorderOn(tree);
    const book = bookOf([{ id: "s", name: "s", steps: [powerOn, powerOff] }]);

    return run("s", book, registry, effects).then(report => {
        assert.equal(report.completed, true);
        assert.deepEqual(report.failures, []);
        assert.deepEqual(
            effects.writes.map(w => w.value),
            [true, false],
        );
    });
});

it("a delay waits and does not write", async () => {
    const effects = recorderOn(new FakeTree({ values: connected }));
    const book = bookOf([{ id: "s", name: "s", steps: [powerOn, { kind: "delay", ms: 2000 }, powerOff] }]);

    await run("s", book, registry, effects);
    assert.equal(effects.elapsed, 2000);
    assert.equal(effects.writes.length, 2);
});

it("a refused step aborts the scene by default", async () => {
    // toggle with nothing reported yet: the action engine refuses rather than
    // guessing, and the rest of the scene must not run.
    const effects = recorderOn(new FakeTree({ values: connected }));
    const book = bookOf([
        {
            id: "s",
            name: "s",
            steps: [
                { kind: "do", invoke: { resource: "display.lobby", capability: "power", action: "toggle" } },
                powerOff,
            ],
        },
    ]);

    const report = await run("s", book, registry, effects);
    assert.equal(report.completed, false);
    assert.equal(effects.writes.length, 0, "no step after the failure should have run");
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0]!.handled, "abort");
    assert.deepEqual(report.failures[0]!.reason, {
        kind: "refused",
        refusal: { reason: "unresolved", state: "iiyama-prolite.0.power" },
    });
});

it("continue records the failure and carries on", async () => {
    // "The show goes on" must never mean "nothing happened".
    const effects = recorderOn(new FakeTree({ values: connected }));
    const book = bookOf([
        {
            id: "s",
            name: "s",
            steps: [
                {
                    kind: "do",
                    invoke: { resource: "display.lobby", capability: "power", action: "toggle" },
                    onFailure: { kind: "continue" },
                },
                powerOff,
            ],
        },
    ]);

    const report = await run("s", book, registry, effects);
    assert.equal(report.completed, true);
    assert.equal(report.failures.length, 1, "the failure is still reported");
    assert.equal(report.failures[0]!.handled, "continue");
    assert.equal(effects.writes.length, 1);
});

it("a write that does not land is a failure, not a success", async () => {
    const effects = recorderOn(new FakeTree({ values: connected }), { failWrites: true });
    const report = await run("s", bookOf([{ id: "s", name: "s", steps: [powerOn] }]), registry, effects);

    assert.equal(report.completed, false);
    assert.equal(report.failures[0]!.reason.kind, "write-failed");
});

it("retry tries again, then gives up", async () => {
    const effects = recorderOn(new FakeTree({ values: connected }), { failWrites: true });
    const book = bookOf([
        {
            id: "s",
            name: "s",
            steps: [{ ...powerOn, onFailure: { kind: "retry", times: 2, delayMs: 100 } }],
        },
    ]);

    const report = await run("s", book, registry, effects);
    assert.equal(report.completed, false);
    // Two retries means two waits between three attempts.
    assert.equal(effects.elapsed, 200);
    assert.equal(report.failures.length, 1, "one step, so one reported failure");
});

it("retry succeeds when the condition clears", async () => {
    const tree = new FakeTree({ values: connected });
    const effects = recorderOn(tree);
    // toggle refuses until power has reported; make it report after the first wait.
    effects.at(100, () => tree.set("iiyama-prolite.0.power", true));
    const book = bookOf([
        {
            id: "s",
            name: "s",
            steps: [
                {
                    kind: "do",
                    invoke: { resource: "display.lobby", capability: "power", action: "toggle" },
                    onFailure: { kind: "retry", times: 3, delayMs: 100 },
                },
            ],
        },
    ]);

    const report = await run("s", book, registry, effects);
    assert.equal(report.completed, true);
    assert.deepEqual(report.failures, []);
    assert.deepEqual(
        effects.writes.map(w => w.value),
        [false],
    );
});

it("a fallback replaces the rest of the scene rather than resuming it", async () => {
    // "Switch to the backup projector" does not then want the remaining steps
    // aimed at the dead one. The step after the fallback point is perfectly
    // valid, so if it ran its write would show up.
    const tree = new FakeTree({ values: { ...connected, "blustream-acm.0.receivers.rx3.power": false } });
    const effects = recorderOn(tree);
    const book = bookOf([
        {
            id: "main",
            name: "main",
            steps: [
                {
                    kind: "do",
                    invoke: { resource: "display.lobby", capability: "power", action: "toggle" },
                    onFailure: { kind: "fallback", scene: "backup" },
                },
                { kind: "do", invoke: { resource: "display.lobby", capability: "volume", action: "set", value: 30 } },
            ],
        },
        {
            id: "backup",
            name: "backup",
            steps: [{ kind: "do", invoke: { resource: "display.stage", capability: "power", action: "toggle" } }],
        },
    ]);

    const report = await run("main", book, registry, effects);

    assert.equal(report.completed, true, "the fallback completed, so the run did");
    assert.deepEqual(
        effects.writes,
        [{ state: "blustream-acm.0.receivers.rx3.power", value: true, ack: false }],
        "only the fallback ran; the step after the failure did not",
    );
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0]!.handled, "fallback");
});

it("a fallback that itself fails fails the run", async () => {
    const effects = recorderOn(new FakeTree({ values: connected }));
    const book = bookOf([
        {
            id: "main",
            name: "main",
            steps: [
                {
                    kind: "do",
                    invoke: { resource: "display.lobby", capability: "power", action: "toggle" },
                    onFailure: { kind: "fallback", scene: "backup" },
                },
            ],
        },
        {
            id: "backup",
            name: "backup",
            // Nothing has reported for the stage receiver either.
            steps: [{ kind: "do", invoke: { resource: "display.stage", capability: "power", action: "toggle" } }],
        },
    ]);

    const report = await run("main", book, registry, effects);
    assert.equal(report.completed, false);
    assert.equal(report.failures.length, 2, "both the original and the fallback are reported");
});

it("waitFor returns as soon as the feedback matches", async () => {
    const tree = new FakeTree({ values: connected });
    const effects = recorderOn(tree);
    effects.at(150, () => tree.set("iiyama-prolite.0.power", true));

    const book = bookOf([
        {
            id: "s",
            name: "s",
            steps: [
                {
                    kind: "waitFor",
                    resource: "display.lobby",
                    capability: "power",
                    feedback: "power",
                    equals: true,
                    timeoutMs: 5000,
                },
            ],
        },
    ]);

    const report = await run("s", book, registry, effects);
    assert.equal(report.completed, true);
    assert.ok(effects.elapsed >= 150 && effects.elapsed < 5000, `waited ${effects.elapsed}ms`);
});

it("waitFor gives up at the timeout and says what it last saw", async () => {
    const tree = new FakeTree({ values: { ...connected, "iiyama-prolite.0.power": false } });
    const effects = recorderOn(tree);
    const book = bookOf([
        {
            id: "s",
            name: "s",
            steps: [
                {
                    kind: "waitFor",
                    resource: "display.lobby",
                    capability: "power",
                    feedback: "power",
                    equals: true,
                    timeoutMs: 300,
                },
            ],
        },
    ]);

    const report = await run("s", book, registry, effects);
    assert.equal(report.completed, false);
    assert.deepEqual(report.failures[0]!.reason, { kind: "timeout", waited: 300, last: false });
    assert.equal(effects.elapsed, 300);
});

it("waitFor is not satisfied by an unhealthy reading", async () => {
    // An unacknowledged true is a command someone wrote, not the projector
    // confirming. A scene carrying on from it would be acting on an assumption
    // at the exact moment it asked not to.
    const tree = new FakeTree({ values: connected });
    tree.set("iiyama-prolite.0.power", true, false);
    const effects = recorderOn(tree);
    const book = bookOf([
        {
            id: "s",
            name: "s",
            steps: [
                {
                    kind: "waitFor",
                    resource: "display.lobby",
                    capability: "power",
                    feedback: "power",
                    equals: true,
                    timeoutMs: 200,
                },
            ],
        },
    ]);

    const report = await run("s", book, registry, effects);
    assert.equal(report.completed, false);
    assert.equal(report.failures[0]!.reason.kind, "timeout");
});

it("parallel steps all run", async () => {
    const effects = recorderOn(new FakeTree({ values: connected }));
    const book = bookOf([
        {
            id: "s",
            name: "s",
            steps: [
                {
                    kind: "parallel",
                    steps: [
                        powerOn,
                        {
                            kind: "do",
                            invoke: { resource: "atem.recording", capability: "transport", action: "start" },
                        },
                    ],
                },
            ],
        },
    ]);

    const report = await run("s", book, registry, effects);
    assert.equal(report.completed, true);
    assert.deepEqual(effects.writes.map(w => w.state).sort(), [
        "blackmagic-atem.0.recording.start",
        "iiyama-prolite.0.power",
    ]);
});

it("a nested scene runs inline and its failures name it", async () => {
    const effects = recorderOn(new FakeTree({ values: connected }));
    const book = bookOf([
        { id: "outer", name: "outer", steps: [powerOn, { kind: "scene", scene: "inner" }] },
        {
            id: "inner",
            name: "inner",
            steps: [{ kind: "do", invoke: { resource: "display.lobby", capability: "power", action: "toggle" } }],
        },
    ]);

    const report = await run("outer", book, registry, effects);

    // powerOn writes true, so the nested toggle then has something to invert.
    assert.equal(report.completed, true);
    assert.deepEqual(
        effects.writes.map(w => w.value),
        [true, false],
    );
});

it("the brief's presentation scene runs end to end", async () => {
    // Section 17, against the real mapping: power the display, wait for it to
    // confirm, route the laptop, then take the panel to its page.
    const tree = new FakeTree({
        values: {
            ...connected,
            "streamdeck.0.info.connection": true,
            "blustream-acm.0.transmitters.007.id": "007",
            "blustream-acm.0.transmitters.007.name": "Laptop",
        },
        members: { "blustream-acm.0.transmitters.*": ["blustream-acm.0.transmitters.007"] },
    });
    const effects = recorderOn(tree);
    effects.at(100, () => tree.set("iiyama-prolite.0.power", true));

    const book = bookOf([
        {
            id: "presentation.start",
            name: "Start Presentation",
            onFailure: { kind: "abort" },
            steps: [
                powerOn,
                {
                    kind: "waitFor",
                    resource: "display.lobby",
                    capability: "power",
                    feedback: "power",
                    equals: true,
                    timeoutMs: 10_000,
                },
                {
                    kind: "do",
                    invoke: {
                        resource: "display.stage",
                        capability: "routing",
                        action: "video",
                        value: "Laptop",
                    },
                },
                {
                    kind: "do",
                    invoke: {
                        resource: "surface.reception",
                        capability: "navigation",
                        action: "page",
                        value: "presentation",
                    },
                },
            ],
        },
    ]);

    const report = await run("presentation.start", book, registry, effects);
    assert.equal(report.completed, true);
    assert.deepEqual(report.failures, []);
    assert.deepEqual(effects.writes, [
        { state: "iiyama-prolite.0.power", value: true, ack: false },
        { state: "blustream-acm.0.receivers.rx3.videoRoute", value: "007", ack: false },
        { state: "streamdeck.0.decks.reception.currentPageId", value: "presentation", ack: false },
    ]);
});

it("waitFor accepts the device value as well as the semantic name", () => {
    // `do` already takes either when writing, so requiring the name here made a
    // scene that routes by 1 wait on "Camera 1". The first scene written against
    // real hardware fell straight into it.
    const tree = new FakeTree({
        values: { ...connected, "blustream-acm.0.receivers.rx3.videoRoute": "007" },
        members: { "blustream-acm.0.transmitters.*": ["blustream-acm.0.transmitters.007"] },
    });
    tree.set("blustream-acm.0.transmitters.007.id", "007");
    tree.set("blustream-acm.0.transmitters.007.name", "Laptop");

    const waitOn = (equals: unknown): Scene => ({
        id: "s",
        name: "s",
        steps: [
            {
                kind: "waitFor",
                resource: "display.stage",
                capability: "routing",
                feedback: "video",
                equals,
                timeoutMs: 200,
            },
        ],
    });

    return Promise.all([
        run("s", bookOf([waitOn("Laptop")]), registry, recorderOn(tree)),
        run("s", bookOf([waitOn("007")]), registry, recorderOn(tree)),
    ]).then(([byName, byValue]) => {
        assert.equal(byName.completed, true, "the semantic name should match");
        assert.equal(byValue.completed, true, "the device value should match too");
    });
});

it("an optimistic value that gets corrected does not satisfy a settling wait", async () => {
    // The samsungtv case: the adapter acks the requested value immediately, then
    // a poll corrects it because the TV never did it. The wait must not be
    // fooled by the echo.
    const tree = new FakeTree({ values: { ...connected, "samsungtv.0.meetingtv.info.online": true } });
    tree.set("samsungtv.0.meetingtv.state.power", true); // the optimistic echo
    const effects = recorderOn(tree);
    // 4 seconds in, the poll reports the truth: the TV is still off.
    effects.at(4000, () => tree.set("samsungtv.0.meetingtv.state.power", false));

    const book = bookOf([
        {
            id: "s",
            name: "s",
            steps: [
                {
                    kind: "waitFor",
                    resource: "display.meeting",
                    capability: "power",
                    feedback: "power",
                    equals: true,
                    timeoutMs: 30_000,
                },
            ],
        },
    ]);

    const report = await run("s", book, registry, effects);
    assert.equal(report.completed, false, "the corrected echo must not confirm");
    assert.equal(report.failures[0]!.reason.kind, "timeout");
});

it("a value that holds satisfies the wait once it has settled", async () => {
    const tree = new FakeTree({ values: { ...connected, "samsungtv.0.meetingtv.info.online": true } });
    tree.set("samsungtv.0.meetingtv.state.power", true);
    const effects = recorderOn(tree);

    const book = bookOf([
        {
            id: "s",
            name: "s",
            steps: [
                {
                    kind: "waitFor",
                    resource: "display.meeting",
                    capability: "power",
                    feedback: "power",
                    equals: true,
                    timeoutMs: 30_000,
                },
            ],
        },
    ]);

    const report = await run("s", book, registry, effects);
    assert.equal(report.completed, true);
    // It waited out the declared settling window rather than returning at once.
    assert.ok(effects.elapsed >= 8000, `settled after only ${effects.elapsed}ms`);
});

it("a feedback with no settleMs still returns as soon as it matches", async () => {
    const tree = new FakeTree({ values: connected });
    const effects = recorderOn(tree);
    effects.at(150, () => tree.set("blackmagic-atem.0.me0.programInput", 1));

    const book = bookOf([
        {
            id: "s",
            name: "s",
            steps: [
                {
                    kind: "waitFor",
                    resource: "atem.me1.program",
                    capability: "source",
                    feedback: "source",
                    equals: 1,
                    timeoutMs: 5000,
                },
            ],
        },
    ]);

    const report = await run("s", book, registry, effects);
    assert.equal(report.completed, true);
    assert.ok(effects.elapsed < 1000, `took ${effects.elapsed}ms`);
});

it("waitFor is not satisfied while a write to the same state is unconfirmed", async () => {
    // Composition rather than a new rule: waitFor already requires a healthy
    // reading, and an unechoed write makes the reading unhealthy. A scene
    // therefore cannot step past a write that went nowhere, even though the
    // value it wanted is sitting right there.
    const tree = new FakeTree({ values: { ...connected, "blackmagic-atem.0.me0.programInput": 1 } });
    tree.markUnconfirmed("blackmagic-atem.0.me0.programInput");
    const effects = recorderOn(tree);

    const book = bookOf([
        {
            id: "s",
            name: "s",
            steps: [
                {
                    kind: "waitFor",
                    resource: "atem.me1.program",
                    capability: "source",
                    feedback: "source",
                    equals: 1,
                    timeoutMs: 400,
                },
            ],
        },
    ]);

    const report = await run("s", book, registry, effects);
    assert.equal(report.completed, false);
    assert.deepEqual(report.failures[0]!.reason, { kind: "timeout", waited: 400, last: 1 });
});
