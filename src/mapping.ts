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
 *   iobroker.streamdeck       src/lib/streamdeck-types.ts  v0.5.0 (b8a3b0b)
 *   iobroker.samsung_tizen    main.js            v1.2.0
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
                {
                    kind: "route",
                    id: "select",
                    binding: { state: "iiyama-prolite.0.inputSource", values: { kind: "objectStates" } },
                    layer: "all",
                },
            ],
            feedback: [
                {
                    id: "source",
                    binding: { state: "iiyama-prolite.0.inputSource", values: { kind: "objectStates" } },
                    presentation: "selection",
                },
            ],
        },
        {
            id: "volume",
            actions: [
                {
                    kind: "level",
                    id: "set",
                    binding: { state: "iiyama-prolite.0.volume.main" },
                    min: 0,
                    max: 100,
                    step: 1,
                },
            ],
            feedback: [{ id: "volume", binding: { state: "iiyama-prolite.0.volume.main" }, presentation: "number" }],
        },
        {
            id: "brightness",
            actions: [
                { kind: "level", id: "set", binding: { state: "iiyama-prolite.0.video.brightness" }, min: 0, max: 100 },
            ],
            feedback: [
                { id: "brightness", binding: { state: "iiyama-prolite.0.video.brightness" }, presentation: "number" },
            ],
        },
        {
            // Health is a capability like any other, so a surface can dim a
            // control whose device is gone without special-casing.
            id: "health",
            actions: [],
            feedback: [
                { id: "online", binding: { state: "iiyama-prolite.0.info.connection" }, presentation: "boolean" },
                {
                    id: "operatingHours",
                    binding: { state: "iiyama-prolite.0.info.operatingHours" },
                    presentation: "number",
                },
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
            actions: [
                {
                    kind: "route",
                    id: "select",
                    binding: { state: "atlona-sw510w.0.control.input", values: { kind: "objectStates" } },
                    layer: "all",
                },
            ],
            feedback: [
                {
                    id: "source",
                    binding: { state: "atlona-sw510w.0.control.input", values: { kind: "objectStates" } },
                    presentation: "selection",
                },
            ],
        },
        {
            id: "routing",
            actions: [
                {
                    kind: "route",
                    id: "hdbaset",
                    binding: {
                        state: "atlona-sw510w.0.control.matrix.hdbasetOutput",
                        values: { kind: "objectStates" },
                    },
                    layer: "all",
                },
                {
                    kind: "route",
                    id: "hdmi",
                    binding: { state: "atlona-sw510w.0.control.matrix.hdmiOutput", values: { kind: "objectStates" } },
                    layer: "all",
                },
            ],
            feedback: [
                {
                    id: "hdbaset",
                    binding: {
                        state: "atlona-sw510w.0.control.matrix.hdbasetOutput",
                        values: { kind: "objectStates" },
                    },
                    presentation: "selection",
                },
                {
                    id: "hdmi",
                    binding: { state: "atlona-sw510w.0.control.matrix.hdmiOutput", values: { kind: "objectStates" } },
                    presentation: "selection",
                },
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
    // Redundant with the id segment here (`transmitters.007` routes as `007`),
    // but the ATEM proves that is not general, so it is always read.
    valueState: "id",
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
                {
                    kind: "route",
                    id: "all",
                    binding: {
                        state: "blustream-acm.0.receivers.rx3.route",
                        values: { kind: "resourceIds", collection: "room1.sources" },
                    },
                    layer: "all",
                },
                {
                    kind: "route",
                    id: "video",
                    binding: {
                        state: "blustream-acm.0.receivers.rx3.videoRoute",
                        values: { kind: "resourceIds", collection: "room1.sources" },
                    },
                    layer: "video",
                },
                {
                    kind: "route",
                    id: "audio",
                    binding: {
                        state: "blustream-acm.0.receivers.rx3.audioRoute",
                        values: { kind: "resourceIds", collection: "room1.sources" },
                    },
                    layer: "audio",
                },
            ],
            feedback: [
                {
                    id: "video",
                    binding: {
                        state: "blustream-acm.0.receivers.rx3.videoRoute",
                        values: { kind: "resourceIds", collection: "room1.sources" },
                    },
                    presentation: "selection",
                },
                {
                    id: "audio",
                    binding: {
                        state: "blustream-acm.0.receivers.rx3.audioRoute",
                        values: { kind: "resourceIds", collection: "room1.sources" },
                    },
                    presentation: "selection",
                },
            ],
        },
        {
            id: "power",
            actions: [{ kind: "toggle", id: "toggle", binding: { state: "blustream-acm.0.receivers.rx3.power" } }],
            feedback: [
                { id: "power", binding: { state: "blustream-acm.0.receivers.rx3.power" }, presentation: "boolean" },
            ],
        },
        {
            id: "health",
            actions: [],
            feedback: [
                {
                    id: "online",
                    binding: { state: "blustream-acm.0.receivers.rx3.connected" },
                    presentation: "boolean",
                },
                {
                    id: "resolution",
                    binding: { state: "blustream-acm.0.receivers.rx3.resolution" },
                    presentation: "text",
                },
            ],
        },
    ],
};

