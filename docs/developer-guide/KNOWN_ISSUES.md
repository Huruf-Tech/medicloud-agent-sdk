# Known Issues

This list comes from a full code review of `medicloud-agent-sdk` (November 2026).
Nothing here has been fixed yet. Each entry has:

- **Severity**: Critical, High, Medium, or Low.
- **Where**: file and line.
- **What is wrong** and a **concrete failure scenario**.
- **Suggested fix** in 1 to 3 lines.
- **Confidence**: *Confirmed* means the code path was traced and, where noted, reproduced
  with a small script against the real modules. *Likely* means the code clearly behaves this
  way, but whether it hurts depends on how the real analyzer behaves. Check it against a raw
  capture from the analyzer.

Entries are ordered most severe first. Agent-to-SDK usage mismatches are in their own section
at the end.

Back to the [guide index](README.md).

---

## Critical

### C1. Order lookups use substring `LIKE`, so results can attach to the wrong patient

- **Where**: [store/orderStore.ts:280](../../store/orderStore.ts) (`sample_id LIKE '%x%'`), used by
  `findResultOrder()` and `assertNoActiveOrderConflict()` in [registry.ts](../../registry.ts)
  (lines 1106 and 1129).
- **What is wrong**: `MachineOrderStore.query()` matches `sampleId` with `LIKE '%' || id || '%'`.
  The registry uses this same query to find *the* order for an incoming result. A substring is
  not an identity. `LIKE` is also case-insensitive and treats `_` and `%` as wildcards.
- **Failure scenario** (reproduced): an active order exists for sample `1234` (patient A). The
  analyzer uploads a result for sample `123` (patient B, no order). `findResultOrder(…, '123')`
  returns order `1234`. Patient B's values are stored on patient A's order, and that order is
  marked `completed`. The reverse also happens: when both `123` and `1234` are active, the newest
  match wins. Conflict checks give false "already has an active order" errors in the same way.
- **Suggested fix**: add an exact-match option (`sample_id = ?`) and use it for every registry
  lookup. Keep `LIKE` only for the HTTP search on `GET /orders`.
- **Confidence**: Confirmed (reproduced).

### C2. Bonavera Count "near match" assigns results to a different sample

- **Where**: [machines/bonaveraCount/index.ts:251](../../machines/bonaveraCount/index.ts)
  (`resolveCountSampleId`, `isNearSampleId`).
- **What is wrong**: if no staged order has the exact result sample ID, the driver looks for a
  staged order whose numeric ID differs by exactly **one digit**. If exactly one exists, the result
  is renamed to that sample.
- **Failure scenario**: an order for `100234` (patient A) is staged. The lab runs tube `100235`
  (patient B, ordered elsewhere or typed by hand). The ORU arrives with `OBR-2 = 100235`. The driver
  rewrites it to `100234`, and patient B's CBC is stored as patient A's result.
- **Suggested fix**: remove the fuzzy match. Store unmatched results for manual review instead.
- **Confidence**: Confirmed (code trace).

---

## High

### H1. Only the first result message per order is kept; later ones are silently dropped

- **Where**: [registry.ts:947-1010](../../registry.ts) (`persistResult`),
  [db/sqLite.ts:314](../../db/sqLite.ts) (`UNIQUE INDEX idx_machine_results_order`).
- **What is wrong**: the first result for an order inserts one row and marks the order
  `completed`. A second result message for the same sample finds no *active* order. The registry
  then sees an older result for that sample and returns without an error. The unique index on
  `order_id` would reject a second row anyway.
- **Failure scenario** (reproduced): an order `ZZ9` asks for tests `A` and `B`. The analyzer sends
  `A` in one message and `B` in a later one. Only `A` is stored, and `B` is lost with no log line.
  This always happens for DrAccu AFI-6100B, because its R-line parser makes one analyte per line
  ([machines/draccuAfi6100b/inbound.ts](../../machines/draccuAfi6100b/inbound.ts)). It also happens
  for any ASTM analyzer that uploads each assay when it finishes (common for iFlash and Maglumi).
