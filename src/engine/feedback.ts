/**
 * The feedback engine: the read direction.
 *
 * Its whole job is to be honest about what is known. A control bound to a state
 * that has never reported, or to an adapter that is down, must not look like a
 * control showing the truth — that is the failure TouchBroker's per-binding
 * health exists for, and the reason `health` appears as an ordinary capability
 * throughout `mapping.ts`.
 *
 * So a reading always carries *why* it should not be trusted, not merely that it
 * should not be. "The adapter is down" and "this has never reported" want
 * different things on screen.
 *
 * Pure, like the rest of the engine: the object tree arrives through
 * `ObjectSource` and nothing here subscribes or writes.
 */

import type { CapabilityId, FeedbackDef, FeedbackValue, ResourceId, StateValue, UnhealthyReason } from "../model";
import type { ObjectSource } from "./resolver";
import { toSemantic } from "./resolver";
import type { Registry } from "./registry";

/**
 * Reads one declared feedback.
 *
 * @param resource - Semantic resource id
 * @param capability - Capability id
 * @param feedback - Feedback id within the capability
 * @param registry - The declared resources
 * @param source - View of the object tree
 * @returns The reading, or undefined when nothing declares this feedback
 */
export function read(
    resource: ResourceId,
    capability: CapabilityId,
    feedback: string,
    registry: Registry,
    source: ObjectSource,
): FeedbackValue | undefined {
    const def = registry.getFeedback(resource, capability, feedback);
    if (!def) {
        return undefined;
    }
    return readDef(resource, capability, def, registry, source);
}

/**
 * Reads every declared feedback across every resource.
 *
 * This is what the state publisher walks. It reports unhealthy readings rather
 * than skipping them: a control whose device has gone still needs publishing,
 * or a panel has no way to tell "gone" from "never existed".
 *
 * @param registry - The declared resources
 * @param source - View of the object tree
 * @returns One reading per declared feedback
 */
export function readAll(registry: Registry, source: ObjectSource): ReadonlyArray<FeedbackValue> {
    const readings: FeedbackValue[] = [];
    for (const resource of registry.allResources()) {
        for (const capability of resource.capabilities) {
            for (const def of capability.feedback) {
                readings.push(readDef(resource.id, capability.id, def, registry, source));
            }
        }
    }
    return readings;
}

/**
 * Builds one reading from a declaration and the current tree.
 *
 * @param resource - Semantic resource id
 * @param capability - Capability id
 * @param def - The declared feedback
 * @param registry - The declared resources
 * @param source - View of the object tree
 * @returns The reading
 */
function readDef(
    resource: ResourceId,
    capability: CapabilityId,
    def: FeedbackDef,
    registry: Registry,
    source: ObjectSource,
): FeedbackValue {
    const base = { resource, capability, feedback: def.id };
    const snapshot = source.snapshotOf(def.binding.state);

    // `blackmagic-atem` rebuilds its tree from the detected model, so a bound
    // state may simply not be there. That is not an error, and it is the most
    // specific thing that can be said, so it is reported ahead of anything else.
    const inferred = def.inferred === true;

    if (!snapshot) {
        return {
            ...base,
            value: null,
            raw: null,
            healthy: false,
            unhealthy: "unresolved",
            inferred,
            timestamp: 0,
        };
    }

    const raw = snapshot.val;
    const value = semanticValue(def, raw, registry, source);
    const reason = unhealthyReason(resource, snapshot, registry, source);

    // Deliberately not folded into `healthy`. A port check that really did
    // succeed is a healthy reading of the wrong thing, and a renderer that
    // dimmed it would be saying something false.
    return reason === undefined
        ? { ...base, value, raw, healthy: true, inferred, timestamp: snapshot.ts }
        : { ...base, value, raw, healthy: false, unhealthy: reason, inferred, timestamp: snapshot.ts };
}

/**
 * Decides whether a reading can be trusted, and why not.
 *
 * Ordered by how useful the answer is to whoever has to act on it: an adapter
 * that is down explains every one of its resources at once, so it outranks the
 * per-state reasons it would otherwise cause.
 *
 * @param resource - Semantic resource id, for finding the owner
 * @param snapshot - The state as read back
 * @param snapshot.val
 * @param snapshot.ack
 * @param registry - The declared resources
 * @param source - View of the object tree
 * @returns The reason, or undefined when the reading is sound
 */
function unhealthyReason(
    resource: ResourceId,
    snapshot: { readonly val: StateValue | null; readonly ack: boolean },
    registry: Registry,
    source: ObjectSource,
): UnhealthyReason | undefined {
    const connection = registry.ownerConnection(resource);
    if (connection !== undefined) {
        const reported = source.snapshotOf(connection);
        // Absent means the adapter follows a different convention, not that it
        // is offline. Only an explicit false counts.
        if (reported?.val === false) {
            return "owner-offline";
        }
    }

    if (snapshot.val === null) {
        return "never-reported";
    }

    // An unacknowledged value is a command someone wrote, not the device
    // reporting. Presenting it as feedback would show an intention as a fact.
    if (!snapshot.ack) {
        return "unacknowledged";
    }

    return undefined;
}

/**
 * Maps a device value into the capability's own vocabulary.
 *
 * An unmappable value is reported raw rather than dropped. If an ACM route
 * reads `007` and the transmitter list has not loaded, `007` is still the
 * truth — a panel showing it unlabelled is degraded, but a panel showing
 * nothing is wrong.
 *
 * @param def - The declared feedback
 * @param raw - Value as the device reported it
 * @param registry - The declared resources
 * @param source - View of the object tree
 * @returns The semantic value, or the raw one when it cannot be mapped
 */
function semanticValue(
    def: FeedbackDef,
    raw: StateValue | null,
    registry: Registry,
    source: ObjectSource,
): StateValue | null {
    if (raw === null) {
        return null;
    }
    const space = def.binding.values?.kind ?? "identity";
    if (space === "identity") {
        // Passing an identity value through `toSemantic` would stringify it,
        // turning a boolean lamp into the text "true".
        return raw;
    }
    return toSemantic(def.binding, raw, registry, source) ?? raw;
}
