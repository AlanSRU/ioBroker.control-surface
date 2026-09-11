/**
 * The sequence engine: runs a validated scene.
 *
 * `showcontrol`'s `CueRunner` is the prior art, and two of its decisions carry
 * over unchanged. Steps run **sequentially** unless a `parallel` says otherwise,
 * because a scene that switches an input and then fades a light depends on that
 * order. And a step that dispatched without throwing is reported as *dispatched*
 * — not as *worked*. The device may not have complied, may not even be there;
 * `waitFor` is the only step that claims otherwise, and it is the only one that
 * checks.
 *
 * Effects are injected, so the engine still runs under test with no ioBroker and
 * no real clock. What it does not do is decide *when* to run: that is a trigger,
 * and ioBroker already has schedules, scripts and Blockly for it.
 */

import type { FailurePolicy, SequenceStep, StateValue } from "../model.ts";
import type { ObjectSource } from "./resolver.ts";
import type { Refusal, StateWrite } from "./actions.ts";
import { plan } from "./actions.ts";
import { read } from "./feedback.ts";
import type { Registry } from "./registry.ts";
import type { SceneBook } from "./scenes.ts";

/**
 * How often `waitFor` re-reads while waiting.
 *
 * Fast enough that a projector reporting ready is not sat on for a visible
 * beat, slow enough to be free. The read is against a cache the adapter keeps
 * from its subscriptions, not a device round trip.
 */
const POLL_MS = 50;

/** Everything the engine needs from the world outside it. */
export interface Effects {
    /** Carry out planned writes. Throwing means they did not land. */
    write(writes: ReadonlyArray<StateWrite>): Promise<void>;
    /** Wait. */
    sleep(ms: number): Promise<void>;
    /**
     * The object tree as it stands now.
     *
     * A function rather than a value because a scene's whole purpose is to
     * outlive a moment: between a `do` and the `waitFor` that follows it, the
     * thing being waited on is expected to change.
     */
    source(): ObjectSource;
}

/** Why one step did not do what it said. */
export type FailureReason =
    /** The action engine would not plan it. */
    | { readonly kind: "refused"; readonly refusal: Refusal }
    /** The writes were planned but did not land. */
    | { readonly kind: "write-failed"; readonly message: string }
    /** `waitFor` gave up. */
    | { readonly kind: "timeout"; readonly waited: number; readonly last: StateValue | null }
    /** A nested scene was dropped at load, so it is not in the book. */
    | { readonly kind: "unknown-scene"; readonly scene: string };

export interface StepFailure {
    /** Which scene, since a failure may be inside a nested one. */
    readonly scene: string;
    /** 1-based index of the step within that scene. */
    readonly step: number;
    readonly reason: FailureReason;
    /** What the policy did about it. */
    readonly handled: FailurePolicy["kind"];
}

export interface RunReport {
    readonly scene: string;
    /** True when every step ran, including ones whose failure was continued past. */
    readonly completed: boolean;
    /**
     * Every failure, including those a `continue` policy passed over.
     *
     * Recording those is the point: `continue` means "the show goes on", never
     * "nothing happened". An operator still needs to know the backup projector
     * never came up.
     */
    readonly failures: ReadonlyArray<StepFailure>;
}

/** Abort is the default because half a scene leaves equipment as nobody designed it. */
const DEFAULT_POLICY: FailurePolicy = { kind: "abort" };

/**
 * What a step leaves the scene doing.
 *
 * `done` exists for `fallback` alone, and is why this is not a boolean: a
 * fallback that succeeded means the scene should stop *without* the run being a
 * failure. Switching to the backup projector is the designed outcome, not a
 * degraded one — but the steps after it were aimed at the projector that died,
 * so they must not run.
 */
type StepOutcome = "next" | "done" | "failed";

/**
 * Runs a scene.
 *
 * @param id - Scene to run; must be in the book
 * @param book - Validated scenes
 * @param registry - The declared resources
 * @param effects - Writes, waits and the object tree
 * @returns What happened
 */
export async function run(
    id: string,
    book: SceneBook,
    registry: Registry,
    effects: Effects,
): Promise<RunReport> {
    const failures: StepFailure[] = [];
    const completed = await runScene(id, book, registry, effects, failures);
    return { scene: id, completed, failures };
}

/**
 * Runs one scene's steps in order.
 *
 * @param id - Scene id
 * @param book - Validated scenes
 * @param registry - The declared resources
 * @param effects - Writes, waits and the object tree
 * @param failures - Collected across the whole run, including nested scenes
 * @returns False when a step aborted the scene
 */