- **Suggested fix**: allow several result rows per order (drop the unique index). Complete the
  order only when every ordered test has a result, or append analytes to the existing row.
- **Confidence**: Confirmed (reproduced). How much it hurts per analyzer is Likely.

### H2. A TCP-server profile dies after one disconnect and never recovers by itself

- **Where**: [transports/machineCom.ts:183-201](../../transports/machineCom.ts)
  (`acceptTcpConnection` closes the listener after one `accept()`),
  [registry.ts:864-876](../../registry.ts) (the `disconnected` handler removes the machine).
- **What is wrong**: the SDK accepts exactly one analyzer connection, then closes the listening
  socket. It does not enable TCP keepalive. When the peer disconnects, the registry drops the
  profile from `running`, and nothing restarts it. The agent never calls `/profiles/:id/start`
  (see A1).
- **Failure scenario**: the iFlash is rebooted overnight. (1) With a clean FIN, the profile is
  removed from `running`. Every new order then fails with `Machine profile N is not running` until
  someone presses Start. (2) With a power cut (no FIN), the old socket stays half-open forever. The
  profile still shows `connected: true`, but the analyzer cannot reconnect because nothing is
  listening. An analyzer that opens a second connection (for example, one for queries and one for
  results) is also refused.
- **Suggested fix**: keep the listener open and accept again after a disconnect. Call
  `conn.setKeepAlive(true)`. Add a supervised reconnect in the registry with backoff, and skip it
  during intentional shutdown.
- **Confidence**: Confirmed.

### H3. Kenza silently truncates sample IDs to 8 or 9 characters

- **Where**: [protocols/serial/records.ts:15,47](../../protocols/serial/records.ts) (`kenzaFixed`),
  [machines/biolaboKenza/index.ts:344](../../machines/biolaboKenza/index.ts) (`sendOrder` does not
  check the length).
- **What is wrong**: the Id9 field holds 9 characters. Longer IDs are cut without an error.
- **Failure scenario**: orders `LAB2024001` and `LAB2024002` are both sent as `LAB202400`. The
  analyzer sees two orders with the same ID. Results come back as `LAB202400`, which matches no
  stored order, so they are rejected and lost. Or they match a third order whose ID really is
  `LAB202400`.
- **Suggested fix**: in `sendOrder()`, reject sample IDs longer than `idLength`.
- **Confidence**: Confirmed (code trace).

### H4. Multi-sample ASTM uploads put every result on the first sample

- **Where**: [machines/iflash/inbound.ts:77](../../machines/iflash/inbound.ts),
  [machines/maglumi800/inbound.ts:92](../../machines/maglumi800/inbound.ts),
  [machines/rocheCobasC111/inbound.ts:62](../../machines/rocheCobasC111/inbound.ts),
  [machines/sysmexKx21n/inbound.ts:158](../../machines/sysmexKx21n/inbound.ts).
- **What is wrong**: each parser uses `records.find(type === 'O')` and then maps *all* `R` records
  to that one order. ASTM allows `H P O R R P O R R L` in a single message.
- **Failure scenario**: an analyzer sends a batch upload `H|… P|1 O|1|S1 R|1|…TSH|2.1 P|2 O|1|S2
  R|1|…TSH|9.8 L|1`. Both TSH values are stored under `S1`, and `S2` gets nothing.
- **Suggested fix**: walk the records in order and start a new result group at every `O`
  (or `P`). Emit one `result` event per group.
- **Confidence**: Likely (it depends on whether the analyzer batches; the code path is certain).

### H5. Sysmex ASTM-style uploads with one record per frame are lost

- **Where**: [machines/sysmexKx21n/index.ts:350-359](../../machines/sysmexKx21n/index.ts)
  (`normalizeFrame`).
- **What is wrong**: ASTM-style chunks are joined only across `ETB` frames. A frame ending in
  `ETX` is parsed on its own right away. Standard E1381 senders put each record in its own frame,
  ending with `ETX`, and send `EOT` only at the end of the message.
