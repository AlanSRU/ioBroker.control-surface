/**
 * The five real adapters mapped onto `model.ts`, per the brief's section 46.
 *
 * This file is the actual test of the abstraction: it typechecks only if the
 * model can express equipment that already exists. Every state id below was
 * read out of the adapter's source, not guessed. Where the model strains, the
 * comment says so rather than the mapping being quietly bent to fit.
 *
 * Sources:
 *   iobroker.iiyama-prolite   src/main.ts        v0.1.6
 *   iobroker.atlona-sw510w    main.js            v0.1.0
 *   iobroker.blustream-acm    main.js            v0.3.2
 *   iobroker.blustream-mfp    main.js            v0.5.3
 *   iobroker.blackmagic-atem  src/main.ts        v0.2.9
 */

import type { Resource, ResourceCollection } from "./model";

// ---------------------------------------------------------------------------
// iiyama ProLite — a display endpoint. The easy case.
// ---------------------------------------------------------------------------

export const iiyamaLobby: Resource = {
    id: "display.lobby",
    type: "display",
    name: "Lobby Display",
    owner: "iiyama-prolite.0",
    capabilities: [
        {
            id: "power",
            actions: [
                { kind: "set", id: "on", binding: { state: "iiyama-prolite.0.power" }, value: true },
                { kind: "set", id: "off", binding: { state: "iiyama-prolite.0.power" }, value: false },
                { kind: "toggle", id: "toggle", binding: { state: "iiyama-prolite.0.power" } },
            ],
            feedback: [{ id: "power", binding: { state: "iiyama-prolite.0.power" }, presentation: "boolean" }],
        },
        {
            id: "source",
            actions: [
                // The adapter publishes `common.states` on this object, so the
                // value space needs no duplication here.
                { kind: "route", id: "select", binding: { state: "iiyama-prolite.0.inputSource", values: { kind: "objectStates" } }, layer: "all" },
            ],
            feedback: [{ id: "source", binding: { state: "iiyama-prolite.0.inputSource", values: { kind: "objectStates" } }, presentation: "selection" }],
        },
        {
            id: "volume",
            actions: [{ kind: "level", id: "set", binding: { state: "iiyama-prolite.0.volume.main" }, min: 0, max: 100, step: 1 }],
            feedback: [{ id: "volume", binding: { state: "iiyama-prolite.0.volume.main" }, presentation: "number" }],
        },
        {
            id: "brightness",
            actions: [{ kind: "level", id: "set", binding: { state: "iiyama-prolite.0.video.brightness" }, min: 0, max: 100 }],
            feedback: [{ id: "brightness", binding: { state: "iiyama-prolite.0.video.brightness" }, presentation: "number" }],
        },
        {
            // Health is a capability like any other, so a surface can dim a
            // control whose device is gone without special-casing.
            id: "health",
            actions: [],
            feedback: [
                { id: "online", binding: { state: "iiyama-prolite.0.info.connection" }, presentation: "boolean" },
                { id: "operatingHours", binding: { state: "iiyama-prolite.0.info.operatingHours" }, presentation: "number" },
            ],
        },
    ],
};

// ---------------------------------------------------------------------------
// Atlona SW510W — a presentation switcher.
// ---------------------------------------------------------------------------

export const atlonaSwitcher: Resource = {
    id: "room1.switcher",
    type: "switcher",
    name: "Atlona SW510W",
    owner: "atlona-sw510w.0",
    capabilities: [
        {
            id: "source",
            // Identical shape to the iiyama input select, against a completely
            // different protocol. This is the abstraction working.
            actions: [{ kind: "route", id: "select", binding: { state: "atlona-sw510w.0.control.input", values: { kind: "objectStates" } }, layer: "all" }],
            feedback: [{ id: "source", binding: { state: "atlona-sw510w.0.control.input", values: { kind: "objectStates" } }, presentation: "selection" }],
        },
        {
            id: "routing",
            actions: [
                { kind: "route", id: "hdbaset", binding: { state: "atlona-sw510w.0.control.matrix.hdbasetOutput", values: { kind: "objectStates" } }, layer: "all" },
                { kind: "route", id: "hdmi", binding: { state: "atlona-sw510w.0.control.matrix.hdmiOutput", values: { kind: "objectStates" } }, layer: "all" },
            ],
            feedback: [
                { id: "hdbaset", binding: { state: "atlona-sw510w.0.control.matrix.hdbasetOutput", values: { kind: "objectStates" } }, presentation: "selection" },
                { id: "hdmi", binding: { state: "atlona-sw510w.0.control.matrix.hdmiOutput", values: { kind: "objectStates" } }, presentation: "selection" },
            ],
        },
        {
            id: "volume",
            actions: [
                { kind: "level", id: "set", binding: { state: "atlona-sw510w.0.control.volume" }, min: 0, max: 100 },
                { kind: "toggle", id: "mute", binding: { state: "atlona-sw510w.0.control.mute.analog" } },
            ],
            feedback: [
                { id: "volume", binding: { state: "atlona-sw510w.0.control.volume" }, presentation: "number" },
                { id: "muted", binding: { state: "atlona-sw510w.0.control.mute.analog" }, presentation: "boolean" },
            ],
        },
    ],
};

