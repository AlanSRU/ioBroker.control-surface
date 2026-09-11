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
import type { ActionTarget, PublishedState } from "./engine/publisher";
import { objectsFor, ROOT, statesFor, writeTargets } from "./engine/publisher";
import type { Effects } from "./engine/sequence";
import { run } from "./engine/sequence";

/** Debounce for republishing after a burst of foreign state changes. */
const REPUBLISH_MS = 50;

class ControlSurface extends utils.Adapter {
    private registry = Registry.load([], []).registry;
    private scenes = SceneBook.load([], this.registry).book;
    private targets: ReadonlyMap<string, ActionTarget> = new Map();

    /** Last value published per id, so unchanged states are not rewritten. */
    private readonly published = new Map<string, string>();

    /** Foreign states and objects, kept current by subscription. */
    private readonly states = new Map<string, StateSnapshot>();
    private readonly meta = new Map<string, StateMeta>();
    private readonly members = new Map<string, ReadonlyArray<string>>();

    private republishTimer: ioBroker.Timeout | undefined;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: "control-surface" });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

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
     * `*` in an ioBroker pattern matches dots too, so `transmitters.*` also
     * matches `transmitters.007.name`. Members are the objects exactly one
     * level below the pattern's fixed prefix; anything deeper is a member's
     * own state, not another member.
     *
     * @param collection - The collection to read
     */
    private async primeCollection(collection: ResourceCollection): Promise<void> {
        const prefix = collection.members.slice(0, collection.members.indexOf("*"));
        const depth = prefix.replace(/\.$/, "").split(".").length;

        const objects = await this.getForeignObjectsAsync(collection.members, null);
        const ids = Object.keys(objects ?? {}).filter(id => id.split(".").length === depth + 1);
        this.members.set(collection.members, ids.sort());

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

    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (!state) {
            return;
        }

        const target = this.targets.get(id.slice(this.namespace.length + 1));
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
            await this.setForeignStateAsync(write.state, { val: write.value, ack: write.ack });
        }
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
        const effects: Effects = {
            write: writes => this.applyWrites(writes),
            sleep: ms => new Promise(resolve => this.setTimeout(() => resolve(), ms)),
            source: () => this.source(),
        };

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
    }

    private onUnload(callback: () => void): void {
        try {
            if (this.republishTimer) {
                this.clearTimeout(this.republishTimer);
                this.republishTimer = undefined;
            }
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