- **Failure scenario**: frames `1H|…ETX`, `2P|…ETX`, `3O|1|123…ETX`, `4R|1|^^^WBC|6.5…ETX` are
  each parsed alone. The `R` frame has no `O` record, so the sample becomes `UNKNOWN_<time>`. The
  registry rejects it with "no order found", and the CBC is lost.
- **Suggested fix**: buffer ASTM-style records until `EOT` (or until the `L` record) before
  parsing.
- **Confidence**: Likely (it depends on the site's framing; this was only tested with a
  single-frame session).

### H6. DrAccu: one unframed non-`R|` line blocks all later results

- **Where**: [protocols/hl7/variants/draccuAfi6100b.ts:27](../../protocols/hl7/variants/draccuAfi6100b.ts).
- **What is wrong**: `processUnframedInput` returns without consuming a line that does not start
  with `R|`. The line stays at the head of the buffer. Every later `R|` line sits behind it until
  the 64 KB buffer limit clears everything.
- **Failure scenario** (reproduced): the bytes `H|header\rR|S1|228|FRT|||||5.1|ng/mL|N|…\r` arrive.
  Nothing is delivered. Results are lost until an MLLP-framed message arrives (that path discards
  the stuck prefix) or the buffer overflows.
- **Suggested fix**: consume and log non-`R|` lines instead of returning.
- **Confidence**: Confirmed (reproduced). How often it happens depends on the device.

---

## Medium

### M1. Renaming an order's sample ID leaves the old sample staged in most drivers

- **Where**: [registry.ts:618](../../registry.ts) (`updateOrder` calls `sendOrder(merged)`). Affects
  `sendOrder` in iFlash, Maglumi, Cobas, Sysmex, and Kenza. DrAccu, Bonavera 200, and Bonavera
  Count handle this correctly.
- **What is wrong**: drivers key staged orders by `sampleId`. After `PATCH /orders/:id` with a new
  `sampleId`, the old key still exists.
- **Failure scenario**: an order is renamed `A1` → `A2` on Kenza. The push timer sends **both**
  `A1` and `A2`. The `order-sent` event for `A1` marks the DB order (now `A2`) as testing. Later,
  the `A1` result matches no order. The agent really uses this rename path (see A2).
- **Suggested fix**: in `updateOrder`, call `removeOrder(current.sampleId)` before `sendOrder`
  when the sample ID changes. Or copy the `order.id`-based cleanup from DrAccu into every driver.
- **Confidence**: Confirmed (code trace).

### M2. Generic ASTM and Cobas parsers accept retransmitted frames twice

- **Where**: [protocols/astm/link.ts:177-268](../../protocols/astm/link.ts),
  [protocols/astm/variants/cobasC111Serial.ts:191-267](../../protocols/astm/variants/cobasC111Serial.ts).
- **What is wrong**: the frame number is only checked for being `0`-`7`. It is never compared with
  the expected sequence. E1381 says a receiver must ACK and ignore a repeated frame. (The Maglumi
  variant does this correctly.)
- **Failure scenario** (reproduced for `AstmProtocol`): our ACK for frame `2R|1|^^^TSH|1.2` is lost
  to noise, and the analyzer resends frame 2. The driver receives two identical `R` records, so the
  analyte is stored twice. In Cobas, a repeated `ETB` chunk is glued into the middle of a record,
  which corrupts its fields.
- **Suggested fix**: track the expected frame number. Re-ACK and drop a frame equal to the previous
  one. NAK an out-of-sequence frame.
- **Confidence**: Confirmed.

### M3. Cobas sends never wait for ACK, so lost orders are still marked "testing"

- **Where**: [protocols/astm/variants/cobasC111Serial.ts:73-104,127](../../protocols/astm/variants/cobasC111Serial.ts).
- **What is wrong**: `send()` writes `ENQ`, waits 120 ms, writes frames, and writes `EOT`. It
  never checks for `ACK`. Peer `ACK`/`NAK` bytes are thrown away. The driver then emits
  `order-sent`.