/**
 * The ACM matrix itself, which exists to carry the broadcast routes.
 *
 * These were missed by the first survey — it read the receivers and never looked
 * at `system.commands.*` — and they are what forced `RouteScope`. Each takes a
 * transmitter id and routes *every* display, and each belongs to `system` rather
 * than to any receiver, so there is no destination resource to hang them off.
 * The matrix is that resource.
 *
 * Same value space as a per-receiver route: the adapter runs the written value
 * through `sanitizeDeviceId`, the same normalisation the per-receiver routing
 * states get.
 *
 * There is no feedback. A broadcast leaves no state of its own to read — what
 * changes is every receiver's own route — so `display.stage`'s routing feedback
 * is where the result shows up. This is the ATEM transport split again, in a
 * shape that has no readable counterpart at all.
 */
export const acmMatrix: Resource = {
    id: "room1.matrix",
    type: "matrix",
    name: "Blustream ACM",
    owner: "blustream-acm.0",
    capabilities: [
        {
            id: "routing",
            actions: [
                {
                    kind: "route",
                    id: "all",
                    binding: {
                        state: "blustream-acm.0.system.commands.routeAll",
                        values: { kind: "resourceIds", collection: "room1.sources" },
                    },
                    layer: "all",
                    scope: "all",
                },
                {
                    kind: "route",
                    id: "allVideo",
                    binding: {
                        state: "blustream-acm.0.system.commands.routeAllVideo",
                        values: { kind: "resourceIds", collection: "room1.sources" },
                    },
                    layer: "video",
                    scope: "all",
                },
                {
                    kind: "route",
                    id: "allAudio",
                    binding: {
                        state: "blustream-acm.0.system.commands.routeAllAudio",
                        values: { kind: "resourceIds", collection: "room1.sources" },
                    },
                    layer: "audio",
                    scope: "all",
                },
            ],
            feedback: [],
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
            actions: [
                {
                    kind: "route",
                    id: "audio",
                    binding: { state: "blustream-mfp.0.output.1.audioSource", values: { kind: "objectStates" } },
                    layer: "audio",
                },
            ],
            feedback: [
                {
                    id: "audio",
                    binding: { state: "blustream-mfp.0.output.1.audioSource", values: { kind: "objectStates" } },
                    presentation: "selection",
                },
            ],
        },
        {
            id: "picture",
            actions: [
                {
                    kind: "level",
                    id: "brightness",
                    binding: { state: "blustream-mfp.0.output.1.brightness" },
                    min: 0,
                    max: 100,
                },
                {
                    kind: "level",
                    id: "contrast",
                    binding: { state: "blustream-mfp.0.output.1.contrast" },
                    min: 0,
                    max: 100,
                },
            ],
            feedback: [
                { id: "brightness", binding: { state: "blustream-mfp.0.output.1.brightness" }, presentation: "number" },
            ],
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
                {
                    kind: "level",
                    id: "volume",
                    binding: { state: "blustream-mfp.0.microphone.volume" },
                    min: 0,
                    max: 100,
                },
                { kind: "toggle", id: "mute", binding: { state: "blustream-mfp.0.microphone.mute" } },
                {
                    kind: "level",
                    id: "rampUp",
                    binding: { state: "blustream-mfp.0.microphone.rampUp" },
                    min: 0,
                    max: 10,
                },
            ],
            feedback: [{ id: "muted", binding: { state: "blustream-mfp.0.microphone.mute" }, presentation: "boolean" }],
        },
    ],
};

// ---------------------------------------------------------------------------
// Blackmagic ATEM — the hardest case, and the one that proved `route`.
// ---------------------------------------------------------------------------

/**
 * Corrected 2026-09-11: `members` was `blackmagic-atem.0.input.*`, which does
 * not exist. The tree is `inputs.input<N>` (`src/main.ts`, "const stateId =
 * `inputs.input${inputId}`"), so the pattern needs both segments.
 *
 * The same correction forced `valueState`. The member id segment is `input3`
 * but `me0.programInput` takes the number `3`, published as `inputId`. The ACM
 * differs — `transmitters.007` routes as `007` — so there is no rule that
 * recovers the value from the id, and it has to be read.
 */
