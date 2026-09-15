/**
 * The binding resolver: translates between a capability's value space and the
 * device's own, for all four `ValueSpace` forms.
 *
 * This is the function `iobroker-react` implements three times — in
 * `VenueConfig.js`, `AreaSchedulerService.js` and `MacroSchedulerService.js` —
 * because its ioBroker scripts cannot import from a React `src/`. Here it
 * exists once, and the adapter publishes the result.
 *
 * It reaches ioBroker only through `ObjectSource`, so it is pure and testable
 * without an ioBroker running.
 */

import type { JsonListSpace, ResourceCollection, StateBinding, StateId, StateValue, ValueSpace } from "../model";
import type { Registry } from "./registry";

export type { StateValue };

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
    /** Current state, or undefined when no such state exists. */
    snapshotOf(state: StateId): StateSnapshot | undefined;
    /**
     * Whether a write to this state was accepted and never echoed back.
     *
     * Lives here rather than being threaded through every read because it is
     * part of the same question `snapshotOf` answers: what is true of this state
     * right now.
     */
    unconfirmed(state: StateId): boolean;
}

/**
 * An ioBroker state as read back.
 *
 * `ack` is load-bearing rather than incidental: `true` means the device or its
 * adapter is reporting, `false` means someone wrote a command that has not been
 * confirmed. Feedback that ignores the difference presents an intention as a
 * fact.
 */
export interface StateSnapshot {
    /** null when the state exists but has never carried a value. */
    readonly val: StateValue | null;
    readonly ack: boolean;
    /** Milliseconds since the epoch; 0 when never reported. */
    readonly ts: number;
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
    | { readonly reason: "unknown-collection"; readonly collection: string }
    /**
     * The binding declares a value space this resolver does not know.
     *
     * `Registry.load` rejects one, so reaching this means a form was added to
     * the model without being added here. It is a reported refusal rather than
     * a fall through the end of the switch, because the latter returned
     * `undefined` to callers that immediately read `.ok` — which threw out of
     * the first `publish()` that `onReady` awaits, so nothing was published at
     * all and js-controller restarted into the same configuration.
     */
    | { readonly reason: "unknown-value-space"; readonly kind: string }
    /**
     * The JSON document is missing, empty, unparseable, or its path does not
     * lead to an array.
     *
     * One reason rather than four on purpose. Every one of them means the same
     * thing to a caller — the menu is not available yet — and `streamdeck`
     * publishes `layoutJson` with `def: ""`, so an unconfigured deck is
     * indistinguishable from an absent one anyway.
     */
    | { readonly reason: "no-json-list"; readonly state: StateId };

export type Options =
    | {
          readonly ok: true;
          readonly options: ReadonlyArray<ValueOption>;
      }
    | ({
          readonly ok: false;
      } & Unresolved);

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

        case "jsonList": {
            const list = listIn(source.snapshotOf(space.state)?.val, space.path);
            if (!list) {
                return { ok: false, reason: "no-json-list", state: space.state };
            }
            // No `coerce` here, and none is needed: JSON carries its own types,
            // so the C66 trap — a zero-padded string key read back as a number
            // — cannot arise. "01" parses as the string it is.
            return { ok: true, options: list.map(e => jsonOption(e, space)).filter(o => o !== undefined) };
        }

        default:
            // Unreachable while the registry and this switch agree. Kept
            // because the cost of them disagreeing is not a bad menu, it is an
            // adapter that never starts.
            return { ok: false, reason: "unknown-value-space", kind: String((space as { kind: unknown }).kind) };
    }
}

/**
 * Walks a dotted path into a parsed JSON document and returns the array there.
 *
 * @param raw - The state's value, expected to be a JSON string
 * @param path - Dotted path to the array, or undefined for the document root
 * @returns The array, or undefined when there is not one at that path
 */
function listIn(raw: StateValue | null | undefined, path: string | undefined): ReadonlyArray<unknown> | undefined {
    // `role: 'json'` states are strings. Anything else is not this shape.
    if (typeof raw !== "string" || raw === "") {
        return undefined;
    }

    let node: unknown;
    try {
        node = JSON.parse(raw);
    } catch {
        // A half-written layout is a runtime condition, not an error: the
        // editor is mid-save and the next acknowledged value will parse.
        return undefined;
    }

    for (const segment of path === undefined || path === "" ? [] : path.split(".")) {
        if (typeof node !== "object" || node === null) {
            return undefined;
        }
        node = (node as Record<string, unknown>)[segment];
    }

    return Array.isArray(node) ? node : undefined;
}

/**
 * Reads one list element's value and display name.
 *
 * @param element - One element of the resolved array
 * @param space - The value space that named it
 * @returns The option, or undefined when the element carries no usable value
 */
function jsonOption(element: unknown, space: JsonListSpace): ValueOption | undefined {
    const raw = space.valueKey === undefined ? element : readKey(element, space.valueKey);
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
        // An element that yields no scalar cannot be written to a state, so it
        // is not offered. Inventing an option would put a value in a menu that
        // the device would refuse.
        return undefined;
    }

    const name = space.nameKey === undefined ? undefined : readKey(element, space.nameKey);
    return { name: typeof name === "string" && name !== "" ? name : String(raw), value: raw };
}

/**
 * Reads one property off a list element.
 *
 * @param element - The element, which need not be an object
 * @param key - Property name
 * @returns The property, or undefined
 */
function readKey(element: unknown, key: string): unknown {
    return typeof element === "object" && element !== null ? (element as Record<string, unknown>)[key] : undefined;
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
    const value =
        collection.valueState !== undefined
            ? (source.snapshotOf(`${member}.${collection.valueState}`)?.val ?? segment)
            : segment;

    const name =
        collection.nameState !== undefined ? source.snapshotOf(`${member}.${collection.nameState}`)?.val : undefined;

    return { name: name === undefined || name === null || name === "" ? String(value) : String(name), value };
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
