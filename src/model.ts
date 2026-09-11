/**
 * The semantic model: Resource, Capability, Action, Feedback, Scene.
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

/** What an ioBroker state can hold. `role: 'json'` states are strings. */
export type StateValue = string | number | boolean;

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
    /** Object-tree pattern whose matches are the members, e.g. `atem.0.inputs.input*`. */
    readonly members: string;
    /** Per-member state holding the display name, relative to the member. */
    readonly nameState?: string;
    /**
     * Per-member state holding the value to write when this member is chosen,
     * relative to the member.
     *
     * Required in practice, and the member's own id segment is not a substitute:
     * an ACM transmitter is `transmitters.007` and routes as `007`, but an ATEM
     * input is `inputs.input3` and routes as `3`. Both adapters publish the
     * value explicitly — `id` and `inputId` respectively — so read it rather
     * than parsing the object id. Omitted means the id segment is the value.
     */
    readonly valueState?: string;
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
    | {
          readonly kind: "route";
          readonly id: string;
          readonly binding: StateBinding;
          readonly layer: RouteLayer;
          readonly scope?: RouteScope;
      };

/**
 * Which destinations a route reaches.
 *
 * `self` — the resource the action hangs off, which is the normal case and the
 * default. `all` — every destination the owning device serves, written through a
 * single broadcast state that belongs to no destination at all:
 * `blustream-acm.0.system.commands.routeAll`, `blustream-mfp.*.output.allSource`.
 *
 * This is not a convenience over writing each destination in turn. The ACM
 * enforces a 500 ms inter-command delay, so ten receivers cost five seconds
 * individually against one command broadcast, and the production venue system
 * routes "all displays" this way for that reason.
 *
 * The engine does not synthesise a broadcast from per-destination writes when no
 * broadcast state exists. Doing so needs the set of destinations, which nothing
 * in this model expresses — see `docs/architecture/model.md`.
 */
export type RouteScope = "self" | "all";

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
    /** How a renderer should read it: a label, a lamp, a number, a selection. */
    readonly presentation: "text" | "boolean" | "number" | "selection";
}

/** An observed value. Runtime, not model. */
export interface FeedbackValue {
    readonly resource: ResourceId;
    readonly capability: CapabilityId;
    readonly feedback: string;
    /** Mapped through the value space where one applies; null when unknown. */
    readonly value: StateValue | null;
    /**
     * The value as the device reported it, before the value space.
     *
     * Both are needed and neither is redundant. A scene waits on the semantic
     * name, because that is what a person writes; the published state tree
     * carries the raw value with `common.states` supplying the labels, because
     * that is what every existing ioBroker consumer already understands.
     */
    readonly raw: StateValue | null;
    readonly healthy: boolean;
    /** Why not. Present exactly when `healthy` is false. */
    readonly unhealthy?: UnhealthyReason;
    /** When the device last reported. 0 means it never has. */
    readonly timestamp: number;
}

/**
 * Why an observed value should not be trusted.
 *
 * A renderer needs this, not just the boolean: "the adapter is down" and "this
 * control has never reported" call for different things on screen, and
 * TouchBroker's `onUnhealthy` already distinguishes dim from hide.
 *
 * Staleness is deliberately absent. The model comment here used to claim it,
 * but nothing says what window is right — `operatingHours` moves hourly and
 * `power` may not move for weeks — and the one concrete case, a Stream Deck
 * whose Pi dies without clearing `connected`, is a heartbeat problem rather
 * than a value-age one. See `docs/architecture/model.md`.
 */
export type UnhealthyReason =
    /** The bound state does not exist. Normal for `blackmagic-atem` on reconnect. */
    | "unresolved"
    /** The state exists but has never carried a value. */
    | "never-reported"
    /** The value is an unconfirmed command, not the device reporting. */
    | "unacknowledged"
    /** The owning adapter's `info.connection` is false. */
    | "owner-offline";

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
// Surfaces — deliberately absent
// ---------------------------------------------------------------------------

/*
 * There is no `Surface` type here, and that is the settled position rather than
 * a gap. See `docs/architecture/model.md`, decision 1.
 *
 * A surface is a rendering endpoint owned by whatever adapter runs it, which
 * makes it a `Resource` like any other: `iobroker.streamdeck` already publishes
 * `currentPageId` (navigation), `connected` and `lastHeartbeat` (health) as
 * ordinary states, and `surface.reception` in `mapping.ts` binds to them with no
 * special case. A parallel `Surface` interface would have described the same
 * device twice, and a scene step that navigates a panel would have needed a
 * second code path beside the one that switches a projector input.
 *
 * Registration, heartbeat, capability reporting, deployment and fleet health —
 * the brief's sections 20 to 23 — therefore belong to the panel runtime, not
 * here. This layer publishes semantics as ioBroker states and does not know
 * which surfaces exist.
 */

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/*
 * There is no `SurfaceGrant` type either, for the same reason: nothing
 * registers with this layer, so there is no surface identity to key a grant on.
 * See `docs/architecture/model.md`, decision 2.
 *
 * The registry is the authorization boundary. A semantic action can only reach
 * a state some administrator bound to it in configuration, so there is no
 * runtime path from a semantic name to an undeclared state — the property
 * `iobroker.showcontrol` holds today, preserved by the same mechanism.
 *
 * Narrowing below that is ioBroker's own object ACLs on the published semantic
 * states, which apply uniformly to every consumer — a panel, a script, Blockly,
 * the REST adapter — rather than only to endpoints that registered here.
 */