- **Failure scenario**: the c111 is busy and replies `NAK` to our `ENQ`, or both sides send `ENQ`
  at the same moment. The order bytes are ignored by the analyzer, but the DB says `testing`, and
  push mode never sends it again (it skips `testing`). The sample is never run.
- **Suggested fix**: wait for `ACK` after `ENQ` and after each frame, retry on `NAK` up to 6 times,
  and back off on contention. Emit `order-sent` only after success.
- **Confidence**: Likely. The legacy code behaved the same way and was "tested", but there is no
  delivery guarantee.

### M4. ENQ contention: the host keeps waiting for its own ACK and the send fails

- **Where**: [protocols/astm/link.ts:149-155,291-302](../../protocols/astm/link.ts). The same
  pattern exists in [maglumi800.ts](../../protocols/astm/variants/maglumi800.ts).
- **What is wrong**: if the analyzer sends `ENQ` while we wait for an `ACK` to our `ENQ`, we ACK
  the analyzer (correct, because the instrument has priority). But we keep the old ACK waiter
  armed. The analyzer never ACKs our `ENQ`, so after 15 s `send()` throws `ASTM ACK timeout`, with
  no retry.
- **Failure scenario**: the iFlash sends a result upload just as we start a query reply. The query
  reply is lost, and the analyzer reports "no LIS response" for that sample.
- **Suggested fix**: on `ENQ` during `acquireLink`, cancel our attempt, receive the peer's message,
  then retry `ENQ` after the peer's `EOT` (E1381 section 8.2.7.1).
- **Confidence**: Likely.

### M5. The ACK waiter is armed after the write finishes, so a fast serial ACK can be missed

- **Where**: [protocols/astm/link.ts:291-313](../../protocols/astm/link.ts),
  [protocols/serial/link.ts:229-256](../../protocols/serial/link.ts).
- **What is wrong**: `await writeControl(ENQ)` resolves only when the serial helper reports
  `writeDone` after `drain`. A fast analyzer `ACK` can reach stdout before `writeDone`. At that
  moment there is no waiter, so the `ACK` is dropped as an unexpected byte.
- **Failure scenario**: Kenza at 19200 baud ACKs within 1 ms. The SDK waits 15 s, times out, and
  retries. The order push becomes slow or fails after 3 attempts. The Maglumi variant arms the
  waiter *before* writing, which is the right pattern.
- **Suggested fix**: install the waiter first, then write (as `Maglumi800AstmProtocol.writeAndWaitForReply` does).
- **Confidence**: Likely (it depends on timing).

### M6. One write error permanently breaks a Kenza link

- **Where**: [protocols/serial/link.ts:283](../../protocols/serial/link.ts) (`writeBytes`).
- **What is wrong**: `this.writeChain = this.writeChain.then(…)` has no `catch`. After one
  rejected write, every later write chains onto a rejected promise and fails at once. The
  connection is not closed, so the profile still looks running.
- **Failure scenario**: one helper `writeError` (for example, a brief USB-serial hiccup). From then
  on, every ACK to the analyzer and every order push fails until a manual restart.
- **Suggested fix**: keep the chain alive (`this.writeChain = op.catch(() => {})`) and return
  `op`, as `BaseProtocol.writeBytes` does.
- **Confidence**: Confirmed (code trace).

### M7. Background push and poll loops stop forever after one error

- **Where**: [machines/rocheCobasC111/index.ts:447,453](../../machines/rocheCobasC111/index.ts),
  [machines/draccuAfi6100b/index.ts:214](../../machines/draccuAfi6100b/index.ts),
  [machines/bonaveraCount/index.ts:327](../../machines/bonaveraCount/index.ts).
- **What is wrong**: Cobas loops exit on the first thrown `send()`. DrAccu and Bonavera Count set
  `failed = true` and never re-arm the push timer. The machine stays "running".
- **Failure scenario**: one failed ORM push (the socket is briefly busy). No later order is pushed
  until a restart, and nothing tells the operator.
