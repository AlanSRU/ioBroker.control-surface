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

import type { FailurePolicy, Scene, SequenceStep } from "../model";
import type { Registry, RegistryProblem } from "./registry";
import { durationProblem, idProblem } from "./registry";

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
            const shape = sceneShapeProblem(scene);
            if (shape) {
                problems.push({ where: "scene", reason: shape });
                continue;
            }
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
            faults.push(...policyProblems(scene.onFailure, "default failure policy"));
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
                const badTimeout = durationProblem(step.timeoutMs);
                if (badTimeout) {
                    faults.push(`${at} has a timeout that ${badTimeout}`);
                } else if (step.timeoutMs <= 0) {
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

            case "delay": {
                const bad = durationProblem(step.ms);
                if (bad) {
                    faults.push(`${at} has a delay that ${bad}`);
                }
                break;
            }

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
        faults.push(...policyProblems(onFailure, at));
    });

    return faults;
}

/** The failure policies `runStep` knows how to carry out. */
const POLICY_KINDS = new Set(["abort", "continue", "retry", "fallback"]);

/**
 * Checks a failure policy's own numbers.
 *
 * Shared by the per-step policies and a scene's default, because
 * `attemptStep` reaches for whichever of the two applies and cannot tell them
 * apart afterwards — so a default that only the scene declares has to be
 * checked just as closely as one written on a step.
 *
 * @param policy - The declared policy, if any
 * @param at - Where to say the fault is
 * @returns One fault per problem
 */
function policyProblems(policy: FailurePolicy | undefined, at: string): string[] {
    if (policy === undefined) {
        return [];
    }
    if (!POLICY_KINDS.has(policy.kind)) {
        // `runStep` switches on this and every case returns. An unknown kind
        // matched none, so the function fell off the end returning undefined —
        // which `runScene` reads as neither "done" nor "failed", so the scene
        // carried on through the steps the author meant it to stop at, and then
        // reported itself completed. The most permissive outcome available,
        // from a typo.
        return [`${at} has unknown failure policy "${String(policy.kind)}"`];
    }
    if (policy.kind !== "retry") {
        return [];
    }

    const faults: string[] = [];
    // Checked by type, not by comparison — the same trap as a level's min/max.
    // `undefined < 1` is false, so a retry with no `times` loaded cleanly and
    // then computed `policy.times + 1` as NaN; `attempt < NaN` is false, so the
    // step never ran at all. A step meant to switch a projector silently did
    // nothing, and the run recorded a failure whose reason was undefined.
    if (typeof policy.times !== "number" || !Number.isFinite(policy.times) || policy.times < 1) {
        faults.push(`${at} retries ${JSON.stringify(policy.times)} times`);
    }
    const bad = durationProblem(policy.delayMs);
    if (bad) {
        faults.push(`${at} retries after a delay that ${bad}`);
    }
    return faults;
}

/**
 * Whether a declaration is an object at all.
 *
 * @param value - Anything that arrived from the configuration
 * @returns True when it can be indexed safely
 */
function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/**
 * Checks a scene has the shape its type claims, before anything walks it.
 *
 * The same reasoning as `shapeProblem` in the registry, and the same textarea:
 * a scene with no `steps`, a `parallel` with no nested `steps`, a `do` with no
 * `invoke` and a null entry in the array all threw a `TypeError` out of
 * `SceneBook.load`. One malformed scene must cost that scene and nothing else.
 *
 * @param scene - The declared scene, as it came from the configuration
 * @returns Why it cannot be read, or null
 */
function sceneShapeProblem(scene: unknown): string | null {
    if (!isObject(scene)) {
        return "is not an object";
    }
    if (typeof scene.id !== "string") {
        return "has no id";
    }
    if (!Array.isArray(scene.steps)) {
        return `"${scene.id}" has no steps array`;
    }
    return stepShapeProblem(scene.steps, `"${scene.id}"`);
}

/**
 * Checks a list of steps, and any steps nested inside them.
 *
 * @param steps - The declared steps
 * @param where - The scene, for the message
 * @returns Why they cannot be read, or null
 */
function stepShapeProblem(steps: ReadonlyArray<unknown>, where: string): string | null {
    for (const [index, step] of steps.entries()) {
        const at = `${where} step ${index + 1}`;
        if (!isObject(step) || typeof step.kind !== "string") {
            return `${at} is not an object with a kind`;
        }
        switch (step.kind) {
            case "do":
                if (!isObject(step.invoke)) {
                    return `${at} is a "do" with no invoke`;
                }
                for (const key of ["resource", "capability", "action"] as const) {
                    if (typeof step.invoke[key] !== "string") {
                        return `${at} invokes with no ${key}`;
                    }
                }
                break;
            case "waitFor":
                for (const key of ["resource", "capability", "feedback"] as const) {
                    if (typeof step[key] !== "string") {
                        return `${at} is a "waitFor" with no ${key}`;
                    }
                }
                break;
            case "scene":
                if (typeof step.scene !== "string") {
                    return `${at} is a "scene" step naming no scene`;
                }
                break;
            case "parallel": {
                if (!Array.isArray(step.steps)) {
                    return `${at} is a "parallel" with no steps array`;
                }
                const nested = stepShapeProblem(step.steps, at);
                if (nested) {
                    return nested;
                }
                break;
            }
            case "delay":
                break;
            default:
                return `${at} has unknown kind "${step.kind}"`;
        }
    }
    return null;
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
