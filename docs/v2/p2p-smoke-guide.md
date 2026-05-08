# P2P session — manual smoke guide (v2.1.6)

> Manual reproduction steps for the WebRTC P2P sync path while UI surface
> (`vscodesync.startP2PSession`) remains skeleton. This guide is the
> hand-off document a developer follows to verify all the pure pieces from
> v2.1 work end-to-end on a single machine before shipping the UI.

## What ships today

All pure modules are in `src/core/` and unit-tested:

| File                                | Purpose                                                                 |
|-------------------------------------|-------------------------------------------------------------------------|
| `p2pSignaling.ts`                   | offer / answer / ICE envelope encode + strict decode (run 0)            |
| `p2pSignalingChannel.ts`            | cloud paths `_p2p/{sid}/{kind}.json` + envelope shape (run 1)           |
| `p2pSignalingTransport.ts`          | `ICloudProvider`-backed write/poll/listIce/cleanup (run 1)              |
| `p2pCryptoEnvelope.ts`              | `[v=1][type:u8][seq:u32][rsv:u16][AES-256-GCM body]` framing (run 0)    |
| `p2pDataChannel.ts`                 | `wrapAuthenticated` over `@roamhq/wrtc` (run 0; lazy-load)              |
| `p2pFileTransfer.ts`                | chunk planner + assembler (run 2)                                       |
| `p2pSessionStateMachine.ts`         | discriminated-union lifecycle + exponential backoff (run 2)             |
| `p2pQrExchange.ts`                  | air-gapped QR-form fallback signaling (run 3)                           |

What is **not** wired yet:

- `vscodesync.startP2PSession` multi-step QuickPick.
- Status-bar widget (`$(broadcast) P2P: 1 peer`).
- Auto-disconnect on 5 min idle.

The goal of this smoke is to confirm every pure module composes without
touching the UI layer.

## Prereqs

- `npm i` — installs `@roamhq/wrtc` (optional dep, native binding may
  fail on some platforms; if it does, the smoke needs a different machine).
- A working OneDrive / Google Drive / Yandex / Dropbox account already
  configured in VSCodeSync.
- Two machines (or two VS Code Insiders windows running the extension
  host) sharing the same workspace.

If `@roamhq/wrtc` postinstall failed, you'll see a `BindingNotInstalled`
when the data-channel layer initialises — log lines from
`p2pDataChannel.ts:wrapAuthenticated`.

## Manual session walkthrough

### 1. Generate a fresh session id

```ts
import { newSessionId } from "../core/p2pSignaling.js";
const sessionId = newSessionId(); // 8..32 char [A-Za-z0-9_-]
```

### 2. Inviter side: write offer

```ts
import { createSignalingTransport } from "../ui/p2pSignalingTransport.js";
const transport = createSignalingTransport({
  provider: yourCloudProvider,
  workspaceWritable: true,
});
await transport.writeOffer(sessionId, offerSignal);
```

### 3. Invitee side: poll for offer, write answer

```ts
const offer = await transport.pollForOffer(sessionId, { timeoutMs: 60_000 });
// ... derive answer SDP from offer ...
await transport.writeAnswer(sessionId, answerSignal);
```

### 4. ICE exchange

Both sides write candidates to `_p2p/{sid}/ice/{candidateId}.json`:

```ts
await transport.writeIceCandidate(sessionId, candidateId, iceSignal);
const peerCandidates = await transport.listIceFromPeer(sessionId);
```

### 5. Authenticate the channel

Once `RTCDataChannel` is open, wrap it:

```ts
import { wrapAuthenticated } from "../core/p2pDataChannel.js";
const authChannel = wrapAuthenticated(channel, sharedKey);
```

### 6. Send a test file

```ts
import { planP2PFileChunks, encodeManifestPayload, encodeFileChunkPayload } from "../core/p2pFileTransfer.js";
const plan = planP2PFileChunks(localBuffer, { transferId, relPath: "smoke.txt" });
authChannel.sendFrame("manifest", encodeManifestPayload(plan.manifest));
plan.chunks.forEach((c, i) => authChannel.sendFrame("file_chunk", encodeFileChunkPayload(i, c)));
```

### 7. Receive on the other side

```ts
import { createChunkAssembler, decodeFileChunkPayload, decodeManifestPayload } from "../core/p2pFileTransfer.js";
let assembler;
authChannel.onFrame((type, payload) => {
  if (type === "manifest") {
    const r = decodeManifestPayload(payload);
    if (r.ok) assembler = createChunkAssembler(r.manifest);
  } else if (type === "file_chunk" && assembler) {
    const r = decodeFileChunkPayload(payload);
    if (r.ok) assembler.applyChunk(r.chunkIndex, r.chunk);
    if (assembler.isComplete()) {
      const fin = assembler.finalize();
      console.log("hashOk:", fin.ok && fin.hashOk);
    }
  }
});
```

### 8. Cleanup

After 5 min idle, the inviter or invitee runs:

```ts
await transport.cleanupSession(sessionId, idleSinceMs);
```

This deletes `_p2p/{sid}/` from the cloud. The session-state machine in
`p2pSessionStateMachine.ts` should be in `disconnected` state at this
point (verify via `machine.state.kind`).

## Air-gapped variant (no cloud signaling)

If the workspace is read-only or the cloud is offline, fall back to QR:

1. Inviter: `planQrChunks(JSON.stringify(offer), sessionId)` → array of QR
   chunks. Caller renders each via `qrcode-terminal` (optional dep) and
   prints to stdout.
2. Invitee scans → calls `parseQrChunkLine(line)` per scanned QR → feeds
   `pushChunk(line)` into `createQrAssembler()`. When `isComplete()`,
   `finalize()` returns the original offer JSON.
3. Reverse for the answer + ICE.

## Pass criteria

- [ ] `transport.pollForOffer` returns the inviter's offer within 5 s.
- [ ] `applyChunk` returns `ok: true` for every chunk on the receiver.
- [ ] `assembler.finalize().hashOk === true` (hash matches manifest).
- [ ] `machine.events` contains `p2p_session_started → connected → ended`.
- [ ] `_p2p/{sid}/` no longer exists in the cloud after `cleanupSession`.

## CI smoke (deferred)

A loopback peer test (single-process, two `RTCPeerConnection` instances
talking through the data channel) would automate the above on every PR.
It is held back because:

- `@roamhq/wrtc` has a native binding that may fail on the CI runner.
- Vitest-style timeouts (5 s) are tight for ICE negotiation.

Track the CI smoke item in `docs/v2/breakdown.md#v216` — the pure pieces
listed above are all individually tested; the integration smoke is the
missing link.