// ---------------------------------------------------------------------------
// Blustream ACM — matrix distribution. The case that shaped `RouteLayer`.
// ---------------------------------------------------------------------------

/** TX ids exist only at runtime, so the receivers' value space points here. */
export const acmTransmitters: ResourceCollection = {
    id: "room1.sources",
    type: "video-source",
    owner: "blustream-acm.0",
    members: "blustream-acm.0.transmitters.*",
    nameState: "name",
};

export const acmReceiver3: Resource = {
    id: "display.stage",
    type: "video-output",
    name: "Stage Receiver",
    owner: "blustream-acm.0",
    capabilities: [
        {
            id: "routing",
            // Six independent layers. A model with a single `source` concept
            // could not express breakaway at all; this is why `route` carries
            // a layer rather than a router carrying one source.
            actions: [
                { kind: "route", id: "all", binding: { state: "blustream-acm.0.receivers.rx3.route", values: { kind: "resourceIds", collection: "room1.sources" } }, layer: "all" },
                { kind: "route", id: "video", binding: { state: "blustream-acm.0.receivers.rx3.videoRoute", values: { kind: "resourceIds", collection: "room1.sources" } }, layer: "video" },
                { kind: "route", id: "audio", binding: { state: "blustream-acm.0.receivers.rx3.audioRoute", values: { kind: "resourceIds", collection: "room1.sources" } }, layer: "audio" },
            ],
            feedback: [
                { id: "video", binding: { state: "blustream-acm.0.receivers.rx3.videoRoute", values: { kind: "resourceIds", collection: "room1.sources" } }, presentation: "selection" },
                { id: "audio", binding: { state: "blustream-acm.0.receivers.rx3.audioRoute", values: { kind: "resourceIds", collection: "room1.sources" } }, presentation: "selection" },
            ],
        },
        {
            id: "power",
            actions: [{ kind: "toggle", id: "toggle", binding: { state: "blustream-acm.0.receivers.rx3.power" } }],
            feedback: [{ id: "power", binding: { state: "blustream-acm.0.receivers.rx3.power" }, presentation: "boolean" }],
        },
        {
            id: "health",
            actions: [],
            feedback: [
                { id: "online", binding: { state: "blustream-acm.0.receivers.rx3.connected" }, presentation: "boolean" },
                { id: "resolution", binding: { state: "blustream-acm.0.receivers.rx3.resolution" }, presentation: "text" },
            ],
        },
    ],
};

// ---------------------------------------------------------------------------
// Blustream MFP — presentation switching plus a microphone mixer.
// ---------------------------------------------------------------------------

export const mfpOutput1: Resource = {
    id: "room1.projector-feed",
    type: "video-output",
    owner: "blustream-mfp.0",
    capabilities: [
        {
            id: "routing",
            actions: [{ kind: "route", id: "audio", binding: { state: "blustream-mfp.0.output.1.audioSource", values: { kind: "objectStates" } }, layer: "audio" }],
            feedback: [{ id: "audio", binding: { state: "blustream-mfp.0.output.1.audioSource", values: { kind: "objectStates" } }, presentation: "selection" }],
        },
        {
            id: "picture",
            actions: [
                { kind: "level", id: "brightness", binding: { state: "blustream-mfp.0.output.1.brightness" }, min: 0, max: 100 },
                { kind: "level", id: "contrast", binding: { state: "blustream-mfp.0.output.1.contrast" }, min: 0, max: 100 },
            ],
            feedback: [{ id: "brightness", binding: { state: "blustream-mfp.0.output.1.brightness" }, presentation: "number" }],
        },
    ],
};

/**
 * The microphone mixer is the first thing that does not fit a shared
 * vocabulary: autoBg, bgDelay, rampUp, rampDown and mixMode are specific to
 * this product. The model accommodates it only because capability ids are
 * open — but nothing generic can render it, which is exactly the limit the
 * brief's section 29 predicted.
 */
export const mfpMicrophone: Resource = {
    id: "room1.microphone",
    type: "audio-mixer",
    owner: "blustream-mfp.0",
    capabilities: [
        {
            id: "microphone",
            actions: [
                { kind: "level", id: "volume", binding: { state: "blustream-mfp.0.microphone.volume" }, min: 0, max: 100 },
                { kind: "toggle", id: "mute", binding: { state: "blustream-mfp.0.microphone.mute" } },
                { kind: "level", id: "rampUp", binding: { state: "blustream-mfp.0.microphone.rampUp" }, min: 0, max: 10 },
            ],
            feedback: [{ id: "muted", binding: { state: "blustream-mfp.0.microphone.mute" }, presentation: "boolean" }],
        },
    ],
};

// ---------------------------------------------------------------------------
// Blackmagic ATEM — the hardest case, and the one that proved `route`.
// ---------------------------------------------------------------------------