export const atemInputs: ResourceCollection = {
    id: "atem.sources",
    type: "video-source",
    owner: "blackmagic-atem.0",
    members: "blackmagic-atem.0.inputs.input*",
    nameState: "longName",
    valueState: "inputId",
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
            actions: [
                {
                    kind: "route",
                    id: "select",
                    binding: {
                        state: "blackmagic-atem.0.me0.programInput",
                        values: { kind: "resourceIds", collection: "atem.sources" },
                    },
                    layer: "video",
                },
            ],
            feedback: [
                {
                    id: "source",
                    binding: {
                        state: "blackmagic-atem.0.me0.programInput",
                        values: { kind: "resourceIds", collection: "atem.sources" },
                    },
                    presentation: "selection",
                },
                {
                    id: "inTransition",
                    binding: { state: "blackmagic-atem.0.me0.inTransition" },
                    presentation: "boolean",
                },
            ],
        },
    ],
};

/**
 * Recording is a transport, and it is the clearest verified case of an action
 * and its feedback binding to *different* states: `recording.start` and
 * `recording.stop` are `read: false, write: true` buttons, while the observable
 * truth is `recording.status`. The adapter's own `macros.run` carries the same
 * split in its description — "write-only trigger, use macros.runningIndex to
 * read the active macro". This is why binding sits on each `ActionDef` and each
 * `FeedbackDef` rather than once per capability.
 *
 * `recording.status` is an enum whose meaning lives in the adapter, so the
 * surface depends on `common.states` being published.
 */
export const atemRecording: Resource = {
    id: "atem.recording",
    type: "recorder",
    owner: "blackmagic-atem.0",
    capabilities: [
        {
            id: "transport",
            actions: [
                { kind: "set", id: "start", binding: { state: "blackmagic-atem.0.recording.start" }, value: true },
                { kind: "set", id: "stop", binding: { state: "blackmagic-atem.0.recording.stop" }, value: true },
                {
                    kind: "set",
                    id: "switchDisk",
                    binding: { state: "blackmagic-atem.0.recording.switchDisk" },
                    value: true,
                },
            ],
            feedback: [
                {
                    id: "status",
                    binding: { state: "blackmagic-atem.0.recording.status", values: { kind: "objectStates" } },
                    presentation: "selection",
                },
                { id: "duration", binding: { state: "blackmagic-atem.0.recording.duration" }, presentation: "number" },
                {
                    id: "diskSpace",
                    binding: { state: "blackmagic-atem.0.recording.remainingDiskSpace" },
                    presentation: "number",
                },
            ],
        },
    ],
};

// ---------------------------------------------------------------------------
// Stress case: control without any feedback at all
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

// ---------------------------------------------------------------------------
// Stream Deck — a *surface* mapped as an ordinary resource
// ---------------------------------------------------------------------------

/**
 * This is the evidence for decision 1: a rendering endpoint needs no `Surface`
 * interface, because it is a resource like any other.
 *
 * `iobroker.streamdeck` already publishes, per deck, exactly the fleet
 * attributes the brief's section 20 asks for — `currentPageId`, `connected`,
 * `lastHeartbeat`, `model`, `firmware`, `host` — as ordinary ioBroker states
 * (`DECK_STATE_SUFFIXES` in `src/lib/streamdeck-types.ts`). So navigating a
 * panel to a page is a `select` against `currentPageId`, and is the same kind
 * of operation as switching a projector input. A scene that ends
 * "…then take the reception panel to the presentation page" needs no second
 * code path.
 *
 * Note `renderManifestJson` and `selectedScreenId` are `write: false` and
 * adapter-owned, and `groupStateJson` is changed through `commands.setGroupState`
 * rather than by direct write. None of that is this layer's business — it is
 * the panel runtime's — which is the point.
 */
