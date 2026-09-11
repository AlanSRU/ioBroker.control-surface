/**
 * The semantic model: Resource, Capability, Action, Feedback, Surface, Scene.
 *
 * Design stage only — nothing implements these yet. They exist to be stress
 * tested against real adapters in `mapping.ts`, per the brief's section 46/47.
 *
 * Two rules shape everything here:
 *
 *  1. The device adapter stays the authority for device state. This model holds
 *     *references* into adapter states, never copies of their values.
 *  2. Nothing is inferred from `common.role`. Roles are not consistent enough
 *     across adapters to carry semantics — see `docs/architecture/model.md`.
 */

// ---------------------------------------------------------------------------
// Binding: how a semantic concept reaches an actual ioBroker state
// ---------------------------------------------------------------------------

/** A fully qualified foreign state id, e.g. `iiyama-prolite.0.power`. */
export type StateId = string;

/**
 * How the semantic value space maps onto the device's own value space.
 *
 * Three real cases exist across the surveyed adapters and all three are needed:
 * the map is explicit, the map is published by the adapter in `common.states`,
 * or the values are ids that only exist at runtime (Blustream TX ids, ATEM
 * input numbers) and must be resolved from another resource.
 */
export type ValueSpace =
    | { kind: "identity" }
    /** Explicit pairs, semantic name -> device value. */
    | { kind: "table"; entries: ReadonlyArray<{ name: string; value: string | number | boolean }> }
    /** Read `common.states` off the bound object and use it as the table. */
    | { kind: "objectStates" }
    /** Values are the ids of members of another resource collection. */
    | { kind: "resourceIds"; collection: ResourceId };

export interface StateBinding {
    readonly state: StateId;
    readonly values?: ValueSpace;
}

// ---------------------------------------------------------------------------
// Resource
// ---------------------------------------------------------------------------

/** Semantic id, e.g. `display.lobby` or `room1.projector`. Never a device id. */
export type ResourceId = string;

/**
 * Resource types are an open vocabulary, not an enum. A closed list would be
 * the "giant universal device model" the brief's section 29 rules out.
 */
export type ResourceType = string;

export interface Resource {
    readonly id: ResourceId;
    readonly type: ResourceType;
    readonly name?: string;
    /** The adapter instance that owns this resource's truth, e.g. `atem.0`. */
    readonly owner: string;
    readonly capabilities: ReadonlyArray<Capability>;
}

/**
 * A collection whose members only exist at runtime — Blustream transmitters,
 * ATEM inputs. Referenced by `ValueSpace.resourceIds` so a selector can be
 * populated without hardcoding the member list.
 */
export interface ResourceCollection {
    readonly id: ResourceId;
    readonly type: ResourceType;
    readonly owner: string;
    /** Object-tree pattern whose matches are the members, e.g. `atem.0.input.*`. */
    readonly members: string;
    /** Per-member state holding the display name, relative to the member. */
    readonly nameState?: string;
}

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

/**
 * Capability ids are an open vocabulary; the brief's section 41 list is a
 * convention, not a constraint.
 */
export type CapabilityId = string;

export interface Capability {
    readonly id: CapabilityId;
    readonly actions: ReadonlyArray<ActionDef>;
    readonly feedback: ReadonlyArray<FeedbackDef>;
}

// ---------------------------------------------------------------------------
// Action — what can be done
// ---------------------------------------------------------------------------

/**
 * Declared actions. Deliberately split from `ActionInvocation`: the brief's
 * section 28 used one `Action` interface for both "a thing that can be done"
 * and "a thing being done", which are different lifetimes and different owners.
 */
export type ActionDef =
    /** Write a fixed value. `power.on`, `mute.off`, a momentary button press. */
    | { readonly kind: "set"; readonly id: string; readonly binding: StateBinding; readonly value: string | number | boolean }
    /** Write a caller-supplied value from the capability's value space. */
    | { readonly kind: "select"; readonly id: string; readonly binding: StateBinding }
    /** Numeric set, with optional relative stepping. */
    | { readonly kind: "level"; readonly id: string; readonly binding: StateBinding; readonly min: number; readonly max: number; readonly step?: number }
    /** Invert the bound boolean. */
    | { readonly kind: "toggle"; readonly id: string; readonly binding: StateBinding }
    /**
     * Connect a source to a destination.
     *
     * Every surveyed router implements this as "write a source identifier into
     * a state belonging to the destination" — Blustream `rx.videoRoute`, Atlona
     * `control.matrix.hdbasetOutput`, ATEM `me0.programInput`. So routing and
     * source-selection are one operation seen from two ends, and only this
     * action kind is needed for both.
     */
    | { readonly kind: "route"; readonly id: string; readonly binding: StateBinding; readonly layer: RouteLayer };

