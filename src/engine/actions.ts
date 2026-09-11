/**
 * The action engine: turns an `ActionInvocation` into the writes that carry it
 * out, or into a reason it will not.
 *
 * It plans rather than writes. Everything here is pure — the object tree arrives
 * through `ObjectSource` and the result is a description — so the whole engine
 * is testable without an ioBroker, and the adapter keeps the only code that
 * touches live equipment.
 *
 * Two rules it will not bend:
 *
 *  1. **Every write is checked against the registry.** By construction an
 *     `ActionDef` came from the registry and so is already permitted, but the
 *     check stays: this writes to live AV equipment mid-show, and a bug that
 *     lets it address an undeclared state should fail closed rather than land.
 *  2. **Writes are never acknowledged.** `ack: true` means "this is the device
 *     reporting", and adapters ignore it as a command — `showcontrol` returns
 *     immediately on `state.ack`, so an acked write is silently swallowed.
 */

import type { ActionDef, ActionInvocation, StateId } from "../model.ts";
import type { ObjectSource, StateValue } from "./resolver.ts";
import { optionsFor, toDevice } from "./resolver.ts";
import type { Registry } from "./registry.ts";

/** One write the executor should perform. */
export interface StateWrite {
    readonly state: StateId;
    readonly value: StateValue;
    /** Always false. A command must be unacknowledged to be seen as a command. */
    readonly ack: false;
}

/** Why an invocation produced no writes. None of these are exceptions. */
export type Refusal =
    | { readonly reason: "unknown-resource"; readonly resource: string }
    | { readonly reason: "unknown-capability"; readonly capability: string }
    | { readonly reason: "unknown-action"; readonly action: string }
    /** The action takes a value and none was supplied. */
    | { readonly reason: "value-required" }
    /** The value is not in the capability's value space. */
    | { readonly reason: "value-rejected"; readonly value: StateValue }
    /** The bound state does not exist yet, or has never reported. */
    | { readonly reason: "unresolved"; readonly state: StateId }
    /** A level action was given something that is not a number. */
    | { readonly reason: "not-numeric"; readonly value: StateValue }
    /** Defence in depth: the plan tried to leave the declared whitelist. */
    | { readonly reason: "not-permitted"; readonly state: StateId };

export type Plan =
    | { readonly ok: true; readonly writes: ReadonlyArray<StateWrite> }
    | ({ readonly ok: false } & Refusal);

/**
 * Works out what an invocation should write.
 *
 * @param invocation - What the caller asked for
 * @param registry - The declared resources
 * @param source - View of the object tree, for value spaces and current values
 * @returns The writes to perform, or why there are none
 */
export function plan(invocation: ActionInvocation, registry: Registry, source: ObjectSource): Plan {
    if (!registry.getResource(invocation.resource)) {
        return { ok: false, reason: "unknown-resource", resource: invocation.resource };
    }
    if (!registry.getCapability(invocation.resource, invocation.capability)) {
        return { ok: false, reason: "unknown-capability", capability: invocation.capability };
    }
    const action = registry.getAction(invocation.resource, invocation.capability, invocation.action);
    if (!action) {
        return { ok: false, reason: "unknown-action", action: invocation.action };
    }

    const value = valueFor(action, invocation.value, registry, source);
    if ("reason" in value) {
        return { ok: false, ...value };
    }

    // Defence in depth — see rule 1 above.
    if (!registry.permits(action.binding.state)) {
        return { ok: false, reason: "not-permitted", state: action.binding.state };
    }

    return { ok: true, writes: [{ state: action.binding.state, value: value.value, ack: false }] };
}

/**
 * Works out the single value an action writes.
 *
 * @param action - The declared action
 * @param supplied - Value the caller passed, if any
 * @param registry - The declared resources
 * @param source - View of the object tree
 * @returns The value to write, or the reason there is none
 */
function valueFor(
    action: ActionDef,
    supplied: StateValue | undefined,
    registry: Registry,
    source: ObjectSource,
): { readonly value: StateValue } | Refusal {
    switch (action.kind) {
        case "set":
            // The value is part of the declaration. A caller-supplied value is
            // ignored rather than rejected: `power.on` means on, and a panel
            // that sends `true` alongside it is not wrong, merely redundant.
            return { value: action.value };

        case "toggle": {
            const current = source.snapshotOf(action.binding.state)?.val;
            if (current === undefined || current === null) {
                // Nothing to invert. This is the honest answer for a state that
                // has not reported yet — guessing `true` would be a coin flip
                // that turns equipment on during a show.
                return { reason: "unresolved", state: action.binding.state };
            }
            return { value: !current };
        }

        case "level": {
            if (supplied === undefined) {
                return { reason: "value-required" };
            }
            const numeric = Number(supplied);
            if (!Number.isFinite(numeric)) {
                return { reason: "not-numeric", value: supplied };
            }
            return { value: quantise(numeric, action.min, action.max, action.step) };
        }

        case "select":
        case "route": {
            if (supplied === undefined) {
                return { reason: "value-required" };
            }
            // `toDevice` returns undefined for two different situations — the
            // value space cannot be resolved yet, and the value is genuinely not
            // in it — so resolvability is established first. Otherwise an
            // operator gets sent hunting for a typo when the adapter is down.
            const options = optionsFor(action.binding, registry, source);
            if (!options.ok) {
                return { reason: "unresolved", state: action.binding.state };
            }
            const resolved = toDevice(action.binding, supplied, registry, source);
            if (resolved === undefined) {
                return { reason: "value-rejected", value: supplied };
            }
            return { value: resolved };
        }
    }
}

/**
 * Clamps a level into range, and onto a step when one is declared.
 *
 * Clamping is not defensive tidying. A fader dragged past its end, or a scene
 * written against a device whose range differs, should reach the end of the
 * range rather than be refused mid-show or sent past what the device accepts.
 *
 * @param value - Requested level
 * @param min - Declared minimum
 * @param max - Declared maximum
 * @param step - Declared granularity, if any
 * @returns The level to write
 */
function quantise(value: number, min: number, max: number, step: number | undefined): number {
    const clamped = Math.min(max, Math.max(min, value));
    if (step === undefined || step <= 0) {
        return clamped;
    }
    const stepped = min + Math.round((clamped - min) / step) * step;
    // Rounding can push the last step past the end: min 0, max 100, step 30.
    const bounded = Math.min(max, Math.max(min, stepped));
    // Guard against floating-point dust from a fractional step (0.1 + 0.2).
    return Number(bounded.toFixed(6));
}
