/**
 * Scene loading and validation.
 *
 * Split from running them on purpose. Two very different things can be wrong
 * with a scene, and only one of them is a runtime concern:
 *
 *  - **A reference that cannot ever work** — an action no resource declares, a
 *    scene that does not exist, a cycle. These are configuration faults, they
 *    are decidable without touching a device, and finding them at load is the
 *    difference between a typo surfacing on a quiet afternoon and surfacing
 *    mid-show.
 *  - **A binding that is unresolved right now** — `blackmagic-atem` rebuilding
 *    its tree, an adapter that is down. Nothing static can predict it, and it is
 *    what `FailurePolicy` is for.
 *
 * This module does the first. `sequence.ts` does the second.
 */

import type { Scene, SequenceStep } from "../model";
import type { Registry, RegistryProblem } from "./registry";
import { idProblem } from "./registry";

export interface SceneLoad {
    readonly book: SceneBook;
    readonly problems: ReadonlyArray<RegistryProblem>;
}

export class SceneBook {
    private readonly scenes: ReadonlyMap<string, Scene>;

    private constructor(scenes: ReadonlyMap<string, Scene>) {
        this.scenes = scenes;
    }

    /**
     * Validates scenes against the registry and indexes what survives.
     *
     * A scene is dropped whole rather than partially: half a scene is not a
     * safer thing to run than none of it, which is the opposite of the
     * per-resource rule and for the same underlying reason — do not leave
     * equipment in a state nobody designed.
     *
     * @param scenes - Declared scenes
     * @param registry - The resources they act on
     * @returns The book, plus one problem per rejected scene
     */
    static load(scenes: ReadonlyArray<Scene>, registry: Registry): SceneLoad {
        const problems: RegistryProblem[] = [];
        const byId = new Map<string, Scene>();

        for (const scene of scenes) {
            // Scenes publish as `scenes.<id>`, so they inherit the object-id
            // rules resources already follow.
            const bad = idProblem(scene.id);
            if (bad) {
                problems.push({ where: "scene", reason: bad });
                continue;
            }
            if (byId.has(scene.id)) {
                problems.push({ where: `scene "${scene.id}"`, reason: "duplicate id" });
                continue;
            }
            byId.set(scene.id, scene);
        }

        // References are checked once every scene is known, so that order of
        // declaration does not decide whether a forward reference is legal.
        const accepted = new Map<string, Scene>();
        for (const scene of byId.values()) {
            const faults = stepProblems(scene.steps, scene, registry, byId);
            if (scene.onFailure?.kind === "fallback" && !byId.has(scene.onFailure.scene)) {
                faults.push(`default failure policy falls back to unknown scene "${scene.onFailure.scene}"`);
            }
            const cycle = cycleThrough(scene.id, byId, [scene.id]);
            if (cycle) {
                faults.push(`is part of a scene cycle: ${cycle.join(" -> ")}`);
            }
            if (faults.length > 0) {
                problems.push(...faults.map(reason => ({ where: `scene "${scene.id}"`, reason })));
                continue;
            }
            accepted.set(scene.id, scene);
        }

        return { book: new SceneBook(accepted), problems };
    }

    get(id: string): Scene | undefined {
        return this.scenes.get(id);
    }

    all(): ReadonlyArray<Scene> {
        return [...this.scenes.values()];
    }
}

/**
 * Checks every reference a scene's steps make.
 *
 * @param steps - Steps to walk, recursing through `parallel`
 * @param scene - The scene they belong to, for the report
 * @param registry - Resources the steps act on
 * @param known - Every declared scene, for `scene` and `fallback` references
 * @returns One message per fault
 */
