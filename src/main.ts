/*
 * ioBroker.control-surface
 *
 * The adapter is deliberately the thinnest part of this project. Everything
 * that decides anything — validating declarations, resolving value spaces,
 * planning a write, judging whether a reading can be trusted, running a scene —
 * lives in `src/engine` and is tested without ioBroker present. What is left
 * here is the part that cannot be: talking to the object tree.
 *
 * It implements two interfaces the engine defines (`ObjectSource` and
 * `Effects`) and otherwise gets out of the way.
 */

import * as utils from "@iobroker/adapter-core";

import type { Resource, ResourceCollection, Scene, StateValue } from "./model";
import { Registry } from "./engine/registry";
import { SceneBook } from "./engine/scenes";
import type { ObjectSource, StateMeta, StateSnapshot } from "./engine/resolver";
import type { StateWrite } from "./engine/actions";
import { plan } from "./engine/actions";
import type { ActionTarget, PublishedState, SceneStatus } from "./engine/publisher";
import {
    confirmWindows,
    objectsFor,
    ROOT,
    SCENES,
    sceneObjectsFor,
    sceneTargets,
    statesFor,
    writeTargets,
} from "./engine/publisher";
import type { Effects } from "./engine/sequence";
import { run } from "./engine/sequence";
import { WriteLog } from "./engine/writes";

/** Debounce for republishing after a burst of foreign state changes. */
const REPUBLISH_MS = 50;

/** The adapter: `ObjectSource` and `Effects` over ioBroker, and nothing more. */
class ControlSurface extends utils.Adapter {
    private registry = Registry.load([], []).registry;
    private scenes = SceneBook.load([], this.registry).book;
    private targets: ReadonlyMap<string, ActionTarget> = new Map();
    private sceneRuns: ReadonlyMap<string, string> = new Map();
    private writeWindows: ReadonlyMap<string, number> = new Map();

    /** Scenes currently running, so a double press cannot interleave two. */
    private readonly running = new Set<string>();

    /** Last value published per id, so unchanged states are not rewritten. */
    private readonly published = new Map<string, string>();

    /** Foreign states and objects, kept current by subscription. */
    private readonly states = new Map<string, StateSnapshot>();
    private readonly meta = new Map<string, StateMeta>();
    private readonly members = new Map<string, ReadonlyArray<string>>();

    /** Writes still waiting for an acknowledged echo. */
    private readonly writes = new WriteLog();

    private confirmTimer: ioBroker.Timeout | undefined;

    private republishTimer: ioBroker.Timeout | undefined;