async function runScene(
    id: string,
    book: SceneBook,
    registry: Registry,
    effects: Effects,
    failures: StepFailure[],
): Promise<boolean> {
    const scene = book.get(id);
    if (!scene) {
        // Load-time validation rejects unknown references, so reaching here
        // means the scene itself was dropped for a fault of its own.
        failures.push({
            scene: id,
            step: 0,
            reason: { kind: "unknown-scene", scene: id },
            handled: "abort",
        });
        return false;
    }

    for (const [index, step] of scene.steps.entries()) {
        const outcome = await runStep(step, scene.id, index + 1, scene.onFailure, book, registry, effects, failures);
        if (outcome === "done") {
            return true;
        }
        if (outcome === "failed") {
            return false;
        }
    }
    return true;
}

/**
 * Runs one step, applying its failure policy.
 *
 * @param step - The step
 * @param scene - Scene it belongs to, for the report
 * @param position - 1-based index within that scene
 * @param sceneDefault - The scene's own policy, used when the step declares none
 * @param book - Validated scenes
 * @param registry - The declared resources
 * @param effects - Writes, waits and the object tree
 * @param failures - Collected across the whole run
 * @returns What the scene should do next
 */
async function runStep(
    step: SequenceStep,
    scene: string,
    position: number,
    sceneDefault: FailurePolicy | undefined,
    book: SceneBook,
    registry: Registry,
    effects: Effects,
    failures: StepFailure[],
): Promise<StepOutcome> {
    const policy = ("onFailure" in step ? step.onFailure : undefined) ?? sceneDefault ?? DEFAULT_POLICY;
    const attempts = policy.kind === "retry" ? policy.times + 1 : 1;

    let reason: FailureReason | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0 && policy.kind === "retry") {
            await effects.sleep(policy.delayMs);
        }
        reason = await attemptStep(step, book, registry, effects, failures);
        if (!reason) {
            return "next";
        }
    }

    // `reason` is set: the loop runs at least once and only exits early on success.
    failures.push({ scene, step: position, reason: reason!, handled: policy.kind });

    switch (policy.kind) {
        case "continue":
            return "next";
        case "fallback":
            // The fallback replaces the rest of this scene rather than resuming
            // it — "switch to the backup projector" does not then want the
            // remaining steps aimed at the dead one.
            return (await runScene(policy.scene, book, registry, effects, failures)) ? "done" : "failed";
        case "abort":
        case "retry":
            return "failed";
    }
}

/**
 * Carries out one step once.
 *
 * @param step - The step
 * @param book - Validated scenes
 * @param registry - The declared resources
 * @param effects - Writes, waits and the object tree
 * @param failures - Collected across the whole run, for nested scenes
 * @returns The reason it failed, or undefined on success
 */
async function attemptStep(
    step: SequenceStep,
    book: SceneBook,
    registry: Registry,
    effects: Effects,
    failures: StepFailure[],
): Promise<FailureReason | undefined> {
    switch (step.kind) {
        case "delay":
            await effects.sleep(step.ms);
            return undefined;

        case "do": {
            const planned = plan(step.invoke, registry, effects.source());
            if (!planned.ok) {
                const { ok: _ok, ...refusal } = planned;
                return { kind: "refused", refusal };
            }
            try {
                await effects.write(planned.writes);
            } catch (error) {
                return { kind: "write-failed", message: (error as Error).message };
            }
            return undefined;
        }

        case "waitFor":
            return waitFor(step, registry, effects);

        case "scene":
            return (await runScene(step.scene, book, registry, effects, failures))
                ? undefined
                : { kind: "unknown-scene", scene: step.scene };

        case "parallel": {
            // Children run concurrently but each keeps its own policy, so one
            // continuing does not drag the others down with it.
            const results = await Promise.all(
                step.steps.map((child, index) =>
                    runStep(child, "parallel", index + 1, undefined, book, registry, effects, failures),
                ),
            );
            return results.every(outcome => outcome !== "failed")
                ? undefined
                : { kind: "write-failed", message: "a parallel step failed" };
        }
    }
}

/**
 * Blocks until a feedback matches, or gives up.
 *
 * Requires the reading to be **healthy**. An unacknowledged or unresolved value
 * that happens to equal the target is not the device confirming anything, and a
 * scene that carried on from one would be acting on an assumption at the exact
 * moment it asked not to.
 *
 * @param step - The wait
 * @param registry - The declared resources
 * @param effects - Waits and the object tree
 * @returns A timeout reason, or undefined once matched
 */
async function waitFor(
    step: Extract<SequenceStep, { kind: "waitFor" }>,
    registry: Registry,
    effects: Effects,
): Promise<FailureReason | undefined> {
    const wanted = String(step.equals);
    let waited = 0;
    let last: StateValue | null = null;

    for (;;) {
        const reading = read(step.resource, step.capability, step.feedback, registry, effects.source());
        last = reading?.value ?? null;
        if (reading?.healthy && String(reading.value) === wanted) {
            return undefined;
        }
        if (waited >= step.timeoutMs) {
            return { kind: "timeout", waited, last };
        }
        const next = Math.min(POLL_MS, step.timeoutMs - waited);
        await effects.sleep(next);
        waited += next;
    }
}
