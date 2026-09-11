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

import type {
    ActionDef,
    Capability,
    FeedbackDef,
    Resource,
    ResourceCollection,
    ResourceId,
    StateId,
} from "../model.ts";

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
 */
const VALID_SEMANTIC_ID = /^[^*\s[\]]+$/;

/** Published as `resources.<id>.healthy`, so no capability may take the name. */
export const RESERVED_CAPABILITY = "healthy";

/** Rejects `a..b`, a leading `.` and a trailing `.`, which make empty segments. */
const EMPTY_SEGMENT = /(^\.)|(\.\.)|(\.$)/;

function idProblem(id: string): string | null {
    if (!id) {
        return "has no id";
    }
    if (!VALID_SEMANTIC_ID.test(id)) {
        return `"${id}" may not contain spaces, *, [ or ]`;
    }
    if (EMPTY_SEGMENT.test(id)) {
        return `"${id}" has an empty path segment`;
    }
    return null;
}

export class Registry {
    // Written out rather than declared as constructor parameter properties:
    // those emit code, so Node's type stripping cannot run this file.
    private readonly resources: ReadonlyMap<ResourceId, Resource>;
    private readonly collections: ReadonlyMap<ResourceId, ResourceCollection>;
    private readonly states: ReadonlySet<StateId>;

    private constructor(
        resources: ReadonlyMap<ResourceId, Resource>,
        collections: ReadonlyMap<ResourceId, ResourceCollection>,
        states: ReadonlySet<StateId>,
    ) {
        this.resources = resources;
        this.collections = collections;
        this.states = states;
    }

    /**
     * Validates declarations and indexes what survives.
     *
     * @param resources - Declared resources
     * @param collections - Declared runtime collections
     * @returns The registry, plus one problem per rejected declaration
     */
    static load(
        resources: ReadonlyArray<Resource>,
        collections: ReadonlyArray<ResourceCollection>,
    ): RegistryLoad {
        const problems: RegistryProblem[] = [];
        const byId = new Map<ResourceId, Resource>();
        const collectionsById = new Map<ResourceId, ResourceCollection>();

        for (const collection of collections) {
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
        for (const resource of byId.values()) {
            for (const capability of resource.capabilities) {
                for (const action of capability.actions) {
                    states.add(action.binding.state);
                }
                for (const feedback of capability.feedback) {
                    states.add(feedback.binding.state);
                }
            }
        }

        return { registry: new Registry(byId, collectionsById, states), problems };
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
     * Every state worth subscribing to: the declared bindings, plus the owner
     * connection states health is derived from.
     *
     * Deliberately wider than `permits()`. Reading the connection flag of an
     * adapter already named as an owner is within the whitelist's purpose;
     * making it *writable* would not be.
     */
    observedStates(): ReadonlySet<StateId> {
        const observed = new Set<StateId>(this.states);
        for (const resource of this.resources.values()) {
            observed.add(`${resource.owner}.info.connection`);
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
        const named = [
            ...capability.actions.map(a => ["action", a.id] as const),
            ...capability.feedback.map(f => ["feedback", f.id] as const),
        ];
        const dotted = [["capability", capability.id] as const, ...named].filter(([, id]) => id.includes("."));
        for (const [what, id] of dotted) {
            problems.push({ where, reason: `${what} id "${id}" may not contain a dot` });
        }
        if (dotted.length > 0) {
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
            if (action.kind === "level" && action.min >= action.max) {
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

    const values = binding.values as { kind?: string; collection?: string; entries?: unknown[] } | undefined;
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

    return problems;
}
