# 11. Testing

[← Index](README.md)

## 11.1 Commands

```bash
deno test --allow-all     # all tests in tests/  (11 tests, all passing at the time of writing)
deno lint                 # clean
deno check main.ts        # clean
deno fmt --check          # currently fails on registry.ts (formatting only)
```

`deno task test` is broken: it points to a missing `test.ts` (KNOWN_ISSUES L15). Use
`deno test` directly.

## 11.2 Existing tests

| File | What it covers |
|---|---|
| [tests/maglumi_protocol_test.ts](../../tests/maglumi_protocol_test.ts) | Maglumi numbered and staged framing: TCP splits (including a lone STX), bad checksums, out-of-order frames, retransmission, ETB reassembly with frame-number wrap, discarding incomplete messages, outbound chunking |
| [tests/catalog_test.ts](../../tests/catalog_test.ts) | Catalog seeding and persistence, and wire lookups for iFlash, Maglumi, Kenza, Cobas, Sysmex, and Bonavera 200 parsers and builders |
| [tests/catalog_routes_test.ts](../../tests/catalog_routes_test.ts) | Catalog HTTP routes through `createMachineManagerHandler`, and default tests that respect disabled catalog entries |
| [tests/learned_timing_test.ts](../../tests/learned_timing_test.ts) | Learned estimates per profile, using a fake driver |

There are **no tests** for `AstmProtocol`, cobas, Sysmex framing, MLLP, Kenza, or the registry's
result matching. Most known bugs live in these areas.

## 11.3 Testing without a real analyzer

**1. Protocol unit tests with a fake connection.** Subclass the protocol to expose
`handleReadBytes`, and give it a `RawConnection` that records writes. Then feed bytes in any split
you like:

```ts
class TestProtocol extends AstmProtocol {
  feed(bytes: Uint8Array) { return this.handleReadBytes(bytes); }
}
const writes: Uint8Array[] = [];
const conn: RawConnection = {
  localAddr: { transport: 'tcp', hostname: '127.0.0.1', port: 1 },
  remoteAddr: { transport: 'tcp', hostname: '127.0.0.1', port: 2 },
  read: () => new Promise(() => {}),           // never used in feed() tests
  write: (b) => { writes.push(b.slice()); return Promise.resolve(b.length); },
  close() {},
};
const p = new TestProtocol(conn, { onMessage: (records) => { /* assert */ } });
await p.feed(Uint8Array.of(0x05));            // ENQ -> expect ACK (0x06) in writes
```

Use `computeAstmChecksum` to build valid frames (see the `frame()` helper in
`maglumi_protocol_test.ts`).

**2. Registry tests with a fake driver.** Extend a real driver (or `BaseMachine`), override
`configure`, `connect`, `start`, `shutdown`, and `sendOrder` so they do nothing, and call
`this.emit('order-sent' | 'result', …)` from test helpers. Point a `new MachineRegistry({dbPath})`
at a temp directory (`Deno.makeTempDirSync()`), `register()` the fake, `connectDatabase()`, and
`createProfile({enabled:true})`. See `learned_timing_test.ts`.

**3. Parser tests.** Call `parseIFlashMessage(parseAstmMessage(text), 'addr')`,
`parseMaglumiMessage`, `parseCobasC111Message`, `parseSysmexKx21nPayload`,
`parseBonavera200Hl7`, `parseBonaveraCountHl7`, `parseDrAccuResultLine`, or `parseKenzaPayload`
with captured text. Catalog lookups need a connected `SqliteMachineDatabase`, because
`managedCatalogTests` throws otherwise.

**4. End-to-end over TCP (simulator).** Start the SDK (`deno task dev`), create an enabled
profile for a TCP driver, then connect with a script that plays the analyzer:

```ts
const c = await Deno.connect({ hostname: '127.0.0.1', port: 7001 });
await c.write(Uint8Array.of(0x05));            // ENQ
// read ACK, then write frames built with computeAstmChecksum, then EOT
```

For HL7 drivers, wrap each message in `0x0B … 0x1C 0x0D`.

**5. Serial without hardware.** Use a virtual null-modem pair: com0com on Windows, or
`socat -d -d pty,raw,echo=0 pty,raw,echo=0` on Linux (remember that M12 upper-cases Linux paths).
Point the profile at one end and a script at the other. Turn on `SERIAL_TRACE=1` to see every
byte.

**6. Replay captured traffic.** Save the hex from a trace log (`serial RX … hex=…` or the Maglumi
`traceProtocol` lines) and feed it into the protocol test harness byte for byte. This is the best
way to turn a field problem into a regression test.
