class DirectNativeCall {
    constructor({ pacEngine, log }) {
        this.pacEngine = pacEngine;
        this.callback = pacEngine.callPrimitive;
        this.log = log;
    }

    callSigned(signedTarget, args = []) {
        if (args.length > 4) throw new Error("DirectNativeCall supports at most four arguments");
        const values = args.map(BigInt);
        while (values.length < 4) values.push(0n);
        this.log("[NATIVE] signed target=0x" + BigInt(signedTarget).toString(16));
        return this.callback.call({
            functionPointer: BigInt(signedTarget),
            argument0: values[0],
            argument1: values[1],
            argument2: values[2],
            argument3: values[3]
        });
    }

    call(target, args = []) {
        const signedTarget = this.pacEngine.pacda(BigInt(target), 0n);
        return this.callSigned(signedTarget, args);
    }
}

class NativeMemory {
    constructor({ nativeCall, pacEngine, targets }) {
        this.nativeCall = nativeCall;
        this.mallocPointer = pacEngine.pacda(targets.malloc, 0n);
        this.freePointer = pacEngine.pacda(targets.free, 0n);
        this.memsetPointer = pacEngine.pacda(targets.platformMemset, 0n);
        this.memmovePointer = pacEngine.pacda(targets.platformMemmove, 0n);
    }

    malloc(size) {
        return this.nativeCall.callSigned(this.mallocPointer, [BigInt(size)]);
    }

    free(address) {
        return this.nativeCall.callSigned(this.freePointer, [BigInt(address)]);
    }

    memset(address, value, size) {
        return this.nativeCall.callSigned(this.memsetPointer, [
            BigInt(address), BigInt(value), BigInt(size)
        ]);
    }

    memmove(destination, source, size) {
        return this.nativeCall.callSigned(this.memmovePointer, [
            BigInt(destination), BigInt(source), BigInt(size)
        ]);
    }
}

export function createNativeExecution({ targets, pacEngine, log = () => {} }) {
    const nativeCall = new DirectNativeCall({ pacEngine, log });
    const memory = new NativeMemory({ nativeCall, pacEngine, targets });
    return { nativeCall, memory };
}
