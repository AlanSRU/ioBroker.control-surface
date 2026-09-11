/**
 * The state publisher: what the semantic tree should look like, as data.
 *
 * This is decision 1 made concrete. The layer publishes
 * `<instance>.resources.<resource>.<capability>.<name>` and knows nothing about
 * who reads it, so a TouchBroker panel, vis, Blockly, Node-RED or a script all
 * get semantics with no integration work and no bespoke protocol.
 *
 * **Published values are raw device values, with `common.states` carrying the
 * labels.** Publishing semantic names instead was considered and rejected: the
 * model deliberately refuses a universal vocabulary (section 29), so names are
 * not portable across vendors anyway, and `{"1": "HDMI1"}` is the idiom every
 * existing ioBroker consumer already reads — including TouchBroker's
 * `map: {fromStates: true}`. The semantic gain here is the addressing and the
 * grouping, not value normalisation. Scenes still work in names, and the action
 * engine accepts either.
 *
 * Pure, like the rest: it returns a description, and the adapter applies it.
 */

import type { ActionDef, CapabilityId, ResourceId, StateValue } from "../model";
import type { ObjectSource } from "./resolver";
import { optionsFor } from "./resolver";
import { read } from "./feedback";
import type { Registry } from "./registry";

/** Root of the published tree, below the adapter's own namespace. */
export const ROOT = "resources";

/** Published under each resource; `registry.ts` reserves the capability name. */
const HEALTH = "healthy";

/**
 * ioBroker state qualities, from `@iobroker/types` `STATE_QUALITY`.
 *
 * Only the codes that clearly fit are used. `unacknowledged` is the loosest —
 * 0x40 reads as "substituted from the device or instance", and an unconfirmed
 * command did come from a writer rather than the device — and the precise
 * reason is on `FeedbackValue` for anything that needs better than a code.
 */
const QUALITY = {
    good: 0x00,
    /** The owning instance has not published the bound state. */
    generalInstanceProblem: 0x11,
    /** The owning adapter reports itself disconnected. */
    instanceNotConnected: 0x12,
    substituteInitialValue: 0x20,
    substituteDeviceInstanceValue: 0x40,
} as const;

export interface PublishedCommon {
    readonly name: string;
    readonly type?: "string" | "number" | "boolean";
    readonly role?: string;
    readonly read?: boolean;
    readonly write?: boolean;
    readonly states?: Readonly<Record<string, string>>;
    readonly min?: number;
    readonly max?: number;
    readonly step?: number;
    readonly desc?: string;
}

export interface PublishedObject {
    /** Id relative to the adapter namespace, e.g. `resources.display.lobby.power`. */
    readonly id: string;
    readonly type: "folder" | "device" | "channel" | "state";
    readonly common: PublishedCommon;
}

export interface PublishedState {
    readonly id: string;
    readonly val: StateValue | null;
    /** Always true: this layer is reporting, not commanding. */
    readonly ack: true;
    readonly q: Quality;
}

/** The subset of `STATE_QUALITY` this layer emits, as literals so it type-checks. */
export type Quality = 0x00 | 0x11 | 0x12 | 0x20 | 0x40;

/** What a write to a published state invokes. */
export interface ActionTarget {
    readonly resource: ResourceId;
    readonly capability: CapabilityId;
    readonly action: string;
}

/**
 * Every object the tree needs, parents included.
 *
 * Intermediate `folder`, `device` and `channel` objects are emitted explicitly
 * rather than relied upon: ioBroker tolerates an orphan state at runtime, so
 * nothing looks wrong until the adapter is reviewed against a live object dump
 * and E3009 fires for every missing parent.
 *
 * @param registry - The declared resources
 * @param source - View of the object tree, for value spaces
 * @returns Objects in parent-before-child order
 */
