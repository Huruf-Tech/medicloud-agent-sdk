# 13. Troubleshooting with Real Analyzers

[← Index](README.md)

## 13.1 Turn on raw logging

| Analyzer | How |
|---|---|
| All serial (cobas, Sysmex, Kenza) | Env `SERIAL_TRACE=1` → `serial TX/RX … hex=… ascii="[STX]1H|…"` |
| cobas c111 | Profile `trace: true` → frame-level `cobas c111 ASTM …` lines |
| Sysmex | Profile `trace: true` → `Sysmex KX-21N RX frame …` |
| Kenza | Profile `trace: true` → `Kenza RX/TX … visible= hex=` |
| MAGLUMI | Profile `traceProtocol: true` → `Maglumi RX/TX n bytes: 02 31 48 …` |
| iFlash | No trace option. It logs `bad ASTM checksum` and `missing ASTM frame number` warnings, and it prints the order response to the console |

Trace logs contain patient data. Turn them off after debugging.

## 13.2 Reading a raw log

Example (cobas, serial trace):

```text
serial RX COM3 bytes=1 hex=05 ascii="[ENQ]"
serial TX COM3 bytes=1 hex=06 ascii="[ACK]"
serial RX COM3 bytes=64 hex=02 31 48 7C ... 0D 03 41 37 0D 0A ascii="[STX]1H|\^&|||c111^Roche...[CR][ETX]A7[CR][LF]"
serial TX COM3 bytes=1 hex=06 ascii="[ACK]"
serial RX COM3 bytes=1 hex=04 ascii="[EOT]"
```

How to read it:

1. `[ENQ]` from the analyzer, and our `[ACK]`. This is a good handshake.
2. `[STX]1…[ETX]A7[CR][LF]` is frame 1 with checksum `A7`. Check it by adding the bytes from `1`
   to `ETX` modulo 256.
3. Our `[ACK]` means the checksum matched. A `[NAK]` means it did not (look for a
   `bad checksum` warning that shows the expected and received values).
4. `[EOT]` means the message is complete. Now the driver parses it.

## 13.3 Common failures

| Symptom | Likely cause | What to do |
|---|---|---|
| The profile is "running" but never `connected` (TCP) | The analyzer points at the wrong IP or port, or a firewall blocks it | Check the analyzer's LIS settings. `host` must be a local interface (`0.0.0.0` = all). Allow the port in Windows Firewall |
| It worked, then stopped after the analyzer restarted | One-connection listener, and no auto-restart (KNOWN_ISSUES H2/A1) | `POST /profiles/:id/start` |
| `connected: true`, but nothing arrives after a power cut | Half-open socket, no keepalive (H2) | Stop and start the profile |
| Serial open fails with "Access denied" | Another program (or an orphaned `node` helper, M13) holds the COM port | Close the vendor software, and kill stray `node.exe` |
| Serial never opens on first start | The helper is running `npm install serialport` (it needs internet, Node, and npm) | Check the `installing serialport@12.0.0` log. Pre-install it into `MEDICLOUD_SERIAL_NODE_DIR` |
| Garbage characters or repeated NAKs on serial | Wrong baud, parity, data bits, or flow control | Match the analyzer's settings exactly. cobas often needs `xonxoff`. Kenza is usually 19200 8N1 |
| `Cannot store result: no order found for machine=… sample=…` | The order was never posted, the sample ID is formatted differently (leading zeros, truncation), or the order expired | Compare the sample ID in `raw` with the order. Check Sysmex `stripSampleLeadingZeroes` and Kenza `idLength`. The result is **lost** (M14) |
| A multi-test order shows only some analytes | Per-test upload messages (H1) | This is a known issue. Check `raw` to see what the analyzer sent |
| The analyzer says "LIS no response" for a query | `queryReplyDelayMs` is too high, ENQ contention (M4), cobas `replyToQueries=false`, or an exception while building the reply (for example, a test disabled in the catalog) | Check the error logs. Re-enable the catalog test |
| `iFlash 3000 does not support test code "X"` on POST /orders | The code is not in the DB catalog, or it is disabled | Add or enable it through `/catalogs/iflash3000/tests` |
| `already has an active order for sample` (HTTP 500) | A pending or testing order already exists for the sample (substring match! C1) | Complete or delete the old order, and check for similar IDs |
| Maglumi `incomplete ASTM message at EOT; discarded` | The message did not start with H or end with L, or a frame was NAKed | Turn on `traceProtocol` and inspect the frames. Try `framing: staged` if the analyzer uses the 16.6 handshake |
| Kenza results under a strange ID | The ID was truncated to 8 or 9 characters (H3) | Use short sample IDs and check `idLength` |

## 13.4 Where to look in code

- No bytes at all: [transports/machineCom.ts](../../transports/machineCom.ts) and
  [transports/serialConn.ts](../../transports/serialConn.ts).
- Bytes, but no message: the protocol's `processInput()` ([page 5](05-protocols.md)).
- A message, but a wrong or missing result: the driver's `inbound.ts`, then `persistResult` in
  [registry.ts](../../registry.ts).
- An order never reaches the analyzer: the driver's query or push code, then `outbound.ts`.
