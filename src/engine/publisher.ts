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

import type { ActionDef, CapabilityId, ResourceId, Scene, StateValue, UnhealthyReason } from "../model";
import type { ObjectSource } from "./resolver";
import { optionsFor } from "./resolver";
import { ownerOffline, read, unhealthyReason } from "./feedback";
import type { Registry } from "./registry";

/** Root of the published tree, below the adapter's own namespace. */
export const ROOT = "resources";

/** Where scenes are published. */
export const SCENES = "scenes";

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
    /** Written, accepted, never echoed: the device is not doing as it is told. */
    generalDeviceProblem: 0x41,
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
export type Quality = 0x00 | 0x11 | 0x12 | 0x20 | 0x40 | 0x41;

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

    // One id must produce one object. `display.lobby` makes `resources.display`
    // a folder, so declaring both `room1` and `room1.matrix` — a room beside the
    // equipment in it, which the mapping's own `room1.*` naming invites — used
    // to emit `resources.room1` twice, once as a device and once as a folder.
    // Both reached `publish()`, so the object's type flipped and the two
    // descriptions fought each other under a single fingerprint, rewriting on
    // every republish forever. The device wins, because it is the thing an
    // administrator actually declared; the folder is only scaffolding. Collected
    // up front so the answer does not depend on declaration order.
    const declared = new Set(registry.allResources().map(r => `${ROOT}.${r.id}`));

    /**
     * Emits an object unless that id is already taken.
     *
     * The `declared` set below settles device-versus-folder, but it only ever
     * covered folder scaffolding — a resource whose published base equals
     * another resource's *channel* or its reserved `healthy` state still
     * produced two objects with two types under one id, which is the
     * rewrite-on-every-republish failure this function exists to avoid.
     * Funnelling every emission through one gate makes "one id, one object" a
     * property of the code rather than of the three places that remembered.
     *
     * First wins, and the order below puts the declared thing first.
     *
     * @param object - The object to emit
     */
    const emit = (object: PublishedObject): void => {
        if (emitted.has(object.id)) {
            return;
        }
        emitted.add(object.id);
        objects.push(object);
    };

    for (const resource of registry.allResources()) {
        // Every segment but the last is an organisational folder.
        const segments = resource.id.split(".");
        segments.slice(0, -1).forEach((_, index) => {
            const id = `${ROOT}.${segments.slice(0, index + 1).join(".")}`;
            // `declared` still has to be consulted separately: the gate is
            // first-wins, and a folder reached before the device that owns the
            // same id would otherwise win it.
            if (!declared.has(id)) {
                emit({ id, type: "folder", common: { name: segments[index]! } });
            }
        });

        const base = `${ROOT}.${resource.id}`;
        emit({
            id: base,
            type: "device",
            common: { name: resource.name ?? resource.id, desc: `Owned by ${resource.owner}` },
        });
        emit({
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
            emit({ id: `${base}.${capability.id}`, type: "channel", common: { name: capability.id } });

            const feedbackIds = new Set(capability.feedback.map(f => f.id));
            for (const action of capability.actions) {
                emit({
                    id: `${base}.${capability.id}.${action.id}`,
                    type: "state",
                    // A shared id means one read/write state; the registry has
                    // already checked both bind the same device state.
                    common: actionCommon(action, registry, source),
                });
            }
            for (const feedback of capability.feedback) {
                if (feedbackIds.has(feedback.id) && capability.actions.some(a => a.id === feedback.id)) {
                    continue;
                }
                emit({
                    id: `${base}.${capability.id}.${feedback.id}`,
                    type: "state",
                    common: {
                        name: feedback.id,
                        ...presentationCommon(feedback.presentation, registry, source, feedback.binding),
                        read: true,
                        write: false,
                        // Said in the description rather than the quality code:
                        // an inferred reading is not a *bad* one, and none of
                        // `STATE_QUALITY`'s substitute codes mean this without
                        // being stretched. Panels and operators read `desc`.
                        ...(feedback.inferred === true
                            ? { desc: "Inferred, not reported by the device — treat as a proxy" }
                            : {}),
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
                // holds — except a momentary one, which carries nothing.
                //
                // `set` and `toggle` publish as `button`, `type: "boolean"`,
                // `read: false`, because `power.on` is an instruction and not a
                // question. Writing the bound state's value into them anyway
                // made that declaration false the moment the binding was not
                // itself boolean: an ordinary "Laptop" button declared as
                // `{"kind": "set", "value": 3}` on a numeric input published a
                // boolean state permanently carrying 3, which js-controller
                // complains about on every publish and which every consumer
                // trusting `common.type` reads wrongly.
                const momentary = action.kind === "set" || action.kind === "toggle";
                const snapshot = momentary ? undefined : source.snapshotOf(action.binding.state);

                // The unconfirmed check belongs here and not only on feedback:
                // the failure being detected is a *control* that looks live and
                // does nothing, and for a momentary trigger the action state is
                // the only thing a panel has to look at.
                // Read from the binding, not from `snapshot`, so a momentary
                // trigger still reports an unconfirmed write. That is the whole
                // point of marking the action state: a button has no feedback,
                // so it is the only thing a panel can look at.
                const unconfirmed = source.unconfirmed(action.binding.state);

                // A feedback sharing this action's id publishes as one
                // read/write state, and the feedback branch below skips it to
                // avoid emitting it twice — so its reading has to be taken
                // here, or it is never taken at all. It was not: the merged
                // state's quality came from this branch alone, which knows only
                // about unconfirmed writes and nothing about an offline owner,
                // a value that never reported, or an unacknowledged one. A
                // routing control declared the natural way — one `route` plus a
                // same-named feedback on the same state, which the mapping
                // itself does for `display.stage.routing.video` — therefore
                // published a stale route as good quality with `healthy` true
                // while its adapter was down, which is precisely the "control
                // that looks live" failure the feedback engine exists to stop.
                // `!momentary` as well as the registry's refusal above: a
                // write-only button must never be given a value, and a guard
                // that depends on validation elsewhere is the kind that gets
                // bypassed by the next change. It already was once.
                const merged = momentary ? undefined : capability.feedback.find(f => f.id === action.id);
                const reading = merged ? read(resource.id, capability.id, merged.id, registry, source) : undefined;

                // An action state answers the health question too, and for much
                // of the mapping it is the *only* state a panel binds:
                // `atem.me1.program.source.select` is the writable one and the
                // one carrying `common.states`, while its reading lives under a
                // different id. Deriving quality from `unconfirmed` alone meant
                // that selector published a stale `3` as good while the mixer's
                // adapter was disconnected — and the reading beside it, bound to
                // the very same device state, correctly said otherwise.
                //
                // A momentary trigger gets the narrower question, because it
                // publishes no value: "never-reported" is not a fault in a
                // button, but "the adapter that owns it is down" still is.
                const reason: UnhealthyReason | undefined = merged
                    ? reading?.healthy === true
                        ? undefined
                        : reading?.unhealthy
                    : momentary
                      ? ownerOffline(resource.id, registry, source)
                          ? "owner-offline"
                          : unconfirmed
                            ? "unconfirmed"
                            : undefined
                      : snapshot
                        ? unhealthyReason(resource.id, { ...snapshot, state: action.binding.state }, registry, source)
                        : "unresolved";

                allHealthy &&= reason === undefined;

                states.push({
                    id: `${base}.${capability.id}.${action.id}`,
                    val: merged ? (reading?.raw ?? null) : (snapshot?.val ?? null),
                    ack: true,
                    q: qualityOf(reason),
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
        case "unconfirmed":
            return QUALITY.generalDeviceProblem;
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
 * @param registry - The declared resources
 * @param source - View of the object tree
 * @returns The `common` block
 */
function actionCommon(action: ActionDef, registry: Registry, source: ObjectSource): PublishedCommon {
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
                // A writable number is `level`, a writable boolean is `switch`,
                // a writable string is `text`.
                role: space.type === "number" ? "level" : space.type === "boolean" ? "switch" : "text",
                // Always readable, whatever the sibling feedback is called.
                // A write-only `level` is repochecker's E1010, and the
                // declaration would be a lie either way: `statesFor` writes the
                // device's current value into this very state on every publish,
                // so a selector whose feedback merely carries a different id
                // would be telling a panel the value it can see is not there.
                read: true,
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
                // A read-only number is `value`; `level` would fail E1010. A
                // read-only boolean is `indicator`, for the same reason.
                type: space.type,
                role: space.type === "number" ? "value" : space.type === "boolean" ? "indicator" : "text",
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
): { type: "string" | "number" | "boolean"; states?: Readonly<Record<string, string>> } {
    const declared = source.metaOf(binding.state)?.type;
    // Boolean is carried rather than collapsed into "string". Admitting only
    // two types meant a selection bound to a boolean state published
    // `type: "string"` and then had the device's `true` written into it, so
    // js-controller complained on every publish and the control rendered as a
    // free-text box over a button. That is the project's own rule — wherever a
    // device value meets a type decision, the declared type decides — reached
    // by a third entrance, after the resolver and the value coercion.
    const fallback = declared === "number" ? "number" : declared === "boolean" ? "boolean" : "string";

    if (binding.values === undefined || binding.values.kind === "identity") {
        return { type: fallback };
    }
    const resolved = optionsFor(binding, registry, source);
    if (!resolved.ok || resolved.options.length === 0) {
        return { type: fallback };
    }
    return {
        type: resolved.options.every(o => typeof o.value === "number")
            ? "number"
            : resolved.options.every(o => typeof o.value === "boolean")
              ? "boolean"
              : "string",
        states: Object.fromEntries(resolved.options.map(o => [String(o.value), o.name])),
    };
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

/**
 * What a scene is doing.
 *
 * `showcontrol` names its equivalent `fired` and labels it "Dispatched", on the
 * grounds that the cue's actions went out without throwing and that says
 * nothing about whether the show is still playing. A scene here is different:
 * it owns its own duration — delays, waits, retries — so `running` and
 * `completed` mean what they say.
 */
export type SceneStatus = "idle" | "running" | "completed" | "failed";

/**
 * Published as `common.states`, so a panel renders the status without
 * hardcoding either the value set or its wording.
 */
export const SCENE_STATUS_LABELS: Readonly<Record<SceneStatus, string>> = {
    idle: "Idle",
    running: "Running",
    completed: "Completed",
    // "Failed" covers a step that aborted; a scene whose failure was handled by
    // a fallback completes, because the fallback is the designed outcome.
    failed: "Failed",
};

/**
 * Every object a scene needs, parents included.
 *
 * A scene id may contain dots exactly as a resource id may, so
 * `presentation.start` publishes as `scenes.presentation.start` and the
 * intermediate folders are emitted here for the same E3009 reason.
 *
 * @param scenes - The validated scenes
 * @returns Objects in parent-before-child order
 */
export function sceneObjectsFor(scenes: ReadonlyArray<Scene>): ReadonlyArray<PublishedObject> {
    if (scenes.length === 0) {
        return [];
    }

    const objects: PublishedObject[] = [{ id: SCENES, type: "folder", common: { name: "Scenes" } }];
    const emitted = new Set<string>([SCENES]);
    // Same prefix collision as `objectsFor`: `show` beside `show.start` would
    // publish `scenes.show` as both a channel and a folder.
    const declared = new Set(scenes.map(scene => `${SCENES}.${scene.id}`));

    for (const scene of scenes) {
        const segments = scene.id.split(".");
        segments.slice(0, -1).forEach((_, index) => {
            const id = `${SCENES}.${segments.slice(0, index + 1).join(".")}`;
            if (!emitted.has(id) && !declared.has(id)) {
                emitted.add(id);
                objects.push({ id, type: "folder", common: { name: segments[index]! } });
            }
        });

        const base = `${SCENES}.${scene.id}`;
        emitted.add(base);
        objects.push({ id: base, type: "channel", common: { name: scene.name || scene.id } });
        objects.push({
            id: `${base}.run`,
            type: "state",
            common: {
                name: "Run",
                type: "boolean",
                // Momentary, exactly like an action: firing a scene is not a
                // question about whether it is running.
                role: "button",
                read: false,
                write: true,
                desc: "Write true to run this scene",
            },
        });
        objects.push({
            id: `${base}.status`,
            type: "state",
            common: {
                name: "Status",
                type: "string",
                role: "text",
                read: true,
                write: false,
                states: SCENE_STATUS_LABELS,
                desc: "Idle until first run; failed means a step aborted the scene",
            },
        });
    }

    return objects;
}

/**
 * Which scene a write to each published `run` state fires.
 *
 * @param scenes - The validated scenes
 * @returns Published state id to scene id
 */
export function sceneTargets(scenes: ReadonlyArray<Scene>): ReadonlyMap<string, string> {
    return new Map(scenes.map(scene => [`${SCENES}.${scene.id}.run`, scene.id]));
}

/**
 * How long each written state may take to echo back.
 *
 * Only action bindings appear: confirmation is about writes, and a feedback
 * binding is never written to.
 *
 * @param registry - The declared resources
 * @returns State id to its confirmation window
 */
export function confirmWindows(registry: Registry): ReadonlyMap<string, number> {
    const windows = new Map<string, number>();
    for (const resource of registry.allResources()) {
        for (const capability of resource.capabilities) {
            for (const action of capability.actions) {
                const withinMs = action.binding.confirmWithinMs;
                if (withinMs !== undefined && withinMs > 0) {
                    windows.set(action.binding.state, withinMs);
                }
            }
        }
    }
    return windows;
}