export function objectsFor(registry: Registry, source: ObjectSource): ReadonlyArray<PublishedObject> {
    const objects: PublishedObject[] = [{ id: ROOT, type: "folder", common: { name: "Resources" } }];
    const emitted = new Set<string>([ROOT]);

    for (const resource of registry.allResources()) {
        // `display.lobby` becomes `resources.display` + `resources.display.lobby`,
        // so every segment but the last is an organisational folder.
        const segments = resource.id.split(".");
        segments.slice(0, -1).forEach((_, index) => {
            const id = `${ROOT}.${segments.slice(0, index + 1).join(".")}`;
            if (!emitted.has(id)) {
                emitted.add(id);
                objects.push({ id, type: "folder", common: { name: segments[index]! } });
            }
        });

        const base = `${ROOT}.${resource.id}`;
        objects.push({
            id: base,
            type: "device",
            common: { name: resource.name ?? resource.id, desc: `Owned by ${resource.owner}` },
        });
        objects.push({
            id: `${base}.${HEALTH}`,
            type: "state",
            common: {
                name: "Healthy",
                type: "boolean",
                role: "indicator",
                read: true,
                write: false,
                desc: "False when any of this resource's bindings cannot be trusted",
            },
        });

        for (const capability of resource.capabilities) {
            objects.push({ id: `${base}.${capability.id}`, type: "channel", common: { name: capability.id } });

            const feedbackIds = new Set(capability.feedback.map(f => f.id));
            for (const action of capability.actions) {
                objects.push({
                    id: `${base}.${capability.id}.${action.id}`,
                    type: "state",
                    // A shared id means one read/write state; the registry has
                    // already checked both bind the same device state.
                    common: actionCommon(action, feedbackIds.has(action.id), registry, source),
                });
            }
            for (const feedback of capability.feedback) {
                if (feedbackIds.has(feedback.id) && capability.actions.some(a => a.id === feedback.id)) {
                    continue;
                }
                objects.push({
                    id: `${base}.${capability.id}.${feedback.id}`,
                    type: "state",
                    common: {
                        name: feedback.id,
                        ...presentationCommon(feedback.presentation, registry, source, feedback.binding),
                        read: true,
                        write: false,
                    },
                });
            }
        }
    }

    return objects;
}

/**
 * The current value of every published state.
 *
 * @param registry - The declared resources
 * @param source - View of the object tree
 * @returns One entry per published state
 */
export function statesFor(registry: Registry, source: ObjectSource): ReadonlyArray<PublishedState> {
    const states: PublishedState[] = [];

    for (const resource of registry.allResources()) {
        const base = `${ROOT}.${resource.id}`;
        let allHealthy = true;

        for (const capability of resource.capabilities) {
            for (const action of capability.actions) {
                // An action state carries whatever its bound state currently
                // holds, which for a write-only trigger is nothing.
                const snapshot = source.snapshotOf(action.binding.state);
                states.push({
                    id: `${base}.${capability.id}.${action.id}`,
                    val: snapshot?.val ?? null,
                    ack: true,
                    q: snapshot ? QUALITY.good : QUALITY.generalInstanceProblem,
                });
            }

            for (const feedback of capability.feedback) {
                if (capability.actions.some(a => a.id === feedback.id)) {
                    continue;
                }
                const reading = read(resource.id, capability.id, feedback.id, registry, source);
                allHealthy &&= reading?.healthy ?? false;
                states.push({
                    id: `${base}.${capability.id}.${feedback.id}`,
                    val: reading?.raw ?? null,
                    ack: true,
                    q: qualityOf(reading?.healthy === true ? undefined : reading?.unhealthy),
                });
            }
        }

        states.push({ id: `${base}.${HEALTH}`, val: allHealthy, ack: true, q: QUALITY.good });
    }

    return states;
}

/**
 * Which action a write to each published state invokes.
 *
 * Every `write: true` state the tree publishes must appear here, or the adapter
 * would create a control whose writes fall through and are silently ignored.
 *
 * @param registry - The declared resources
 * @returns Published state id to the action it stands for
 */
export function writeTargets(registry: Registry): ReadonlyMap<string, ActionTarget> {
    const targets = new Map<string, ActionTarget>();
    for (const resource of registry.allResources()) {
        for (const capability of resource.capabilities) {
            for (const action of capability.actions) {
                targets.set(`${ROOT}.${resource.id}.${capability.id}.${action.id}`, {
                    resource: resource.id,
                    capability: capability.id,
                    action: action.id,
                });
            }
        }
    }
    return targets;
}

/**
 * Maps an unhealthy reason onto an ioBroker quality code.
 *
 * @param reason - Why the reading is unsound, or undefined when it is not
 * @returns The quality code
 */
function qualityOf(reason: string | undefined): Quality {
    switch (reason) {
        case undefined:
            return QUALITY.good;
        case "owner-offline":
            return QUALITY.instanceNotConnected;
        case "never-reported":
            return QUALITY.substituteInitialValue;
        case "unacknowledged":
            return QUALITY.substituteDeviceInstanceValue;
        default:
            return QUALITY.generalInstanceProblem;
    }
}