export const atemInputs: ResourceCollection = {
    id: "atem.sources",
    type: "video-source",
    owner: "blackmagic-atem.0",
    members: "blackmagic-atem.0.input.*",
    nameState: "longName",
};

/**
 * Program and preview are two outputs of one mix effect, and selecting an
 * input for them is the same `route` operation as a Blustream receiver taking
 * a transmitter — different protocol, different value type, same semantics.
 */
export const atemProgram: Resource = {
    id: "atem.me1.program",
    type: "video-output",
    name: "ATEM Program",
    owner: "blackmagic-atem.0",
    capabilities: [
        {
            id: "source",
            actions: [{ kind: "route", id: "select", binding: { state: "blackmagic-atem.0.me0.programInput", values: { kind: "resourceIds", collection: "atem.sources" } }, layer: "video" }],
            feedback: [
                { id: "source", binding: { state: "blackmagic-atem.0.me0.programInput", values: { kind: "resourceIds", collection: "atem.sources" } }, presentation: "selection" },
                { id: "inTransition", binding: { state: "blackmagic-atem.0.me0.inTransition" }, presentation: "boolean" },
            ],
        },
    ],
};

/**
 * Recording is a transport, not a source or a level. It maps cleanly, which is
 * reassuring — but `recording.status` is an enum whose meaning lives in the
 * adapter, so the surface depends on `common.states` being published.
 */
export const atemRecording: Resource = {
    id: "atem.recording",
    type: "recorder",
    owner: "blackmagic-atem.0",
    capabilities: [
        {
            id: "transport",
            actions: [],
            feedback: [
                { id: "status", binding: { state: "blackmagic-atem.0.recording.status", values: { kind: "objectStates" } }, presentation: "selection" },
                { id: "duration", binding: { state: "blackmagic-atem.0.recording.duration" }, presentation: "number" },
                { id: "diskSpace", binding: { state: "blackmagic-atem.0.recording.remainingDiskSpace" }, presentation: "number" },
            ],
        },
    ],
};

// ---------------------------------------------------------------------------
// Deliberate non-AV stress cases
// ---------------------------------------------------------------------------

/**
 * Sky remote: navigation only. Every button is `read: false, write: true`, so
 * there is literally no value to read back and `feedback` is empty. The model
 * permits that, which is correct — but it means a renderer must cope with a
 * control that can never reflect reality, and TouchBroker's schema already has
 * `mode: "write"` for exactly this.
 */
export const skyBox: Resource = {
    id: "lounge.skybox",
    type: "media-player",
    owner: "sky-remote.0",
    capabilities: [
        {
            id: "navigation",
            actions: [
                { kind: "set", id: "up", binding: { state: "sky-remote.0.buttons.up" }, value: true },
                { kind: "set", id: "down", binding: { state: "sky-remote.0.buttons.down" }, value: true },
                { kind: "set", id: "select", binding: { state: "sky-remote.0.buttons.select" }, value: true },
                { kind: "set", id: "back", binding: { state: "sky-remote.0.buttons.backup" }, value: true },
            ],
            feedback: [],
        },
        {
            id: "power",
            // No power feedback exists: the adapter is one-way IR/IP control.
            actions: [{ kind: "set", id: "toggle", binding: { state: "sky-remote.0.buttons.power" }, value: true }],
            feedback: [],
        },
    ],
};

/**
 * A vehicle: capabilities with no AV meaning whatsoever, mostly read-only, and
 * under a per-VIN branch rather than a flat tree. It maps without strain, which
 * is the point — the vocabulary in the brief's section 41 is a convention, not
 * a schema.
 *
 * It also demonstrates something the AV adapters mostly hide: the action's
 * target state and the feedback's target state are different objects
 * (`commands.lock` is written, `doors.locked` is read). The model carries a
 * binding per action and per feedback rather than one per capability for this
 * reason.
 */
export const vehicle: Resource = {
    id: "car.omoda",
    type: "vehicle",
    owner: "omoda.0",
    capabilities: [
        {
            id: "charging",
            actions: [],
            feedback: [
                { id: "soc", binding: { state: "omoda.0.TESTVIN0000000001.battery.soc" }, presentation: "number" },
                { id: "plugged", binding: { state: "omoda.0.TESTVIN0000000001.charging.plugConnected" }, presentation: "boolean" },
                { id: "range", binding: { state: "omoda.0.TESTVIN0000000001.battery.rangeElectric" }, presentation: "number" },
            ],
        },
        {
            id: "lock",
            actions: [{ kind: "set", id: "lock", binding: { state: "omoda.0.TESTVIN0000000001.commands.lock" }, value: true }],
            feedback: [{ id: "locked", binding: { state: "omoda.0.TESTVIN0000000001.doors.locked" }, presentation: "boolean" }],
        },
    ],
};

export const allMapped: ReadonlyArray<Resource> = [
    iiyamaLobby,
    atlonaSwitcher,
    acmReceiver3,
    mfpOutput1,
    mfpMicrophone,
    atemProgram,
    atemRecording,
    skyBox,
    vehicle,
];

export const allCollections: ReadonlyArray<ResourceCollection> = [acmTransmitters, atemInputs];