- **Suggested fix**: catch errors per iteration, log them, and keep the loop or timer alive.
- **Confidence**: Confirmed.

### M8. Expired pending orders are still pushed by Kenza

- **Where**: [machines/biolaboKenza/index.ts:399-401](../../machines/biolaboKenza/index.ts),
  [registry.ts:890](../../registry.ts).
- **What is wrong**: the registry fails expired orders only when a driver emits `order-query`
  (and once at startup). Kenza never emits `order-query`, and its push filter does not check
  `expiresAt`.
- **Failure scenario**: an order expires overnight while the Kenza is off. In the morning it is
  still pushed and run, and the DB still says `pending`.
- **Suggested fix**: skip orders where `expiresAt <= now` in the Kenza push loop, and add a
  periodic registry sweep that fails expired pending orders.
- **Confidence**: Confirmed.

### M9. Cobas result sample ID prefers O field 4 over field 3

- **Where**: [machines/rocheCobasC111/inbound.ts:160-167](../../machines/rocheCobasC111/inbound.ts)
  (and `extractSampleId` at line 157 uses the *last* component for queries).
- **What is wrong**: E1394 O-3 is the specimen ID. O-4 is the instrument specimen ID, which on
  Roche systems usually holds `sequence^rack^position…`. The parser takes the first component of
  O-4 when it is non-empty. Queries take the last component instead, which is inconsistent.
- **Failure scenario**: `O|1|SAMPLE22|0^5001^1^^S1^SC|^^^767…` gives sample `0`. That matches no
  order, or it matches an order literally named `0`.
- **Suggested fix**: prefer O-3 and fall back to O-4. Confirm with a real c111 trace.
- **Confidence**: Likely.

### M10. iFlash R-record field positions differ from E1394 by one

- **Where**: [machines/iflash/inbound.ts:153-166](../../machines/iflash/inbound.ts).
- **What is wrong**: the reference range is read from field 7, the flag from 8, the status from
  10, and completion time from 14. In E1394 those are 6 (range), 7 (flags), 9 (status), and 13
  (date completed). Field 14 is the instrument ID.
- **Failure scenario**: with a standard record
  `R|1|69^TSH^^F|2.1|uIU/mL|0.27-4.2|N||F||||20260101120000`, the range is lost, the flag is
  empty, the status is empty, and `completedAt` is empty or the instrument name.
- **Suggested fix**: check against a real iFlash capture. If it is standard, use 6/7/9/13 (as
  Maglumi does).
- **Confidence**: Likely.

### M11. Bonavera 200 sample number comes from the digits of the sample ID

- **Where**: [machines/bonavera200/outbound.ts:90](../../machines/bonavera200/outbound.ts)
  (`sampleNo`), [machines/bonavera200/inbound.ts:62](../../machines/bonavera200/inbound.ts).
- **What is wrong**: DSP-22 is set to the first run of digits in `sampleId` (or `1`). Results use
  `OBR-2 || OBR-3`. If the analyzer leaves the barcode (OBR-2) empty, OBR-3 holds the numeric
  sample number.
- **Failure scenario**: orders `A-42` and `B-42` are both sent as sample number `42`. The result
  carries `42`, which matches neither order, or matches an order literally called `42`.
- **Suggested fix**: always correlate by the barcode (DSP-21 / OBR-2). Reject results without it,
  or keep a map from sample number to order ID.
- **Confidence**: Likely.

### M12. Serial helper upper-cases the port name

- **Where**: [lib/node-serial.mjs:23](../../lib/node-serial.mjs).
- **What is wrong**: `String(args.port).toUpperCase()`.
- **Failure scenario**: on Linux, `/dev/ttyUSB0` becomes `/DEV/TTYUSB0`. The open fails, so every
  serial driver is unusable on Linux and macOS.
- **Suggested fix**: upper-case only on Windows (`process.platform === 'win32'`).
- **Confidence**: Confirmed.

### M13. Orphaned serial helper keeps the COM port locked

