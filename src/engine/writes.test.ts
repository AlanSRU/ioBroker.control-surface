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

it("the next deadline is the earliest, not the most recent", () => {
    // One timer serves every window, so it has to be armed for the soonest.
    // Arming for whichever write was last meant the ATEM's 2000ms window was
    // cancelled by the TV's 1500ms one, fired early, found nothing overdue and
    // cleared itself — and the vanished write was never reported.
    const log = new WriteLog();
    log.arm("blackmagic-atem.0.me0.programInput", 1000, 2000);
    log.arm("samsungtv.0.meetingtv.state.power", 1100, 1500);

    assert.equal(log.nextDeadline(), 2600, "the TV's deadline is sooner than the mixer's");

    log.observed("samsungtv.0.meetingtv.state.power", true);
    assert.equal(log.nextDeadline(), 3000, "the mixer's deadline survives the TV's confirmation");

    log.observed("blackmagic-atem.0.me0.programInput", true);
    assert.equal(log.nextDeadline(), undefined);
});
