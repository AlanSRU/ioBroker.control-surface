/**
 * The resource registry: the declared set of resources, and the only set of
 * states this layer will ever touch.
 *
 * `boundStates()` is not a convenience. It is decision 2 made executable — the
 * registry is the authorization boundary, so a state that no declaration names
 * has no runtime path into the engine. `permits()` is the check every write
 * goes through.
 *
 * Bad declarations are dropped individually rather than failing the whole load,
 * following `iobroker.showcontrol`'s `parseCues` for the same reason: these run
 * live events, and one malformed row should not take a venue's remaining
 * resources down with it.
 */

import type { ActionDef, Capability, FeedbackDef, Resource, ResourceCollection, ResourceId, StateId } from "../model";

/** One rejected declaration, with enough context to fix it. */
export interface RegistryProblem {
    /** Which resource, capability or member was rejected. */
    readonly where: string;
    /** Why, phrased for the log. */
    readonly reason: string;
}

export interface RegistryLoad {
    readonly registry: Registry;
    readonly problems: ReadonlyArray<RegistryProblem>;
}

/**
 * Semantic ids become ioBroker object ids once published, so they inherit its
 * charset rules. A `.` is allowed and means a tree level — `display.lobby`
 * publishes as `resources.display.lobby`.
 *
 * This is js-controller's own `FORBIDDEN_CHARS` allowlist
 * (`@iobroker/adapter-core`'s `tools.js`) with the space removed, because a
 * space is legal there and still a bad idea in an id a person has to type.
 *
 * It has to be the *same* set, not merely a strict one. Anything outside it is
 * rewritten to `_` by `fixForbiddenCharsInId` on the way into `extendObject`
 * and `setState`, while `writeTargets()` keys its map with the id as declared.
 * A resource called `room1,matrix` therefore publishes a control at
 * `room1_matrix`, a panel writes to the only state that exists, the lookup in
 * `onStateChange` misses, and the button does nothing at all — with no refusal
 * logged, because as far as the engine is concerned nothing was ever invoked.
 */