- **Where**: [lib/node-serial.mjs:81-120](../../lib/node-serial.mjs).
- **What is wrong**: the helper never exits when its stdin closes (there is no
  `rl.on('close')`). If the Deno process crashes or is killed, `node` keeps the port open.
- **Failure scenario**: the agent crashes and is restarted by a service manager. The new helper
  gets "Access denied / port busy" until someone kills the stray `node.exe`.
- **Suggested fix**: on `rl.on('close')`, close the port and `process.exit(0)`.
- **Confidence**: Likely.

### M14. Results are ACKed before they are stored, and unmatched results are discarded

- **Where**: all protocols ACK at link level before `onMessage`. Then
  [registry.ts:952-963](../../registry.ts) throws `no order found`.
- **What is wrong**: a result with no matching active order is turned into an `error` event and
  logged. It is never stored anywhere, even though the analyzer has already been told "received".
- **Failure scenario**: a STAT sample is run before its order is synced from MediCloud. The result
  is gone, except for an error line in the console.
- **Suggested fix**: store unmatched results in a separate table (or with `order_id NULL`) for
  later manual matching.
- **Confidence**: Confirmed (this is the design).

### M15. Catalog test routes do not URL-decode the test code

- **Where**: [http/catalog.routes.ts:201](../../http/catalog.routes.ts)
  (`segments[2]` comes from `url.pathname`, which stays percent-encoded).
- **Failure scenario** (reproduced): `PUT /catalogs/iflash3000/tests/dsDNA%20IgG` returns
  `400 Test code cannot be changed`, and `DELETE` returns 404. Many iFlash and Maglumi codes
  contain spaces.
- **Suggested fix**: `decodeURIComponent(segments[2])` (and the same for `segments[0]`).
- **Confidence**: Confirmed.

### M16. `main.ts` ignores the HTTP env vars and exposes an unauthenticated API on all interfaces

- **Where**: [main.ts:44-45](../../main.ts), [http/utils.ts:37-40](../../http/utils.ts).
- **What is wrong**: `Deno.serve` is hard-coded to `0.0.0.0:5001`. `MEDICLOUD_MACHINES_HTTP_*`
  only feeds the unused `MachineManager.http` options. The API has no authentication and sends
  `Access-Control-Allow-Origin: *`.
- **Failure scenario**: anyone on the lab LAN, or any web page open in a browser on the PC (CORS
  preflight is allowed), can create orders, delete profiles, or rewrite catalogs.
- **Suggested fix**: use `manager.listen()`, or pass the env values to `Deno.serve`. Default to
  `127.0.0.1` and add a token check.
- **Confidence**: Confirmed.

### M17. `AstmProtocol` NAKs a frame when `STX` and the frame number arrive in different reads

- **Where**: [protocols/astm/link.ts:179-188,270-274](../../protocols/astm/link.ts).
- **What is wrong**: `hasFrameNumber()` returns `false` when only the `STX` byte is buffered.
  With `receiveFrameNumber: 'required'` the parser sends `NAK` and drops the `STX`. The rest of the
  frame is then thrown away byte by byte.
- **Failure scenario** (reproduced): TCP delivers `02` and then `31 48 7C …`. The SDK replies
  `15` (NAK). The analyzer must resend. It usually recovers, but with an unlucky split pattern it
  can hit the 6-retry limit. Maglumi and Cobas wait for more bytes instead.
- **Suggested fix**: if `bufferedByteLength < 2`, return `false` (wait) instead of NAKing.
- **Confidence**: Confirmed.

### M18. Generic ASTM does not reassemble `ETB` frames for iFlash

- **Where**: [machines/iflash/astm.ts](../../machines/iflash/astm.ts) (`reassembleEtbFrames: false`),
  [protocols/astm/link.ts:256-264](../../protocols/astm/link.ts).
- **What is wrong**: each frame is treated as complete record text. A record longer than about
  240 characters, which the sender must split with `ETB`, becomes two broken records.
- **Failure scenario**: a long `P` or `C` (comment) record is split. The second half is parsed as
  a record whose type is the first field of the continuation text, and some fields are lost.