    /**
     * @param options - Adapter options supplied by js-controller
     */
    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: "control-surface" });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    /** Loads the declarations, publishes the tree, then subscribes. */
    private async onReady(): Promise<void> {
        await this.setState("info.connection", { val: false, ack: true });

        const resources = this.parseConfig<Resource>("resources");
        const collections = this.parseConfig<ResourceCollection>("collections");

        const loaded = Registry.load(resources, collections);
        this.registry = loaded.registry;
        for (const problem of loaded.problems) {
            this.log.warn(`${problem.where}: ${problem.reason}`);
        }

        const scenes = SceneBook.load(this.parseConfig<Scene>("scenes"), this.registry);
        this.scenes = scenes.book;
        for (const problem of scenes.problems) {
            this.log.warn(`${problem.where}: ${problem.reason}`);
        }

        this.targets = writeTargets(this.registry);
        this.sceneRuns = sceneTargets(this.scenes.all());
        this.writeWindows = confirmWindows(this.registry);
        this.log.info(
            `${this.registry.allResources().length} resources, ${this.scenes.all().length} scenes, ` +
                `${this.registry.observedStates().size} states observed`,
        );

        await this.primeCache();
        await this.publish();

        // Only what the registry declares, plus the owner connection states
        // health is derived from. Nothing else is ever subscribed.
        for (const state of this.registry.observedStates()) {
            await this.subscribeForeignStatesAsync(state);
        }
        // Our own published tree, so a panel's write becomes an invocation.
        this.subscribeStates(`${ROOT}.*`);
        this.subscribeStates(`${SCENES}.*`);

        await this.setState("info.connection", { val: true, ack: true });
    }

    /**
     * Reads one JSON document out of the instance configuration.
     *
     * A malformed document yields nothing rather than stopping the adapter, on
     * the same reasoning as everything else here: the rest of the venue should
     * keep working while one list is being fixed.
     *
     * @param key - Which configuration field to read
     * @returns The declarations, or an empty list
     */
    private parseConfig<T>(key: "resources" | "collections" | "scenes"): T[] {
        const raw = (this.config as Record<string, unknown>)[key];
        if (typeof raw !== "string" || raw.trim() === "") {
            return [];
        }
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                this.log.warn(`Configured ${key} is not a JSON array; ignoring it`);
                return [];
            }
            return parsed as T[];
        } catch (error) {
            this.log.warn(`Configured ${key} is not valid JSON (${(error as Error).message}); ignoring it`);
            return [];
        }
    }

    /** Fills the caches the engine reads through `ObjectSource`. */
    private async primeCache(): Promise<void> {
        for (const id of this.registry.observedStates()) {
            const object = await this.getForeignObjectAsync(id);
            if (object?.common) {
                this.meta.set(id, object.common as StateMeta);
            }
            const state = await this.getForeignStateAsync(id);
            if (state) {
                this.states.set(id, { val: state.val, ack: state.ack, ts: state.ts });
            }
        }

        for (const collection of this.registry.allResources().length > 0 ? this.collections() : []) {
            await this.primeCollection(collection);
        }
    }

    /** Every collection any binding refers to. */
    private collections(): ReadonlyArray<ResourceCollection> {
        const found = new Map<string, ResourceCollection>();
        for (const resource of this.registry.allResources()) {
            for (const capability of resource.capabilities) {
                const bindings = [
                    ...capability.actions.map(a => a.binding),
                    ...capability.feedback.map(f => f.binding),
                ];
                for (const binding of bindings) {
                    if (binding.values?.kind !== "resourceIds") {
                        continue;
                    }
                    const collection = this.registry.getCollection(binding.values.collection);
                    if (collection) {
                        found.set(collection.id, collection);
                    }
                }
            }
        }
        return [...found.values()];
    }

    /**
     * Reads a collection's members and the states they contribute.
     *
     * Two things about ioBroker patterns had to be learned against real
     * hardware, and both produced an empty collection that looked like a
     * working one.
     *
     * **`getForeignObjects` cannot match a wildcard inside a segment.**
     * `blackmagic-atem.0.inputs.input*` returns nothing at all — with a type
     * filter, without one, either way. Only whole-segment patterns work. So the
     * query asks for the parent level and the pattern is applied here.
     *
     * **`*` otherwise matches dots**, so `transmitters.*` also matches
     * `transmitters.007.name`. A member is one level below the parent, and
     * anything deeper is a member's own state — hence `[^.]*` and the depth
     * check rather than a loose prefix match.
     *
     * @param collection - The collection to read
     */
    private async primeCollection(collection: ResourceCollection): Promise<void> {
        const pattern = collection.members;
        const depth = pattern.split(".").length;
        const parent = pattern.slice(0, pattern.lastIndexOf("."));

        const matches = new RegExp(
            `^${pattern
                .split("*")
                .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
                .join("[^.]*")}$`,
        );

        // Each type is asked for separately, because `getForeignObjects` with no
        // type returns **states only**. Against the real ATEM that quietly
        // returned the 76 leaf states under `inputs.*` and none of the 19 input
        // channels, so the collection came back empty while looking like a
        // working query. A member is whatever the owning adapter made it.
        const found = new Set<string>();
        for (const type of ["channel", "device", "folder", "state"] as const) {
            const objects = await this.getForeignObjectsAsync(`${parent}.*`, type);
            for (const id of Object.keys(objects ?? {})) {
                found.add(id);
            }
        }
        const ids = [...found].filter(id => id.split(".").length === depth && matches.test(id));
        this.members.set(collection.members, ids.sort());
        // Info rather than debug: an operator needs to know whether their ATEM
        // inputs were found, and a silent empty collection looks identical to a
        // working one until a selector turns up with no options in it.
        this.log[ids.length > 0 ? "info" : "warn"](
            `Collection "${collection.id}": ${ids.length} members match ${collection.members} ` +
                `(${found.size} objects under ${parent}.*)`,
        );

        for (const id of ids) {
            for (const suffix of [collection.valueState, collection.nameState]) {
                if (suffix === undefined) {
                    continue;
                }
                const state = await this.getForeignStateAsync(`${id}.${suffix}`);
                if (state) {
                    this.states.set(`${id}.${suffix}`, {
                        val: state.val,
                        ack: state.ack,
                        ts: state.ts,
                    });
                }
                await this.subscribeForeignStatesAsync(`${id}.${suffix}`);
            }
        }
    }

    /** The engine's view of the object tree, served from the caches above. */
    private source(): ObjectSource {
        return {
            metaOf: id => this.meta.get(id),
            membersOf: pattern => this.members.get(pattern),
            snapshotOf: id => this.states.get(id),
            unconfirmed: id => this.writes.unconfirmed(id, Date.now()),
        };
    }

    /** Creates the semantic tree and writes every state that has changed. */
    private async publish(): Promise<void> {
        const source = this.source();

        for (const object of objectsFor(this.registry, source)) {
            // `extendObject` rather than `setObjectNotExists`: a state's value
            // labels are resolved at runtime and change as a collection fills,
            // and "if not exists" would freeze whatever was known at first run.
            const { name, desc } = object.common;
            const common = desc === undefined ? { name } : { name, desc };

            switch (object.type) {
                case "state":
                    await this.extendObject(object.id, {
                        type: "state",
                        common: object.common as ioBroker.StateCommon,
                        native: {},
                    });
                    break;
                case "channel":
                    await this.extendObject(object.id, { type: "channel", common, native: {} });
                    break;
                case "device":
                    await this.extendObject(object.id, { type: "device", common, native: {} });
                    break;
                case "folder":
                    await this.extendObject(object.id, { type: "folder", common, native: {} });
                    break;
            }
        }

        for (const state of statesFor(this.registry, source)) {
            await this.publishState(state);
        }

        for (const object of sceneObjectsFor(this.scenes.all())) {
            const { name, desc } = object.common;
            if (object.type === "state") {
                await this.extendObject(object.id, {
                    type: "state",
                    common: object.common as ioBroker.StateCommon,
                    native: {},
                });
            } else {
                await this.extendObject(object.id, {
                    type: object.type === "channel" ? "channel" : "folder",
                    common: desc === undefined ? { name } : { name, desc },
                    native: {},
                });
            }
        }

        // Seed each status once. Written only if absent, so a restart does not
        // wipe the record of what happened before it.
        for (const scene of this.scenes.all()) {
            const id = `${SCENES}.${scene.id}.status`;
            if (!(await this.getStateAsync(id))) {
                await this.setStatus(scene.id, "idle");
            }
        }
    }

    /**
     * Records what a scene is doing.
     *
     * @param scene - Scene id
     * @param status - What it is doing
     */
    private async setStatus(scene: string, status: SceneStatus): Promise<void> {
        await this.setState(`${SCENES}.${scene}.status`, { val: status, ack: true });
    }

    /**
     * Writes one published state, unless it already says the same thing.
     *
     * @param state - The state to publish
     */
    private async publishState(state: PublishedState): Promise<void> {
        const fingerprint = `${JSON.stringify(state.val)}|${state.q}`;
        if (this.published.get(state.id) === fingerprint) {
            return;
        }
        this.published.set(state.id, fingerprint);
        await this.setState(state.id, { val: state.val, ack: true, q: state.q });
    }

    /**
     * Routes a change to the action engine, or into the object-tree cache.
     *
     * @param id - State that changed
     * @param state - Its new value, or null when it was deleted
     */
    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (!state) {
            return;
        }

        const local = id.slice(this.namespace.length + 1);

        const scene = this.sceneRuns.get(local);
        if (scene !== undefined) {
            // Momentary, like showcontrol's cue trigger: only a truthy,
            // unacknowledged write is a command.
            if (!state.ack && state.val) {
                void this.runScene(scene);
            }
            return;
        }

        const target = this.targets.get(local);
        if (target) {
            // Only an unacknowledged write is a command. Our own acked
            // publications come back through here and must be ignored, or the
            // adapter would answer itself.
            if (!state.ack) {
                void this.invoke(target, state.val);
            }
            return;
        }

        this.states.set(id, { val: state.val, ack: state.ack, ts: state.ts });
        // Only an acknowledged change answers a pending write. An unacknowledged
        // one is another command — quite possibly our own arriving back through
        // the subscription — and would let every write confirm itself.
        this.writes.observed(id, state.ack);
        this.scheduleRepublish();
    }

    /**
     * Coalesces republishing, because one device change usually arrives as
     * several state changes in the same breath.
     */
    private scheduleRepublish(): void {
        if (this.republishTimer) {
            return;
        }
        this.republishTimer = this.setTimeout(() => {
            this.republishTimer = undefined;
            void this.publish();
        }, REPUBLISH_MS);
    }

    /**
     * Turns a write against a published state into an action.
     *
     * @param target - Which action the written state stands for
     * @param value - What was written
     */
    private async invoke(target: ActionTarget, value: StateValue | null): Promise<void> {
        const label = `${target.resource}.${target.capability}.${target.action}`;
        const invocation = value === null ? target : { ...target, value };

        const planned = plan(invocation, this.registry, this.source());
        if (!planned.ok) {
            this.log.warn(`${label} refused: ${JSON.stringify(planned)}`);
            return;
        }
        await this.applyWrites(planned.writes);
        this.log.debug(`${label} wrote ${planned.writes.map(w => `${w.state}=${String(w.value)}`).join(", ")}`);
    }

    /**
     * Performs planned writes.
     *
     * The whitelist is re-checked here as well as in the action engine. This is
     * the last point before a foreign device is written to, and it writes to
     * live equipment during events.
     *
     * @param writes - What to write
     */
    private async applyWrites(writes: ReadonlyArray<StateWrite>): Promise<void> {
        for (const write of writes) {
            if (!this.registry.permits(write.state)) {
                this.log.error(`Refusing to write undeclared state ${write.state}`);
                continue;
            }
            // Armed *before* the write, not after. A quick adapter acknowledges
            // and the echo arrives through the subscription while
            // `setForeignStateAsync` is still being awaited — arming afterwards
            // then records a pending write that has already been answered and
            // can never be cleared. Every write looked dropped on real hardware
            // until this was the other way round.
            const withinMs = this.writeWindows.get(write.state);
            if (withinMs !== undefined) {
                this.writes.arm(write.state, Date.now(), withinMs);
                this.scheduleConfirmCheck(withinMs);
            }

            await this.setForeignStateAsync(write.state, { val: write.value, ack: write.ack });
        }
    }

    /**
     * Re-examines pending writes once their window has passed.
     *
     * Needed because a write that is never echoed produces no state change, so
     * nothing else would ever wake the adapter to notice — which is precisely
     * the failure being detected.
     *
     * @param withinMs - The window that was just armed
     */
    private scheduleConfirmCheck(withinMs: number): void {
        if (this.confirmTimer) {
            this.clearTimeout(this.confirmTimer);
        }
        this.confirmTimer = this.setTimeout(() => {
            this.confirmTimer = undefined;
            const lapsed = this.writes.lapsed(Date.now());
            for (const state of lapsed) {
                this.log.warn(`Write to ${state} was accepted but never echoed back`);
            }
            if (lapsed.length > 0) {
                void this.publish();
            }
        }, withinMs + 100);
    }

    /**
     * Runs a scene by id.
     *
     * Exposed for the scene trigger states and for `sendTo`; the engine itself
     * never decides when to run, because ioBroker already has schedules,
     * scripts and Blockly for that.
     *
     * @param id - Scene to run
     */
    public async runScene(id: string): Promise<void> {
        // A second press while the first run is still going would interleave two
        // sets of writes to the same equipment, which on a live stage is worse
        // than doing nothing. Ignoring is the safe answer, but it must be said
        // out loud or an operator will think the button is broken.
        if (this.running.has(id)) {
            this.log.warn(`Scene "${id}" is already running; ignoring this trigger`);
            return;
        }
        this.running.add(id);
        await this.setStatus(id, "running");

        const effects: Effects = {
            write: writes => this.applyWrites(writes),
            sleep: ms => new Promise(resolve => this.setTimeout(() => resolve(), ms)),
            source: () => this.source(),
        };

        try {
            const report = await run(id, this.scenes, this.registry, effects);
            for (const failure of report.failures) {
                this.log.warn(
                    `Scene "${failure.scene}" step ${failure.step} failed ` +
                        `(${failure.reason.kind}, handled by ${failure.handled})`,
                );
            }
            this.log[report.completed ? "info" : "error"](
                `Scene "${id}" ${report.completed ? "completed" : "did not complete"}`,
            );
            await this.setStatus(id, report.completed ? "completed" : "failed");
        } finally {
            // Always released: a scene stuck marked running can never be fired
            // again, which is a worse failure than the one that caused it.
            this.running.delete(id);
        }
    }

    /**
     * @param callback - Called once timers are cleared
     */
    private onUnload(callback: () => void): void {
        try {
            if (this.republishTimer) {
                this.clearTimeout(this.republishTimer);
                this.republishTimer = undefined;
            }
            if (this.confirmTimer) {
                this.clearTimeout(this.confirmTimer);
                this.confirmTimer = undefined;
            }
            this.writes.clear();
            callback();
        } catch {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new ControlSurface(options);
} else {
    (() => new ControlSurface())();
}
