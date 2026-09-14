/**
 * WriteLog tests. The rule is narrow on purpose: something was written, nothing
 * came back. Everything else about why is someone else's question.
 */

import assert from "node:assert/strict";
import { WriteLog } from "./writes";

const T = 1_000_000;

it("a write is confirmed by an acknowledged echo", () => {
    const log = new WriteLog();
    log.arm("showcontrol.0.outputs.artnet.1.5", T, 500);
    assert.equal(log.unconfirmed("showcontrol.0.outputs.artnet.1.5", T + 600), true);

    log.observed("showcontrol.0.outputs.artnet.1.5", true);
    assert.equal(log.unconfirmed("showcontrol.0.outputs.artnet.1.5", T + 600), false);
});

it("an unacknowledged change does not confirm anything", () => {
    // Otherwise our own write, arriving back through the subscription, would
    // confirm itself and the check would never fire.
    const log = new WriteLog();
    log.arm("a.0.x", T, 500);
    log.observed("a.0.x", false);
    assert.equal(log.unconfirmed("a.0.x", T + 600), true);
});

it("a write is not unconfirmed before its window has passed", () => {
    const log = new WriteLog();
    log.arm("a.0.x", T, 500);
    assert.equal(log.unconfirmed("a.0.x", T + 499), false);
    assert.equal(log.unconfirmed("a.0.x", T + 500), true);
});

it("an unconfirmed write keeps saying so", () => {
    // A control whose writes vanish should not flicker back to healthy on a
    // timer; only another write or a real echo changes the answer.
    const log = new WriteLog();
    log.arm("a.0.x", T, 500);
    assert.equal(log.unconfirmed("a.0.x", T + 5_000), true);
    assert.equal(log.unconfirmed("a.0.x", T + 500_000), true);
});

it("a state nobody wrote is never unconfirmed", () => {
    assert.equal(new WriteLog().unconfirmed("a.0.x", T), false);
});

it("a window of zero arms nothing", () => {
    // Undeclared means "no expectation", not "expect an instant echo".
    const log = new WriteLog();
    log.arm("a.0.x", T, 0);
    assert.equal(log.unconfirmed("a.0.x", T + 10_000), false);
});

it("lapsed lists every overdue write and no others", () => {
    const log = new WriteLog();
    log.arm("a.0.late", T, 100);
    log.arm("a.0.soon", T, 10_000);
    assert.deepEqual(log.lapsed(T + 200), ["a.0.late"]);

    log.observed("a.0.late", true);
    assert.deepEqual(log.lapsed(T + 200), []);
});

it("writing again restarts the window", () => {
    const log = new WriteLog();
    log.arm("a.0.x", T, 500);
    assert.equal(log.unconfirmed("a.0.x", T + 600), true);
    log.arm("a.0.x", T + 600, 500);
    assert.equal(log.unconfirmed("a.0.x", T + 700), false);
});
