/**
 * Tracking whether writes actually landed.
 *
 * A binding that declares `confirmWithinMs` expects an acknowledged echo after
 * it is written. This keeps the bookkeeping — which writes are outstanding, and
 * which have gone unanswered long enough to count as dropped — as a pure object
 * so the rule is testable without an ioBroker or a real clock.
 *
 * It deliberately knows nothing about *why* a write went unanswered. The useful
 * statement is the narrow one: something was written, nothing came back, and a
 * control that looks live is doing nothing.
 */

import type { StateId } from "../model";

export class WriteLog {
    /** State id to the deadline its echo must arrive by. */
    private readonly pending = new Map<StateId, number>();

    /**
     * Records a write that expects an echo.
     *
     * @param state - The state written
     * @param now - When it was written
     * @param withinMs - How long the echo may take
     */
    arm(state: StateId, now: number, withinMs: number): void {
        if (withinMs > 0) {
            this.pending.set(state, now + withinMs);
        }
    }

    /**
     * Records an observed state change.
     *
     * Only an acknowledged change clears a write. An unacknowledged one is
     * another command — quite possibly our own, arriving back through the
     * subscription — and treating it as confirmation would make every write
     * confirm itself.
     *
     * @param state - The state that changed
     * @param ack - Whether the change was acknowledged
     */
    observed(state: StateId, ack: boolean): void {
        if (ack) {
            this.pending.delete(state);
        }
    }

    /**
     * Whether a write to this state was never answered.
     *
     * Stays true once the deadline passes, until the state is written again or
     * finally echoes. A control whose writes are vanishing should keep saying so
     * rather than flickering back to healthy on a timer.
     *
     * @param state - The state to ask about
     * @param now - The current time
     * @returns True when a write is overdue
     */
    unconfirmed(state: StateId, now: number): boolean {
        const deadline = this.pending.get(state);
        return deadline !== undefined && now >= deadline;
    }

    /**
     * Every state with an overdue write.
     *
     * @param now - The current time
     * @returns The states, for logging and republishing
     */
    lapsed(now: number): ReadonlyArray<StateId> {
        return [...this.pending].filter(([, deadline]) => now >= deadline).map(([state]) => state);
    }

    /** Forgets everything, for an adapter shutting down. */
    clear(): void {
        this.pending.clear();
    }
}
