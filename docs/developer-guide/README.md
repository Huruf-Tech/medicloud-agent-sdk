# MediCloud Agent SDK: Developer Guide

Start here. This guide is for a developer who has never seen this code and may never have
connected software to a laboratory analyzer.

The SDK lets a computer in a lab talk to blood and chemistry analyzers. It receives results from
the machines, sends them test orders, and stores everything in a local SQLite database. It also
offers a small HTTP API, so other programs can control it.

> **Read [KNOWN_ISSUES.md](KNOWN_ISSUES.md) before you change anything that touches results or
> orders.** It lists confirmed bugs, including two Critical ones that can attach a result to the
> wrong patient.

## Reading order

| # | Page | What you learn |
|---|---|---|
| 1 | [Overview and system context](01-overview.md) | What an analyzer is, why this SDK exists, and where it fits in MediCloud |
| 2 | [Concepts and glossary](02-concepts-and-glossary.md) | ASTM, HL7, MLLP, ENQ/ACK, checksums, and host queries, explained simply |
| 3 | [Architecture and layers](03-architecture.md) | The layer diagram, the rules for each layer, the folder map, and the class diagram |
| 4 | [Transports](04-transports.md) | TCP server, TCP client, and serial through the Node helper |
| 5 | [Protocols](05-protocols.md) | Every protocol implementation, with state machines and byte examples |
| 6 | [Machines (drivers)](06-machines.md) | All 8 supported analyzers: settings, workflow, parsing, and quirks |
| 7 | [Registry and machine lifecycle](07-registry-and-lifecycle.md) | Start and stop, events, order sync, result matching, and statistics |
| 8 | [Storage (SQLite)](08-storage.md) | Tables, stores, catalogs, and transactions |
| 9 | [HTTP API](09-http-api.md) | Every route, with examples |
| 10 | [Public API and medicloud-agent](10-public-api-and-agent.md) | What the agent imports and how it uses the SDK |
| 11 | [Testing](11-testing.md) | Running the tests, and testing without a real analyzer |
| 12 | [How-to recipes](12-how-to.md) | Add a new analyzer driver, add a new protocol, and other tasks |
| 13 | [Troubleshooting with real analyzers](13-troubleshooting.md) | Reading raw logs and fixing common failures |
| 14 | [Order recovery and driver boundaries](14-order-recovery-and-driver-boundaries.md) | Local order state, resend rules, and the post-commit result callback |
| - | [Known issues](KNOWN_ISSUES.md) | The bug list from the code review |

## Quick start

```bash
cd medicloud-agent-sdk
deno task dev              # runs main.ts with --watch, reads .env
deno test --allow-all      # runs tests/*.ts
deno lint
deno check main.ts
```

`main.ts` starts the SDK on its own. It serves HTTP on `0.0.0.0:5001` (hard-coded, see
KNOWN_ISSUES M16) and uses SQLite at `MEDICLOUD_MACHINES_DB_PATH` (default
`./data/machines.db`). In production the SDK does not run on its own. It is embedded in
`medicloud-agent` (see [page 10](10-public-api-and-agent.md)).

Serial analyzers also need **Node.js and npm** on the PC. The SDK talks to COM ports through a
small Node helper program ([lib/node-serial.mjs](../../lib/node-serial.mjs)).

## Environment variables

These are all the variables the SDK code really reads.

| Variable | Read in | Default | Meaning |
|---|---|---|---|
| `MEDICLOUD_MACHINES_DB_PATH` | [main.ts](../../main.ts) | `./data/machines.db` | SQLite file path |
| `MEDICLOUD_MACHINES_HTTP_ENABLED` | [main.ts](../../main.ts) | `true` | Passed to `MachineManager`. `main.ts` then calls `Deno.serve` itself, so this has no effect there |
| `MEDICLOUD_MACHINES_HTTP_HOST` | [main.ts](../../main.ts) | `localhost` | Same note: ignored by the hard-coded `Deno.serve` |
| `MEDICLOUD_MACHINES_HTTP_PORT` | [main.ts](../../main.ts) | `5001` | Same note |
| `SERIAL_TRACE` | [lib/utils.ts](../../lib/utils.ts) | off | Logs every serial byte sent and received (`1/true/yes/on`) |
| `COBAS_C111_TRACE` | [lib/utils.ts](../../lib/utils.ts) | off | Same effect as `SERIAL_TRACE` |
| `SYSMEX_KX21N_TRACE` | [lib/utils.ts](../../lib/utils.ts) | off | Same effect as `SERIAL_TRACE` |
| `MEDICLOUD_SERIAL_NODE_DIR` | [lib/node-serial.mjs](../../lib/node-serial.mjs) | `LOCALAPPDATA` or the OS temp dir | Where the helper installs and caches the `serialport` npm package |
| `LOCALAPPDATA` | [lib/node-serial.mjs](../../lib/node-serial.mjs) | (Windows) | Fallback for the line above |

The `KENZA_*` entries in [.env.example](../../.env.example) are **documentation only**. The code
never reads them. Machine settings live in each profile's JSON config in SQLite.

## Existing text docs

The older notes in [docs/](../) (`structure.txt`, `flow.txt`, `routes.txt`, `fixes.txt`) are
still useful, but some parts are out of date. For example, they mention `sdk_v3/`, `src/`, and
an `estimatedMinutes` field for Cobas that no longer exists, and they list only 4 drivers while
the code registers 8. When the notes and the code disagree, trust the code. This guide was
checked against the code.