/**
 * Blustream routes video, audio, IR, RS232, USB and CEC independently
 * ("breakaway"). A router without breakaway declares `all` only.
 */
export type RouteLayer = "all" | "video" | "audio" | "ir" | "rs232" | "usb" | "cec";

/** A request to perform a declared action. Runtime, not model. */
export interface ActionInvocation {
    readonly resource: ResourceId;
    readonly capability: CapabilityId;
    readonly action: string;
    readonly value?: string | number | boolean;
}

// ---------------------------------------------------------------------------
// Feedback — what can be observed
// ---------------------------------------------------------------------------

/** Declared observable. Split from `FeedbackValue` for the same reason as actions. */
export interface FeedbackDef {
    readonly id: string;
    readonly binding: StateBinding;
    /** How a surface should read it: a label, a lamp, a number, a selection. */
    readonly presentation: "text" | "boolean" | "number" | "selection";
}

/** An observed value. Runtime, not model. */
export interface FeedbackValue {
    readonly resource: ResourceId;
    readonly capability: CapabilityId;
    readonly feedback: string;
    readonly value: unknown;
    /** False when the source state is stale, unacknowledged or the owner is down. */
    readonly healthy: boolean;
    readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Scenes and sequences
// ---------------------------------------------------------------------------

export interface Scene {
    readonly id: string;
    readonly name: string;
    readonly steps: ReadonlyArray<SequenceStep>;
    /** What to do when a step fails and declares no policy of its own. */
    readonly onFailure?: FailurePolicy;
}

export type SequenceStep =
    | { readonly kind: "do"; readonly invoke: ActionInvocation; readonly onFailure?: FailurePolicy }
    | { readonly kind: "delay"; readonly ms: number }
    /** Block until a feedback matches, or give up. */
    | { readonly kind: "waitFor"; readonly resource: ResourceId; readonly capability: CapabilityId; readonly feedback: string; readonly equals: unknown; readonly timeoutMs: number; readonly onFailure?: FailurePolicy }
    | { readonly kind: "parallel"; readonly steps: ReadonlyArray<SequenceStep> }
    | { readonly kind: "scene"; readonly scene: string };

export type FailurePolicy =
    | { readonly kind: "abort" }
    | { readonly kind: "continue" }
    | { readonly kind: "retry"; readonly times: number; readonly delayMs: number }
    /** Run another scene instead — the backup-projector case. */
    | { readonly kind: "fallback"; readonly scene: string };

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

/**
 * A surface is a registered rendering endpoint. This file deliberately stops
 * at registration, fleet identity and health: the logical-UI schema that a
 * surface renders is NOT defined here, because TouchBroker already has one.
 * See `docs/architecture/model.md`, open decision 1.
 */
export interface Surface {
    readonly id: string;
    readonly type: string;
    readonly capabilities: SurfaceCapabilities;
}

export interface SurfaceCapabilities {
    readonly width: number;
    readonly height: number;
    readonly colour: boolean;
    readonly touch: boolean;
    readonly images: boolean;
    readonly video: boolean;
    readonly buttons: boolean;
    /** Absent means the surface cannot report or set its own brightness. */
    readonly brightness?: boolean;
}

export interface SurfaceState {
    readonly online: boolean;
    readonly lastSeen: number;
    readonly version?: string;
    readonly currentPage?: string;
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/**
 * What a surface is permitted to do. Open decision 2 in the architecture doc
 * is whether this is sufficient on its own, or whether it sits on top of a
 * declared allow-list of resources as `iobroker.showcontrol` does today.
 */
export interface SurfaceGrant {
    readonly surface: string;
    readonly role: "readonly" | "control" | "operator" | "admin";
    /** Resources this surface may act on. `*` is deliberately spelled out. */
    readonly resources: ReadonlyArray<ResourceId | "*">;
}
