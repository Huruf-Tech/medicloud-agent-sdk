# 12. How-to Recipes

[← Index](README.md)

## 12.1 Add a new analyzer driver (step by step)

Before you write code, collect the analyzer's **host interface manual** and, if you can, a
**raw capture** of a real session. Write down: the transport (TCP server or client, or serial and
its settings), the framing (ASTM, HL7/MLLP, or vendor-specific), the order model (query, push, or
none), and where the sample ID sits in both directions.

### Step 1: Pick or build the protocol

- Standard ASTM with FN and checksum over TCP → `AstmProtocol` with an options object.
- Analyzer-specific byte behavior → a new variant in `protocols/<family>/variants/`
  (see 12.2).
- HL7 over MLLP → `MllpProtocol` or a small subclass that overrides `processUnframedInput`.

### Step 2: Add the driver id

Add `export const myAnalyzerMachineId = 'vendor-model';` to
[lib/constants.ts](../../lib/constants.ts).

### Step 3: Create `machines/myAnalyzer/`

```text
machines/myAnalyzer/
  index.ts     driver class
  inbound.ts   parse messages -> query | MachineResultEvent
  outbound.ts  build order / no-order / ack messages
  catalog.ts   seed tests + lookups via managedCatalogTests(id)
  astm.ts      (optional) protocol options
```

### Step 4: Write the driver class

Copy the shape of [machines/iflash/index.ts](../../machines/iflash/index.ts) (TCP query) or
[machines/bonaveraCount/index.ts](../../machines/bonaveraCount/index.ts) (HL7 with push):

```ts
export class MyAnalyzer extends BaseMachine {
  static readonly id = myAnalyzerMachineId;
  static readonly brand = 'VENDOR MODEL';
  static readonly protocol = { name: 'ASTM', version: 'E1394-97' } as const;
  static readonly transportType: DriverTransportType = 'tcp';
  static readonly models = ['vendor-model'] as const;
  static readonly configSchema = z.object({
    host: z.string().trim().min(1), port: z.number().int().min(1).max(65535),
  }).strict() satisfies MachineConfigSchema<MyConfig>;
  static readonly configFields = [ /* one entry per config key, for the UI */ ] as const satisfies DriverConfigField[];

  readonly id = MyAnalyzer.id; readonly brand = MyAnalyzer.brand; readonly model = 'Model';
  private configuration?: MyConfig;
  private protocol?: AstmProtocol;
  private readonly pendingOrders = new Map<string, MachineOrder>();

  configure(config: unknown) { /* throw if active */ this.configuration = MyAnalyzer.configSchema.parse(config); }
  async connect() {
    const com = new MachineCom({ kind: 'tcp-server', host: cfg.host, port: cfg.port });
    this.com = com; await com.connect(); this.watchConnection(com);
    this.protocol = new AstmProtocol(com, { ...OPTIONS,
      onMessage: (records, p) => this.handleMessage(records, p as AstmProtocol),
      onError: (e) => this.emit('error', e),
      onClose: () => { this.markStopped(); if (this.connected) this.markDisconnected(); } });
  }
  async start() { await this.protocol!.start(); this.markStarted(); }
  async shutdown() { /* stop timers, protocol.close(), await waitUntilClosed(), clear maps, markStopped, markDisconnected */ }
  sendOrder(order: MachineOrder) { /* validate tests; also delete any staged key with the same order.id */ this.pendingOrders.set(order.sampleId, order); return Promise.resolve(); }
  removeOrder(sampleId: string) { this.pendingOrders.delete(sampleId); return Promise.resolve(); }
}
```

Rules the registry depends on:

1. The constructor takes no arguments, and the instance `id` equals the static `id`.
2. `configure()` must throw on bad config **before** anything is opened.
3. Emit `connected` only after a real peer exists (`com.whenConnected()`).
4. After you write order bytes, emit `order-sent` with the **stored order including `id`**.
5. `await this.emit('result', event)` **before** you remove the staged order or ACK at the
   application level. If it throws, keep the order so that a retry can work.
6. Never touch SQLite from a driver.
7. In `onClose`, stop all timers and loops.
8. Emit `order-query` when the analyzer asks. That is how expired orders are cleaned up.

### Step 5: Map the results correctly

- Find the sample ID field from the manual and a capture. **Do not** fall back to the patient ID,
  and do not use fuzzy matching (see KNOWN_ISSUES C2 and L6).
- Make one `MachineResultEvent` per sample. Split at each `O` (or `OBR`) record if a message can
  hold several samples (H4).
- Set `assayNo` to a code that exists as an analyte `code` in your catalog.
- Keep the raw message in `raw`, for audits.

### Step 6: Add the catalog seed

Add an entry to `MANAGED_CATALOG_SEEDS` in [store/catalogSeeds.ts](../../store/catalogSeeds.ts).
If needed, add driver-specific checks in `validateDriverTest` in
[http/catalog.routes.ts](../../http/catalog.routes.ts).

### Step 7: Register the driver

In [machines/mod.ts](../../machines/mod.ts): `import { MyAnalyzer } from './myAnalyzer/index.ts';`,
then `machineRegistry.register(MyAnalyzer);` and `export * from './myAnalyzer/index.ts';`.

### Step 8: Test

Write protocol tests with byte splits, parser tests from real captures, and a fake-registry
test (see [page 11](11-testing.md)). Then run it against the analyzer with tracing on.

### Step 9: Document it

Add a section to [06-machines.md](06-machines.md).

## 12.2 Add a new protocol or variant

1. Decide on the family folder (`protocols/astm`, `protocols/hl7`, `protocols/serial`, or a new
   one). Name folders after the protocol, never the analyzer. Analyzer-specific variants go in
   `variants/`.
2. Extend `BaseProtocol<TMessage, TOutbound>`:
   - Set `protocolName` (and optionally `protocolVersion`).
   - Implement `processInput()` as a `while (bufferedByteLength > 0)` loop. Use `peekByte()` to
     decide. If a frame is incomplete, **return without consuming anything**. When a message is
     complete, call `deliverMessage()` (awaits) or `publishMessage()` (background; use this when
     the driver will `send()` and needs the read loop to receive ACKs).
   - Override `send()` inside `serializeSend()`. Install any reply waiter **before** writing.
     Use `writeBytes()` and `writeControl()` (they are serialized).
3. Handle these cases from the start: messages split anywhere (including a lone `STX`), two
   messages in one read, retransmitted frames (compare the frame number or the bytes), checksums,
   timeouts with a retry limit, `ENQ` contention, and a cap on the buffer size.
4. Put constants in `constants.ts` and checksums in `checksum.ts`, and write pure, testable helper
   functions.
5. Write byte-level tests like `tests/maglumi_protocol_test.ts`.

## 12.3 Other common tasks

- **Add a test to a catalog**: `POST /catalogs/:driverId/tests` (or change the seed for new
  installs).
- **Restart a machine after the analyzer reconnects**: `POST /profiles/:id/start`.
- **Change a running profile's config**: stop, then `PATCH`, then start.
- **Turn on byte tracing**: `SERIAL_TRACE=1` (serial), profile `trace: true` (cobas, Sysmex,
  Kenza), or `traceProtocol: true` (Maglumi).