/**
 * `common` for an action's published state.
 *
 * Roles are constrained by what repochecker accepts, not by taste: `value` is
 * read-only, `level` requires `read: true`, and a momentary trigger must be
 * `button` with `read: false`. Getting this wrong fails E1008/E1010/E1011.
 *
 * Note this publishes roles without ever reading one back. Role inference is
 * what the mapping disproved; emitting a role as a hint for renderers is the
 * opposite direction and costs nothing.
 *
 * @param action - The declared action
 * @param readable - Whether a feedback of the same id shares its state
 * @param registry - The declared resources
 * @param source - View of the object tree
 * @returns The `common` block
 */
function actionCommon(action: ActionDef, readable: boolean, registry: Registry, source: ObjectSource): PublishedCommon {
    const name = action.id;

    switch (action.kind) {
        case "set":
        case "toggle":
            // Both are momentary: `power.on` means "do the on thing", never
            // "are you on". Publishing them readable would invite a panel to
            // render a switch whose value is meaningless.
            return { name, type: "boolean", role: "button", read: false, write: true };

        case "level": {
            const common: PublishedCommon = {
                name,
                type: "number",
                role: "level",
                read: true,
                write: true,
                min: action.min,
                max: action.max,
            };
            return action.step === undefined ? common : { ...common, step: action.step };
        }

        case "select":
        case "route": {
            const space = spaceOf(action.binding, registry, source);
            return {
                name,
                type: space.type,
                // A writable number is `level`; a writable string is `text`.
                role: space.type === "number" ? "level" : "text",
                read: readable,
                write: true,
                ...(space.states ? { states: space.states } : {}),
            };
        }
    }
}

/**
 * `common` fields implied by a feedback's presentation.
 *
 * @param presentation - How the feedback should be read
 * @param registry - The declared resources
 * @param source - View of the object tree
 * @param binding - The feedback's binding, for its value space
 * @returns Type, role and any value labels; the caller supplies the name
 */
function presentationCommon(
    presentation: "text" | "boolean" | "number" | "selection",
    registry: Registry,
    source: ObjectSource,
    binding: Parameters<typeof optionsFor>[0],
): Omit<PublishedCommon, "name"> {
    switch (presentation) {
        case "boolean":
            return { type: "boolean", role: "indicator" };
        case "number":
            return { type: "number", role: "value" };
        case "text":
            return { type: "string", role: "text" };
        case "selection": {
            const space = spaceOf(binding, registry, source);
            return {
                // A read-only number is `value`; `level` would fail E1010.
                type: space.type,
                role: space.type === "number" ? "value" : "text",
                ...(space.states ? { states: space.states } : {}),
            };
        }
    }
}

/**
 * What a binding's value space publishes as: a type, and labels if it resolves.
 *
 * The type comes from the resolved options' own JavaScript types, never from
 * how their keys look. A Blustream C66 routes by the **string** `"007"`, which
 * reads as numeric and is not: publishing it as a number would send `7` and the
 * device would reject it. `optionsFor` has already coerced each value against
 * the bound state's `common.type`, so its answer is the one to trust — this is
 * the same trap the resolver documents, reachable by a second route.
 *
 * An unresolvable space yields no labels rather than an empty map: a selector
 * with no options is a broken control, whereas a selector with no declared
 * options is one whose list has not arrived. It also keeps the declared type,
 * because a route is a string whether or not the transmitters have loaded.
 *
 * @param binding - The binding to resolve
 * @param registry - The declared resources
 * @param source - View of the object tree
 * @returns The published type, and device value to label where known
 */
function spaceOf(
    binding: Parameters<typeof optionsFor>[0],
    registry: Registry,
    source: ObjectSource,
): { type: "string" | "number"; states?: Readonly<Record<string, string>> } {
    const declared = source.metaOf(binding.state)?.type;
    const fallback = declared === "number" ? "number" : "string";

    if (binding.values === undefined || binding.values.kind === "identity") {
        return { type: fallback };
    }
    const resolved = optionsFor(binding, registry, source);
    if (!resolved.ok || resolved.options.length === 0) {
        return { type: fallback };
    }
    return {
        type: resolved.options.every(o => typeof o.value === "number") ? "number" : "string",
        states: Object.fromEntries(resolved.options.map(o => [String(o.value), o.name])),
    };
}