- **Suggested fix**: set `reassembleEtbFrames: true` for iFlash after a capture test.
- **Confidence**: Likely.

---

## Low

### L1. `main.ts` shutdown does not stop its own HTTP server

[main.ts](../../main.ts) creates `Deno.serve` directly, but `manager.shutdown()` stops only
`manager.httpServer`, which is `undefined`. After Ctrl+C the machines stop but the process keeps
running until a second signal. **Fix**: keep the server handle and `await server.shutdown()`.
*Confirmed.*

### L2. Serial helper data received just before exit is dropped

[transports/serialConn.ts:335-349,552-563](../../transports/serialConn.ts): `read()` throws
`readError` even when chunks are still queued. The last result bytes before a helper crash are
lost. **Fix**: drain `chunks` first, then throw. *Confirmed.*

### L3. Serial open has no timeout, and startup is sequential

[transports/machineCom.ts:171](../../transports/machineCom.ts) waits on `connection.opened`
forever. `startProfiles()` starts profiles one after another. A helper stuck in its first-run
`npm install serialport` (no internet) blocks every later profile at boot.
**Fix**: add an open timeout and start profiles in parallel. *Likely.*

### L4. HL7 parsing ignores MSH-declared delimiters and escape sequences

[protocols/hl7/link.ts](../../protocols/hl7/link.ts) always splits on `|`, `^`, and `~`, and never
decodes `\F\ \S\ \T\ \R\ \E\`. A value or name containing an escaped delimiter is stored raw.
*Confirmed.* ASTM is similar: [records.ts](../../protocols/astm/records.ts) uses fixed `| \ ^ &`
and ignores the delimiters declared in the H record. *Confirmed.*

### L5. UTF-8 is decoded per frame in generic ASTM

[protocols/astm/link.ts:246-252](../../protocols/astm/link.ts): with `reassembleEtbFrames`, each
frame is decoded separately. A multi-byte character split across `ETB` frames becomes `�`.
**Fix**: concatenate the bytes, then decode (as Maglumi uses `stream: true`). *Confirmed.*

### L6. Result sample ID falls back to patient ID or name

Maglumi, Cobas, Sysmex, and Bonavera Count use `sampleId || patientId || patientName ||
UNKNOWN_…`. A result with no specimen ID can match an order whose sample ID equals that patient
ID. **Fix**: never use patient fields as the sample key. *Confirmed (code).*

### L7. `estimatedMinutes` and `reconnectDelayMs` config fields have no effect

The registry's `order-sent` handler recomputes the estimate from learned statistics only
([registry.ts:897-915](../../registry.ts)), so driver `estimatedMinutes` values are discarded.
Sysmex `estimatedMinutes` is never read. `reconnectDelayMs` is passed to the helper but never
used. The UI shows these fields as if they work. *Confirmed.*

### L8. Domain errors return HTTP 500

Registry errors such as "already has an active order", "is not running", and "expired" are plain
`Error`s, so [http/utils.ts](../../http/utils.ts) maps them to `500 internal error`. Clients
cannot tell a conflict from a crash. **Fix**: throw `HttpError(…, 409/400)`. *Confirmed.*

### L9. CORS allow-methods does not list `PUT`

[http/utils.ts:39](../../http/utils.ts). When the SDK serves HTTP itself, browsers block
`PUT /catalogs/:driverId/tests/:code`. (The agent's Hono `cors()` hides this.) *Confirmed.*

### L10. Kenza result decoding drops a last group without padding

[protocols/serial/records.ts](../../protocols/serial/records.ts) `decodeKenzaResult` reads groups
only while `cursor + 12 <= length`. If the analyzer trims trailing spaces of the last result, that
test is lost. *Likely.*

### L11. DrAccu reference range order looks reversed

[machines/draccuAfi6100b/inbound.ts](../../machines/draccuAfi6100b/inbound.ts): `highReference =
fields[5]`, `lowReference = fields[6]`. Verify with a capture. *Likely.*

### L12. Sysmex strips leading zeros from sample IDs by default

`stripSampleLeadingZeroes` defaults to `true`, so an LIS order `00123` never matches a result
`000000123` → `123`. **Fix**: normalize both sides the same way, or default to `false`.
*Confirmed.*

### L13. Profile config is not validated when a profile is created or edited while disabled

[registry.ts:538,563](../../registry.ts) store any JSON object. Errors appear only on start.
**Fix**: call `Driver.configSchema.parse()` in `createProfile` and `updateProfile`. *Confirmed.*

### L14. Unbounded in-memory duplicate sets

`deliveredResults` in Maglumi, Cobas, Sysmex, and Bonavera Count, and the `orders` map in
Bonavera 200 (completed orders are never deleted), grow for as long as the process runs.
*Confirmed.*

### L15. Broken deno tasks

`deno task test` runs the missing `test.ts`, and `compile:serial-setup:win` points at the missing
`../src/tools/serial-setup.ts`. *Confirmed.*

---

## Agent-to-SDK usage mismatches

These are places where `medicloud-agent` uses the SDK in a way that does not match what the SDK
really does.

### A1. The agent never restarts disconnected or failed profiles (High)

The agent calls only `getHandler()` and `shutdown()`, plus HTTP reads and order calls. It never
calls `POST /profiles/:id/start`. Because of H2, every analyzer reconnect needs a human. Meanwhile
`postMachineOrder` fails with "not running" and `jobs/orderPull.ts` marks the orders failed.
*Confirmed.*

### A2. The agent's order edit path uses the SDK sample rename that most drivers mishandle (Medium)

`routes/dashboard/orders.ts` (PATCH `/agent-orders/:id`) sends `sampleId` to SDK
`PATCH /orders/:id`, which triggers M1. *Confirmed.*

### A3. Packaged agent binaries cannot start the serial helper (High, Likely)

The `compile:*` and `desktop:*` tasks in `medicloud-agent/deno.json` include only `./drizzle` and
`./frontend/build`. [lib/utils.ts](../../lib/utils.ts) `helperPath()` builds the path of
`lib/node-serial.mjs` from `import.meta.url`. In a compiled binary that path is inside Deno's
virtual file system, which an external `node` process cannot read. The helper also needs Node.js
and npm on the lab PC (it runs `npm install serialport@12.0.0` on first use). Serial drivers
(Cobas, Sysmex, Kenza) will fail in packaged builds. *Likely.*

### A4. Result reconcile pages by offset over a list that is sorted newest first (Low)

`jobs/resultDispatcher.ts` `reconcile()` walks `GET /results?limit&offset`. The SDK sorts by
`received_at DESC`, so a result inserted during the walk shifts the pages, and one row is skipped
in that pass. The SDK offers no stable cursor (such as `afterId`). *Confirmed.*

### A5. The agent exposes the unauthenticated SDK admin API on 0.0.0.0 (Medium)

`app.all("*", machineHandler)` on `MEDICLOUD_AGENT_HTTP_HOST` (default `0.0.0.0`) with
`cors()` makes every SDK route (profile delete, catalog edit, orders) reachable from the LAN.
*Confirmed.*

### A6. Dead agent setting (Low)

`MEDICLOUD_MACHINES_INTERNAL_HTTP_ENABLED` is defined in `medicloud-agent/schemas/env.ts` but is
never passed to `MachineManager`. *Confirmed.*

---

## Tool results (deno 2.9.8)

| Command | Result |
|---|---|
| `deno check` (every `.ts` file) | Pass. (`deno check mod.ts` fails because there is no root `mod.ts`; the entry point is `main.ts`.) |
| `deno lint` | Pass (84 files, 0 problems). |
| `deno fmt --check` | **Fail**: 1 file not formatted (`registry.ts`, around line 1100). |
| `deno test --allow-all` | Pass: 11 passed, 0 failed (catalog routes, catalog, learned timing, 8 Maglumi protocol tests). |
| `deno task test` | **Fail**: `test.ts` not found (see L15). |