const VALID_SEMANTIC_ID = /^[._\-/:!#$%&()+=@^{}|~\p{Ll}\p{Lu}\p{Nd}]+$/u;

/** Published as `resources.<id>.healthy`, so no capability may take the name. */
export const RESERVED_CAPABILITY = "healthy";

/**
 * The action kinds the engine can dispatch on.
 *
 * Closed, unlike capability and resource *type* ids, which are deliberately an
 * open vocabulary. A kind is not a label: every switch in the action engine and
 * the publisher dispatches on it, so one the code does not know is not an
 * extension point, it is a state that never gets created and a write that
 * throws.
 */
const ACTION_KINDS = new Set(["set", "toggle", "level", "select", "route"]);

/** The presentations the publisher knows how to type and give a role to. */
const PRESENTATIONS = new Set(["boolean", "number", "text", "selection"]);

/** What a device state can hold, so what a declared `set` value may be. */
const SCALARS = new Set(["boolean", "number", "string"]);

/** Rejects `a..b`, a leading `.` and a trailing `.`, which make empty segments. */
const EMPTY_SEGMENT = /(^\.)|(\.\.)|(\.$)/;

/**
 * Checks an id that will become an ioBroker object id.
 *
 * Exported because scenes are published into the same tree and inherit exactly
 * the same constraints.
 *
 * @param id - The semantic id to check
 * @returns Why it is unusable, or null
 */
export function idProblem(id: string): string | null {
    if (!id) {
        return "has no id";
    }
    if (!VALID_SEMANTIC_ID.test(id)) {
        return (
            `"${id}" contains a character ioBroker would rewrite: use letters, ` +
            `digits and . _ - / : ! # $ % & ( ) + = @ ^ { } | ~`
        );
    }
    if (EMPTY_SEGMENT.test(id)) {
        return `"${id}" has an empty path segment`;
    }
    return null;
}

/**
 * Whether a declaration is an object at all.
 *
 * @param value - Anything that arrived from the configuration
 * @returns True when it can be indexed safely
 */
function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/**
 * Checks a resource has the shape its type claims, before anything indexes it.
 *
 * Declarations arrive as hand-written JSON through an admin textarea with no
 * schema and are **cast**, not parsed, so the compiler has guaranteed nothing
 * about them. Every omission below is an ordinary first-day authoring mistake —
 * a capability written with only `feedback` and no `actions: []`, an action with
 * no `binding` — and each one used to throw a `TypeError` out of `Registry.load`
 * and therefore out of `onReady`. js-controller turns that into a restart, with
 * the same configuration, so the instance died in a loop until someone found the
 * textarea. A declaration that cannot be read is a *problem*, exactly like a bad
 * id: reported, skipped, and the rest of the venue keeps working.
 *
 * @param resource - The declared resource, as it came from the configuration
 * @returns Why it cannot be read, or null
 */
function shapeProblem(resource: unknown): string | null {
    if (!isObject(resource)) {
        return "is not an object";
    }
    if (typeof resource.id !== "string") {
        return "has no id";
    }
    const where = `"${resource.id}"`;
    if (!Array.isArray(resource.capabilities)) {
        return `${where} has no capabilities array`;
    }

    for (const capability of resource.capabilities) {
        if (!isObject(capability) || typeof capability.id !== "string") {
            return `${where} has a capability that is not an object with an id`;
        }
        // Both are required even when empty: a read-only capability still needs
        // `actions: []`, because everything downstream iterates both.
        for (const key of ["actions", "feedback"] as const) {
            if (!Array.isArray(capability[key])) {
                return `${where} capability "${capability.id}" has no ${key} array`;
            }
            for (const entry of capability[key]) {
                if (!isObject(entry) || typeof entry.id !== "string") {
                    return `${where} capability "${capability.id}" has a ${key} entry with no id`;
                }
                if (!isObject(entry.binding) || typeof entry.binding.state !== "string") {
                    return `${where} capability "${capability.id}" ${key} "${entry.id}" has no binding state`;
                }
            }
        }
    }

    return null;
}

export class Registry {
    // Written out rather than declared as constructor parameter properties:
    // those emit code, so Node's type stripping cannot run this file.
    private readonly resources: ReadonlyMap<ResourceId, Resource>;
    private readonly collections: ReadonlyMap<ResourceId, ResourceCollection>;
    private readonly states: ReadonlySet<StateId>;
    /** States named by a `jsonList` value space: read for options, never written. */
    private readonly documents: ReadonlySet<StateId>;

    private constructor(
        resources: ReadonlyMap<ResourceId, Resource>,
        collections: ReadonlyMap<ResourceId, ResourceCollection>,
        states: ReadonlySet<StateId>,
        documents: ReadonlySet<StateId>,
    ) {
        this.resources = resources;
        this.collections = collections;
        this.states = states;
        this.documents = documents;
    }

    /**
     * Validates declarations and indexes what survives.
     *
     * @param resources - Declared resources
     * @param collections - Declared runtime collections
     * @returns The registry, plus one problem per rejected declaration
     */
    static load(resources: ReadonlyArray<Resource>, collections: ReadonlyArray<ResourceCollection>): RegistryLoad {
        const problems: RegistryProblem[] = [];
        const byId = new Map<ResourceId, Resource>();
        const collectionsById = new Map<ResourceId, ResourceCollection>();

        for (const collection of collections) {
            if (!isObject(collection) || typeof collection.members !== "string") {
                problems.push({ where: "collection", reason: "is not an object with a string members pattern" });
                continue;
            }
            const problem = idProblem(collection.id);
            if (problem) {
                problems.push({ where: "collection", reason: problem });
                continue;
            }
            if (collectionsById.has(collection.id)) {
                problems.push({ where: `collection "${collection.id}"`, reason: "duplicate id" });
                continue;
            }
            if (!collection.members.includes("*")) {
                problems.push({
                    where: `collection "${collection.id}"`,
                    reason: `members pattern "${collection.members}" matches nothing without a *`,
                });
                continue;
            }
            collectionsById.set(collection.id, collection);
        }

        for (const resource of resources) {
            const shape = shapeProblem(resource);
            if (shape) {
                problems.push({ where: "resource", reason: shape });
                continue;
            }
            const problem = idProblem(resource.id);
            if (problem) {
                problems.push({ where: "resource", reason: problem });
                continue;
            }
            if (byId.has(resource.id) || collectionsById.has(resource.id)) {
                problems.push({ where: `resource "${resource.id}"`, reason: "duplicate id" });
                continue;
            }
            const capabilityProblems = validateCapabilities(resource, collectionsById);
            if (capabilityProblems.length > 0) {
                problems.push(...capabilityProblems);
                continue;
            }
            byId.set(resource.id, resource);
        }

        const states = new Set<StateId>();
        const documents = new Set<StateId>();
        for (const resource of byId.values()) {
            for (const capability of resource.capabilities) {
                for (const binding of [
                    ...capability.actions.map(a => a.binding),
                    ...capability.feedback.map(f => f.binding),
                ]) {
                    states.add(binding.state);
                    // The document a `jsonList` reads is a *source of options*,
                    // not a binding. It goes in the observed set, never the
                    // writable one — the same asymmetry as owner connection
                    // states, for the same reason.
                    if (binding.values?.kind === "jsonList") {
                        documents.add(binding.values.state);
                    }
                }
            }
        }

        return { registry: new Registry(byId, collectionsById, states, documents), problems };
    }

    getResource(id: ResourceId): Resource | undefined {
        return this.resources.get(id);
    }

    getCollection(id: ResourceId): ResourceCollection | undefined {
        return this.collections.get(id);
    }

    getCapability(resource: ResourceId, capability: string): Capability | undefined {
        return this.resources.get(resource)?.capabilities.find(c => c.id === capability);
    }

    getAction(resource: ResourceId, capability: string, action: string): ActionDef | undefined {
        return this.getCapability(resource, capability)?.actions.find(a => a.id === action);
    }

    getFeedback(resource: ResourceId, capability: string, feedback: string): FeedbackDef | undefined {
        return this.getCapability(resource, capability)?.feedback.find(f => f.id === feedback);
    }

    allResources(): ReadonlyArray<Resource> {
        return [...this.resources.values()];
    }

    /**
     * Every state any declaration binds to — the whitelist. Nothing outside this
     * set is subscribed, read or written.
     */
    boundStates(): ReadonlySet<StateId> {
        return this.states;
    }

    /**
     * Whether a state may be **written**. Collection member states are excluded
     * deliberately: they are discovered by pattern at runtime, so they are
     * resolved through `ObjectSource`, never written.
     *
     * @param state
     */
    permits(state: StateId): boolean {
        return this.states.has(state);
    }

    /**
     * Where a resource's owning adapter reports whether it is connected.
     *
     * Derived from `Resource.owner` rather than declared, because
     * `<instance>.info.connection` is an ioBroker convention that costs nothing
     * to try and that most adapters honour. An adapter that does not publish it
     * simply reads as unknown — never as offline, which would mark every one of
     * its resources unhealthy for following a different convention.
     *
     * @param resource - Semantic resource id
     * @returns The connection state id, or undefined for an unknown resource
     */
    ownerConnection(resource: ResourceId): StateId | undefined {
        const owner = this.resources.get(resource)?.owner;
        return owner === undefined ? undefined : `${owner}.info.connection`;
    }

    /**
     * Every state worth subscribing to: the declared bindings, the owner
     * connection states health is derived from, and the JSON documents
     * `jsonList` value spaces read their options out of.
     *
     * Deliberately wider than `permits()`. Reading the connection flag of an
     * adapter already named as an owner is within the whitelist's purpose;
     * making it *writable* would not be. A deck's `layoutJson` is the same
     * case — the page menu has to refresh when the layout is re-authored, and
     * nothing here may ever write a layout back.
     */
    observedStates(): ReadonlySet<StateId> {
        const observed = new Set<StateId>(this.states);
        for (const resource of this.resources.values()) {
            observed.add(`${resource.owner}.info.connection`);
        }
        for (const document of this.documents) {
            observed.add(document);
        }
        return observed;
    }
}

/**
 * Checks one resource's capabilities.
 *
 * @param resource - The resource being validated
 * @param collections - Collections already accepted, for `resourceIds` lookups
 * @returns One problem per fault; empty when the resource is usable
 */
function validateCapabilities(
    resource: Resource,
    collections: ReadonlyMap<ResourceId, ResourceCollection>,
): RegistryProblem[] {
    const problems: RegistryProblem[] = [];
    const where = `resource "${resource.id}"`;
    const seenCapabilities = new Set<string>();

    for (const capability of resource.capabilities) {
        if (seenCapabilities.has(capability.id)) {
            problems.push({ where, reason: `duplicate capability "${capability.id}"` });
            continue;
        }
        if (capability.id === RESERVED_CAPABILITY) {
            problems.push({
                where,
                reason: `capability "${RESERVED_CAPABILITY}" is reserved for the published health state`,
            });
            continue;
        }
        seenCapabilities.add(capability.id);

        // Capability, action and feedback ids become single path segments under
        // the resource, so a dot in one would silently create a tree level and
        // make the published id ambiguous to split back apart.
        //
        // The charset matters here for exactly the reason it matters on a
        // resource id, and checking only the dot was not enough: these are
        // published segments too, so a capability called `音量` or an action
        // called `pre'set` is rewritten by `fixForbiddenCharsInId` on the way
        // into `extendObject` while `writeTargets()` keeps the id as declared —
        // and the control is silently dead. Any script outside the controller's
        // allowlist does it, not just punctuation.
        const named = [
            ...capability.actions.map(a => ["action", a.id] as const),
            ...capability.feedback.map(f => ["feedback", f.id] as const),
        ];
        const segments = [["capability", capability.id] as const, ...named];
        const badSegments = segments.filter(([, id]) => id.includes(".") || idProblem(id) !== null);
        for (const [what, id] of badSegments) {
            problems.push({
                where,
                reason: id.includes(".") ? `${what} id "${id}" may not contain a dot` : `${what} id ${idProblem(id)}`,
            });
        }
        if (badSegments.length > 0) {
            continue;
        }

        // An action and a feedback may share an id — `routing.video` is both the
        // route and the reading of it — and they then publish as one read/write
        // state. That only works if they name the same device state.
        for (const action of capability.actions) {
            const twin = capability.feedback.find(f => f.id === action.id);
            if (twin && twin.binding.state !== action.binding.state) {
                problems.push({
                    where,
                    reason:
                        `"${capability.id}.${action.id}" is both an action and a feedback but binds two different ` +
                        `states ("${action.binding.state}" and "${twin.binding.state}"); give one of them another id`,
                });
            }
        }

        const seenActions = new Set<string>();
        for (const action of capability.actions) {
            if (seenActions.has(action.id)) {
                problems.push({ where, reason: `duplicate action "${capability.id}.${action.id}"` });
            }
            seenActions.add(action.id);
            if (!ACTION_KINDS.has(action.kind)) {
                // An unknown kind falls off the end of every switch that
                // dispatches on it: the publisher returns undefined for its
                // `common`, so the object is never created while `statesFor`
                // writes a value to the id anyway, and invoking it throws.
                problems.push({
                    where,
                    reason: `action "${capability.id}.${action.id}" has unknown kind "${String(action.kind)}"`,
                });
            }
            if (action.kind === "set" && !SCALARS.has(typeof action.value)) {
                // A `set` carries its value in the declaration, and `valueFor`
                // hands it straight back. Omitted, it reached the device as
                // `{val: undefined}` — which js-controller does not refuse,
                // because its guard only rejects a state object with no keys at
                // all — while `plan` reported the write as a success.
                problems.push({
                    where,
                    reason: `action "${capability.id}.${action.id}" is a set with no value to write`,
                });
            }
            if (
                action.kind === "level" &&
                action.step !== undefined &&
                !(typeof action.step === "number" && Number.isFinite(action.step) && action.step > 0)
            ) {
                // `step <= 0` is false for a string, so `"step": "half"` passed
                // and `quantise` divided by it: NaN, sent to the device.
                problems.push({
                    where,
                    reason: `action "${capability.id}.${action.id}" has a step that is not a positive number`,
                });
            }
            if (action.kind === "level" && !(typeof action.min === "number" && typeof action.max === "number")) {
                // Checked by type, not by comparison. `undefined >= undefined`
                // is false, so a level with no bounds passed the min/max test,
                // published with no min/max, and then `quantise` returned
                // `Math.min(undefined, …)` — NaN — which `plan` reported as a
                // successful write and sent to live equipment as null.
                problems.push({
                    where,
                    reason: `action "${capability.id}.${action.id}" is a level without numeric min and max`,
                });
            } else if (action.kind === "level" && action.min >= action.max) {
                problems.push({
                    where,
                    reason: `action "${capability.id}.${action.id}" has min >= max`,
                });
            }
            problems.push(...bindingProblems(where, `${capability.id}.${action.id}`, action.binding, collections));
        }

        const seenFeedback = new Set<string>();
        for (const feedback of capability.feedback) {
            if (seenFeedback.has(feedback.id)) {
                problems.push({ where, reason: `duplicate feedback "${capability.id}.${feedback.id}"` });
            }
            seenFeedback.add(feedback.id);
            if (!PRESENTATIONS.has(feedback.presentation)) {
                // Without a presentation the publisher has no type and no role
                // to give the state, so it publishes one with neither — which
                // js-controller's strict object check rejects on every write.
                problems.push({
                    where,
                    reason:
                        `feedback "${capability.id}.${feedback.id}" has unknown presentation ` +
                        `"${String(feedback.presentation)}"`,
                });
            }
            problems.push(...bindingProblems(where, `${capability.id}.${feedback.id}`, feedback.binding, collections));
        }
    }

    return problems;
}

/**
 * Checks one binding's state id and value space.
 *
 * @param where - Resource label for the problem report
 * @param what - Capability-scoped name of the action or feedback
 * @param binding - The binding to check
 * @param binding.state
 * @param binding.values
 * @param collections - Collections already accepted
 * @returns One problem per fault; empty when the binding is usable
 */
function bindingProblems(
    where: string,
    what: string,
    binding: { readonly state: StateId; readonly values?: unknown },
    collections: ReadonlyMap<ResourceId, ResourceCollection>,
): RegistryProblem[] {
    const problems: RegistryProblem[] = [];

    // A foreign state id is `adapter.instance.path`, so it always has a dot.
    // This catches a semantic id written where a device id belongs.
    if (!binding.state.includes(".")) {
        problems.push({ where, reason: `"${what}" binds to "${binding.state}", which is not a full state id` });
    }

    const values = binding.values as
        { kind?: string; collection?: string; entries?: unknown[]; state?: string } | undefined;
    if (values?.kind === "jsonList") {
        // Checked here rather than left to resolve as "no document": a state id
        // that is missing or semantic can never resolve, so it is a
        // configuration fault and belongs on the same side of the line as an
        // unknown collection.
        if (!values.state || !values.state.includes(".")) {
            problems.push({
                where,
                reason: `"${what}" reads options from "${String(values.state)}", which is not a full state id`,
            });
        }
    }
    if (values?.kind === "resourceIds") {
        if (!values.collection || !collections.has(values.collection)) {
            problems.push({
                where,
                reason: `"${what}" references unknown collection "${String(values.collection)}"`,
            });
        }
    }
    if (values?.kind === "table" && (!values.entries || values.entries.length === 0)) {
        problems.push({ where, reason: `"${what}" declares an empty value table` });
    }

    // The one configured duration that reaches a timer outside a scene.
    // `scheduleConfirmCheck` passes it to `setTimeout`, whose validator throws
    // on a non-number — and it throws *before* the write, so a quoted
    // `"confirmWithinMs": "1500"` means the device is never written at all and
    // every press of that control only logs a type error.
    const withinMs = (binding as { readonly confirmWithinMs?: unknown }).confirmWithinMs;
    if (withinMs !== undefined && (typeof withinMs !== "number" || !Number.isFinite(withinMs) || withinMs < 0)) {
        problems.push({
            where,
            reason: `"${what}" has a confirmWithinMs of ${JSON.stringify(withinMs)}, which is not a duration`,
        });
    }

    return problems;
}
