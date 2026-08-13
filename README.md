# Standalone Cassowary + Seedbell 17

This directory contains a readable, standalone browser reproduction for iOS
17.0 through 17.2.1. It has no Coruna loader, module manager, platform state,
or hashed module dependencies.

## Layout

- `standalone/index.html` preserves the working OWN Cassowary trigger and
  bootstrap memory layout, retries the compiler race in fresh workers, and
  runs the complete chain.
- `standalone/wasm-memory.js` migrates the short-lived butterfly primitive into
  two WebAssembly global cells and repairs the corrupted bootstrap object.
- `standalone/macho.js` parses Mach-O images, the shared-cache image table,
  export tries, ARM64 instructions, and target patterns.
- `standalone/targets.js` resolves every named Seedbell target.
- `standalone/core.js` constructs the PACIA, PACDA, AUTIA, and AUTDA oracle.
- `standalone/native.js` exposes the four-argument native-call primitive and
  typed `malloc`, `free`, `memset`, and `memmove` wrappers.
- `standalone/seedbell.js` assembles and verifies the standalone Seedbell chain.
- `fixture.ts` serves the harness and records device logs.

## Run

```bash
bun cassowary17/seedbell17/fixture.ts
```

Open this URL on the target device:

```text
http://192.168.2.100:8137/
```

The iOS defaults are embedded in the harness:

```text
warmup = 16777216
pivot  = 131072
gc     = 1048576
max    = 100
```

The query parameters `warmup`, `pivot`, `gc`, and `max` override them.

## Success criteria

The final verification performs both instruction- and data-key PAC round trips,
then calls native `malloc`, `memset`, and `free`. A successful run reports:

```text
[SEEDBELL] shared-cache slide=0x1d18c000
[SEEDBELL] native memset readback=0x41414141
SEEDBELL17_STANDALONE_SUCCESS
```

## Verified device

The complete chain was reproduced twice after independent MobileSafari and
WebContent restarts on:

```text
iPhone14,4 (iPhone 13 mini)
iOS 17.0 (21A329)
arm64e with pointer authentication
```

The command-line JavaScriptCore host under `jsc-host/` is a layout diagnostic.
RootHide's SSH-spawned process runs JavaScriptCore with JIT disabled, so the
compiler race is executed in Safari WebContent. The RootHide process and
debugging behavior was checked against the local Relaxin source tree.