export const receptionPanel: Resource = {
    id: "surface.reception",
    type: "surface",
    name: "Reception Stream Deck",
    owner: "streamdeck.0",
    capabilities: [
        {
            id: "navigation",
            // No `objectStates` here: the page list lives inside the deck's
            // `layoutJson` document, not in `common.states`. A value space for
            // this is genuinely unresolved — see `docs/architecture/model.md`.
            actions: [{ kind: "select", id: "page", binding: { state: "streamdeck.0.decks.reception.currentPageId" } }],
            feedback: [
                { id: "page", binding: { state: "streamdeck.0.decks.reception.currentPageId" }, presentation: "text" },
            ],
        },
        {
            id: "health",
            actions: [],
            feedback: [
                { id: "online", binding: { state: "streamdeck.0.decks.reception.connected" }, presentation: "boolean" },
                {
                    id: "lastSeen",
                    binding: { state: "streamdeck.0.decks.reception.lastHeartbeat" },
                    presentation: "number",
                },
                { id: "model", binding: { state: "streamdeck.0.decks.reception.model" }, presentation: "text" },
                { id: "firmware", binding: { state: "streamdeck.0.decks.reception.firmware" }, presentation: "text" },
                { id: "host", binding: { state: "streamdeck.0.decks.reception.host" }, presentation: "text" },
            ],
        },
    ],
};

// ---------------------------------------------------------------------------
// Samsung Tizen TV — verified against real hardware, and the first to be
// ---------------------------------------------------------------------------

/**
 * A Samsung UE43DU7100KXXU, mapped and then run against the actual set.
 *
 * Three things here are worth more than the mapping itself.
 *
 * **Absolute power exists, but the adapter synthesises it.** `KEY_POWERON` and
 * `KEY_POWEROFF` are not keys the TV has: `onoff()` in the adapter reads the
 * current power state and then either does nothing, sends Wake-on-LAN, or sends
 * the *toggle* `KEY_POWER`. So the read-then-act dance `iobroker-react` performs
 * by hand in `tvSetPower()` is already done one layer down, and this model gets
 * idempotent power for free — as two `set` actions, not a `toggle`.
 *
 * **Every control is a momentary button**, `role: "button"`, boolean, with no
 * readable value. `KEY_POWER` is therefore a `set` of `true`, exactly like a
 * sky-remote button, and *not* the `toggle` kind — there is nothing to invert.
 *
 * **The only readable state is a proxy.** `info.available` is
 * `role: "indicator.reachable"`, and the adapter fills it from a TCP port check
 * that it also uses as its power answer. It is not the TV reporting its power;
 * it is the network answering for it. The model has no way to say a reading is
 * inferred rather than reported, which is a real gap and is recorded as one.
 */
export const samsungTv: Resource = {
    id: "display.meeting",
    type: "display",
    name: "Meeting Room TV",
    owner: "samsung_tizen.0",
    capabilities: [
        {
            id: "power",
            actions: [
                { kind: "set", id: "on", binding: { state: "samsung_tizen.0.control.KEY_POWERON" }, value: true },
                { kind: "set", id: "off", binding: { state: "samsung_tizen.0.control.KEY_POWEROFF" }, value: true },
                { kind: "set", id: "toggle", binding: { state: "samsung_tizen.0.control.KEY_POWER" }, value: true },
            ],
            // Named `reachable`, not `power`, because that is what it measures.
            feedback: [
                { id: "reachable", binding: { state: "samsung_tizen.0.info.available" }, presentation: "boolean" },
            ],
        },
        {
            id: "source",
            // A display choosing its own input is a one-output matrix, so these
            // are `route` — but each input is its own button rather than a value
            // written to one state, which no other mapped device does.
            actions: [
                { kind: "route", id: "hdmi1", binding: { state: "samsung_tizen.0.control.KEY_HDMI1" }, layer: "all" },
                { kind: "route", id: "hdmi2", binding: { state: "samsung_tizen.0.control.KEY_HDMI2" }, layer: "all" },
                { kind: "route", id: "hdmi3", binding: { state: "samsung_tizen.0.control.KEY_HDMI3" }, layer: "all" },
                { kind: "route", id: "hdmi4", binding: { state: "samsung_tizen.0.control.KEY_HDMI4" }, layer: "all" },
            ],
            feedback: [],
        },
        {
            id: "volume",
            actions: [
                { kind: "set", id: "up", binding: { state: "samsung_tizen.0.control.KEY_VOLUP" }, value: true },
                { kind: "set", id: "down", binding: { state: "samsung_tizen.0.control.KEY_VOLDOWN" }, value: true },
                { kind: "set", id: "mute", binding: { state: "samsung_tizen.0.control.KEY_MUTE" }, value: true },
            ],
            feedback: [],
        },
    ],
};

export const allMapped: ReadonlyArray<Resource> = [
    iiyamaLobby,
    atlonaSwitcher,
    acmReceiver3,
    acmMatrix,
    mfpOutput1,
    mfpMicrophone,
    atemProgram,
    atemRecording,
    skyBox,
    receptionPanel,
    samsungTv,
];

export const allCollections: ReadonlyArray<ResourceCollection> = [acmTransmitters, atemInputs];
