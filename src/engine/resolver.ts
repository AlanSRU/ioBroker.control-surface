/**
 * The binding resolver: translates between a capability's value space and the
 * device's own, for all three `ValueSpace` forms.
 *
 * This is the function `iobroker-react` implements three times — in
 * `VenueConfig.js`, `AreaSchedulerService.js` and `MacroSchedulerService.js` —
 * because its ioBroker scripts cannot import from a React `src/`. Here it
 * exists once, and the adapter publishes the result.
 *
 * It reaches ioBroker only through `ObjectSource`, so it is pure and testable
 * without an ioBroker running.
 */

import type { ResourceCollection, StateBinding, StateId, ValueSpace } from "../model.ts";
import type { Registry } from "./registry.ts";

/** Anything an ioBroker state can hold that this layer cares about. */
export type StateValue = string | number | boolean;

/** One choice offered by a value space. */
export interface ValueOption {
    /** What a person sees. */
    readonly name: string;
    /** What gets written to the device. */
    readonly value: StateValue;
}

/**
 * The engine's view of the ioBroker object tree. Deliberately tiny: three reads,
 * no writes, no subscriptions.
 *
 * Every method returns `undefined` for "not known", which is distinct from an
 * empty result. `blackmagic-atem` rebuilds its tree from the detected model, so
 * a binding may be unresolved without that being an error.
 */
export interface ObjectSource {
    /** The `common` fields this layer reads, or undefined when no such object. */
    metaOf(state: StateId): StateMeta | undefined;
    /** Object ids matching a members pattern, or undefined when unknown. */
    membersOf(pattern: string): ReadonlyArray<StateId> | undefined;
    /** Current value of a state, or undefined when it does not exist. */
    valueOf(state: StateId): StateValue | undefined;
}

/** The parts of an ioBroker object's `common` the resolver needs. */
export interface StateMeta {
    /** `common.type`. Decides how a `common.states` key is read back. */
    readonly type?: string;
    /** `common.states`, device value -> label. */
    readonly states?: Readonly<Record<string, string>>;
}

/** Why a value space could not be resolved. Not an error condition. */
export type Unresolved =
    /** The bound object does not exist, or publishes no `common.states`. */
    | { readonly reason: "no-object-states"; readonly state: StateId }
    /** The collection is declared but its members are not in the tree yet. */
    | { readonly reason: "no-members"; readonly collection: string }
    /** The binding names a collection the registry does not hold. */
    | { readonly reason: "unknown-collection"; readonly collection: string };

export type Options = { readonly ok: true; readonly options: ReadonlyArray<ValueOption> } | ({ readonly ok: false } & Unresolved);

/**
 * Lists the choices a binding offers.
 *
 * @param binding - The binding whose value space to resolve
 * @param registry - Registry holding any referenced collection
 * @param source - View of the object tree
 * @returns The options, or why they are not available yet
 */
export function optionsFor(binding: StateBinding, registry: Registry, source: ObjectSource): Options {
    const space: ValueSpace = binding.values ?? { kind: "identity" };

    switch (space.kind) {
        case "identity":
            // A free value space offers no menu; a slider has no option list.
            return { ok: true, options: [] };

        case "table":
            return { ok: true, options: space.entries.map(e => ({ name: e.name, value: e.value })) };

        case "objectStates": {
            const meta = source.metaOf(binding.state);
            if (!meta?.states) {
                return { ok: false, reason: "no-object-states", state: binding.state };
            }
            // `common.states` is device value -> label, which is the opposite
            // way round from how it reads.
            return {
                ok: true,
                options: Object.entries(meta.states).map(([value, name]) => ({
                    name,
                    value: coerce(value, meta.type),
                })),
            };
        }

        case "resourceIds": {
            const collection = registry.getCollection(space.collection);
            if (!collection) {
                return { ok: false, reason: "unknown-collection", collection: space.collection };
            }
            const members = source.membersOf(collection.members);
            if (!members) {
                return { ok: false, reason: "no-members", collection: space.collection };
            }
            return { ok: true, options: members.map(m => memberOption(m, collection, source)) };
        }
    }
}

/**
 * Reads one collection member's value and display name.
 *
 * @param member - Full object id of the member
 * @param collection - The collection it belongs to
 * @param source - View of the object tree
 * @returns The option this member contributes
 */
function memberOption(member: StateId, collection: ResourceCollection, source: ObjectSource): ValueOption {
    const segment = member.slice(member.lastIndexOf(".") + 1);

    // The id segment is not the value in general: an ACM transmitter is
    // `transmitters.007` and routes as `007`, but an ATEM input is
    // `inputs.input3` and routes as `3`. Fall back to the segment only when no
    // `valueState` is declared.
    const value = collection.valueState !== undefined
        ? source.valueOf(`${member}.${collection.valueState}`) ?? segment
        : segment;

    const name = collection.nameState !== undefined
        ? source.valueOf(`${member}.${collection.nameState}`)
        : undefined;

    return { name: name === undefined || name === "" ? String(value) : String(name), value };
}

/**
 * Turns a semantic choice into the value to write.
 *
 * @param binding - The binding being written
 * @param name - Semantic name, or a raw value for an identity space
 * @param registry - Registry holding any referenced collection
 * @param source - View of the object tree
 * @returns The device value, or undefined when the name is not offered
 */
export function toDevice(
    binding: StateBinding,
    name: StateValue,
    registry: Registry,
    source: ObjectSource,
): StateValue | undefined {
    const space = binding.values ?? { kind: "identity" };
    if (space.kind === "identity") {
        return name;
    }

    const resolved = optionsFor(binding, registry, source);
    if (!resolved.ok) {
        return undefined;
    }

    // Accept either the semantic name or the device value itself. A panel that
    // already knows the device value should not be forced to round-trip it.
    const wanted = String(name);
    const match =
        resolved.options.find(o => o.name === wanted) ?? resolved.options.find(o => String(o.value) === wanted);
    return match?.value;
}

/**
 * Turns a device value into the semantic name to display.
 *
 * @param binding - The binding being read
 * @param value - Value as reported by the device
 * @param registry - Registry holding any referenced collection
 * @param source - View of the object tree
 * @returns The semantic name, or undefined when the value is not in the space
 */
export function toSemantic(
    binding: StateBinding,
    value: StateValue,
    registry: Registry,
    source: ObjectSource,
): string | undefined {
    const space = binding.values ?? { kind: "identity" };
    if (space.kind === "identity") {
        return String(value);
    }

    const resolved = optionsFor(binding, registry, source);
    if (!resolved.ok) {
        return undefined;
    }
    return resolved.options.find(o => String(o.value) === String(value))?.name;
}

/**
 * Narrows a `common.states` key to the type the bound state actually declares.
 *
 * Keys are always strings because they are object keys, but the state often is
 * not — the iiyama publishes `inputSource` as a number, so comparing "1" to 1
 * would fail every lookup.
 *
 * The type must decide this, never the look of the key. The Blustream C66
 * publishes a **string** `output.<N>.source` whose states are zero-padded
 * (`{'01': 'HDMI 1', … '06': 'HDMI 6'}`); reading "01" as the number 1 sends a
 * value the device does not accept, and that is a live bug in the production
 * venue system rather than a hypothetical.
 *
 * @param raw - The key as it appears in `common.states`
 * @param type - `common.type` of the bound state
 * @returns The key narrowed to the declared type
 */
function coerce(raw: string, type: string | undefined): StateValue {
    switch (type) {
        case "number":
            return Number.isFinite(Number(raw)) ? Number(raw) : raw;
        case "boolean":
            return raw === "true";
        default:
            return raw;
    }
}
