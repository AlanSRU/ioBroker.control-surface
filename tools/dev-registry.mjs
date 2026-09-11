/*
 * Emits instance configuration for the dev-server from `mapping.ts`.
 *
 * The mapping is the compiler-checked source of truth, so the dev registry is
 * generated from it rather than retyped. Only the resources whose owning
 * adapter is actually present are emitted — the bench has an ATEM and a Samsung
 * TV, not a Blustream matrix.
 *
 * Usage: node tools/dev-registry.mjs samsung_tizen.0 blackmagic-atem.0
 */
import { allCollections, allMapped } from "../build/mapping.js";

const owners = process.argv.slice(2);
if (owners.length === 0) {
    console.error("give one or more adapter instances, e.g. blackmagic-atem.0");
    process.exit(1);
}

const resources = allMapped.filter(r => owners.includes(r.owner));
const collections = allCollections.filter(c => owners.includes(c.owner));

console.log(JSON.stringify({ resources, collections }, null, 2));
console.error(
    `resources: ${resources.map(r => r.id).join(", ") || "(none)"}\n` +
        `collections: ${collections.map(c => c.id).join(", ") || "(none)"}`,
);
