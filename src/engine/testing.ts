/**
 * Test support: an `ObjectSource` built from literals.
 *
 * Not test code itself — it carries no assertions and is excluded from the test
 * glob — but it exists only for tests, so it should never gain behaviour the
 * engine depends on.
 */

import type { StateId, StateValue } from "../model.ts";
import type { ObjectSource, StateMeta, StateSnapshot } from "./resolver.ts";

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
    };
}