function stepProblems(
    steps: ReadonlyArray<SequenceStep>,
    scene: Scene,
    registry: Registry,
    known: ReadonlyMap<string, Scene>,
): string[] {
    const faults: string[] = [];

    steps.forEach((step, index) => {
        const at = `step ${index + 1}`;

        switch (step.kind) {
            case "do": {
                const { resource, capability, action } = step.invoke;
                if (!registry.getAction(resource, capability, action)) {
                    faults.push(`${at} invokes undeclared action "${resource}.${capability}.${action}"`);
                }
                break;
            }

            case "waitFor": {
                const feedback = registry.getFeedback(step.resource, step.capability, step.feedback);
                if (!feedback) {
                    faults.push(
                        `${at} waits on undeclared feedback "${step.resource}.${step.capability}.${step.feedback}"`,
                    );
                } else if (step.requireReported === true && feedback.inferred === true) {
                    // Decidable here, and only here: nothing about the device's
                    // behaviour can turn a proxy into a report, so a runtime
                    // check would just be a slower way to reach the same answer.
                    faults.push(
                        `${at} requires a reported reading but ` +
                            `"${step.resource}.${step.capability}.${step.feedback}" is declared inferred`,
                    );
                }
                if (step.timeoutMs <= 0) {
                    // A wait that can never succeed is always a mistake: the
                    // step would time out before reading anything at all.
                    faults.push(`${at} has a timeout of ${step.timeoutMs}ms`);
                }
                const settleMs = feedback?.settleMs ?? 0;
                if (settleMs > 0 && step.timeoutMs <= settleMs) {
                    // The value has to hold for `settleMs` before it counts, so
                    // a timeout that expires first can never confirm anything.
                    faults.push(
                        `${at} times out after ${step.timeoutMs}ms but ` +
                            `"${step.feedback}" needs ${settleMs}ms to settle`,
                    );
                }
                break;
            }

            case "delay":
                if (step.ms < 0) {
                    faults.push(`${at} has a negative delay`);
                }
                break;

            case "parallel":
                faults.push(...stepProblems(step.steps, scene, registry, known));
                break;

            case "scene":
                if (!known.has(step.scene)) {
                    faults.push(`${at} runs unknown scene "${step.scene}"`);
                }
                break;
        }

        const onFailure = "onFailure" in step ? step.onFailure : undefined;
        if (onFailure?.kind === "fallback" && !known.has(onFailure.scene)) {
            faults.push(`${at} falls back to unknown scene "${onFailure.scene}"`);
        }
        if (onFailure?.kind === "retry" && onFailure.times < 1) {
            faults.push(`${at} retries ${onFailure.times} times`);
        }
    });

    return faults;
}

/**
 * Looks for a scene reachable from itself.
 *
 * Caught statically rather than guarded at runtime, because a cycle is never
 * intentional and a scene runner that discovers one mid-show has already
 * started doing things to equipment.
 *
 * @param id - Scene being expanded
 * @param known - Every declared scene
 * @param path - Scenes already on the stack, innermost last
 * @returns The cycle as a path, or null
 */
function cycleThrough(id: string, known: ReadonlyMap<string, Scene>, path: string[]): string[] | null {
    const scene = known.get(id);
    if (!scene) {
        return null;
    }

    for (const next of referencedScenes(scene)) {
        if (path.includes(next)) {
            return [...path, next];
        }
        const deeper = cycleThrough(next, known, [...path, next]);
        if (deeper) {
            return deeper;
        }
    }
    return null;
}

/**
 * Every scene a scene can hand control to, including through failure policies.
 *
 * A `fallback` counts: a scene whose failure path re-enters itself loops just as
 * surely as one that calls itself directly, and is harder to spot by eye.
 *
 * @param scene - Scene to inspect
 * @returns Referenced scene ids
 */
function referencedScenes(scene: Scene): ReadonlyArray<string> {
    const found: string[] = [];

    const walk = (steps: ReadonlyArray<SequenceStep>): void => {
        for (const step of steps) {
            if (step.kind === "scene") {
                found.push(step.scene);
            }
            if (step.kind === "parallel") {
                walk(step.steps);
            }
            const onFailure = "onFailure" in step ? step.onFailure : undefined;
            if (onFailure?.kind === "fallback") {
                found.push(onFailure.scene);
            }
        }
    };

    walk(scene.steps);
    if (scene.onFailure?.kind === "fallback") {
        found.push(scene.onFailure.scene);
    }
    return found;
}
