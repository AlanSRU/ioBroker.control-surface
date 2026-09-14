/**
 * Test support: an `ObjectSource` built from literals.
 *
 * Not test code itself — it carries no assertions and is excluded from the test
 * glob — but it exists only for tests, so it should never gain behaviour the
 * engine depends on.
 */

import type { StateId, StateValue } from "../model";
import type { ObjectSource, StateMeta, StateSnapshot } from "./resolver";
import type { StateWrite } from "./actions";

export interface TreeSpec {
    /** `common` fields, keyed by state id. */
    readonly meta?: Record<StateId, StateMeta>;
    /** Member ids, keyed by the pattern that finds them. */
    readonly members?: Record<string, ReadonlyArray<StateId>>;
    /**
     * Values the device has reported: acknowledged, and timestamped now. This
     * is the ordinary case, so it is the short way to write it.
     */
    readonly values?: Record<StateId, StateValue>;
    /** Full snapshots, for cases that turn on `ack` or `ts`. */
    readonly states?: Record<StateId, StateSnapshot>;
    /** States whose last write was never echoed back. */
    readonly unconfirmed?: ReadonlyArray<StateId>;
}

/** A timestamp standing for "the device reported this just now". */
export const NOW = 1_757_000_000_000;

/**
 * Builds an object tree from literals.
 *
 * @param spec - What the tree contains
 * @returns An `ObjectSource` over it
 */
export function treeOf(spec: TreeSpec): ObjectSource {
    return {
        metaOf: id => spec.meta?.[id],
        membersOf: pattern => spec.members?.[pattern],
        snapshotOf: id => {
            const explicit = spec.states?.[id];
            if (explicit) {
                return explicit;
            }
            const value = spec.values?.[id];
            return value === undefined ? undefined : { val: value, ack: true, ts: NOW };
        },
        unconfirmed: id => (spec.unconfirmed ?? []).includes(id),
    };
}

// ---------------------------------------------------------------------------
// Sequence support: a tree that changes, and a clock that does not really wait
// ---------------------------------------------------------------------------

/**
 * A mutable object tree.
 *
 * Scenes exist to outlive a moment, so testing one needs a tree that can change
 * between steps — which a literal cannot do.
 */
export class FakeTree {
    private readonly unconfirmedStates = new Set<StateId>();
    private readonly spec: {
        meta: Record<StateId, StateMeta>;
        members: Record<string, ReadonlyArray<StateId>>;
        states: Record<StateId, StateSnapshot>;
    };

    constructor(initial: TreeSpec = {}) {
        this.spec = { meta: { ...initial.meta }, members: { ...initial.members }, states: {} };
        for (const [id, val] of Object.entries(initial.values ?? {})) {
            this.spec.states[id] = { val, ack: true, ts: NOW };
        }
        Object.assign(this.spec.states, initial.states ?? {});
    }

    /**
     * Sets a state, as an adapter reporting would.
     *
     * @param id - State id
     * @param val - Value
     * @param ack - Whether the device is reporting it; true by default
     */
    set(id: StateId, val: StateValue | null, ack = true): void {
        this.spec.states[id] = { val, ack, ts: NOW };
    }

    /**
     * Removes a state, as `blackmagic-atem` does when it rebuilds its tree.
     *
     * @param id
     */
    remove(id: StateId): void {
        delete this.spec.states[id];
    }

    source(): ObjectSource {
        return {
            metaOf: id => this.spec.meta[id],
            membersOf: pattern => this.spec.members[pattern],
            snapshotOf: id => this.spec.states[id],
            unconfirmed: id => this.unconfirmedStates.has(id),
        };
    }

    /** Marks a state as written-but-never-echoed. */
    markUnconfirmed(id: StateId): void {
        this.unconfirmedStates.add(id);
    }
}

/** An `Effects` that records what happened and never really sleeps. */
export interface Recorder {
    write(writes: ReadonlyArray<StateWrite>): Promise<void>;
    sleep(ms: number): Promise<void>;
    source(): ObjectSource;
    /** Every write, in the order it was made. */
    readonly writes: StateWrite[];
    /** Virtual milliseconds slept. */
    readonly elapsed: number;
    /** Schedules a change for once the clock has advanced this far. */
    at(ms: number, change: () => void): void;
}

/**
 * Builds effects over a tree, with a virtual clock.
 *
 * Writes land in the tree acknowledged, which is the optimistic case. A test
 * that cares about the gap between writing and the device confirming sets the
 * state itself instead.
 *
 * @param tree - The tree to read and write
 * @param opts - Options; `failWrites` makes every write reject
 * @param opts.failWrites
 * @returns The recorder
 */
export function recorderOn(tree: FakeTree, opts: { failWrites?: boolean } = {}): Recorder {
    const writes: StateWrite[] = [];
    const scheduled: Array<{ at: number; change: () => void }> = [];
    let elapsed = 0;

    const recorder: Recorder = {
        writes,
        get elapsed() {
            return elapsed;
        },
        at(ms, change) {
            scheduled.push({ at: ms, change });
        },
        source: () => tree.source(),
        write(planned) {
            if (opts.failWrites) {
                return Promise.reject(new Error("write refused by the test"));
            }
            writes.push(...planned);
            for (const w of planned) {
                tree.set(w.state, w.value);
            }
            return Promise.resolve();
        },
        sleep(ms) {
            // Nothing actually waits: the clock is virtual, so a scene with a
            // ten-second delay in it still runs in microseconds.
            elapsed += ms;
            for (const entry of scheduled.filter(s => s.at <= elapsed)) {
                entry.change();
                entry.at = Number.POSITIVE_INFINITY;
            }
            return Promise.resolve();
        },
    };
    return recorder;
}
