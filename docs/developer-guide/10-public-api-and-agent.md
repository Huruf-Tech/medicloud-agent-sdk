# 10. Public API and How medicloud-agent Uses It

[← Index](README.md)

## 10.1 What the SDK exports

There is no root `mod.ts`. Consumers import files directly. `medicloud-agent/deno.json` maps:

```json
"@mediCloud/sdk/manager":  "../medicloud-agent-sdk/machineManager.ts",
"@mediCloud/sdk/registry": "../medicloud-agent-sdk/registry.ts"
```

The agent really uses only `MachineManager` (the `registry` mapping is not imported anywhere).

`MachineManager` ([machineManager.ts](../../machineManager.ts)):

```ts
new MachineManager({
  dbPath?: string,                       // default ./data/machines.db
  http?: { enabled?, host?, port? },     // only used by listen()
  onResultPersisted?: (result: StoredMachineResult & {machineId}) => void | Promise<void>,
})
getHandler(): Promise<(req: Request) => Promise<Response>>  // connects DB + starts enabled profiles
listen(callback?): Promise<void>                             // getHandler + its own Deno.serve
shutdown(): Promise<void>                                    // stop HTTP (own), stop machines, close DB
```

`onResultPersisted` runs after the result transaction commits. It runs in the background, and its
errors are only logged. Treat it as a hint, not as a guarantee. Reconcile from `GET /results`
for durability (the agent does this).

The manager always uses the **singleton** `machineRegistry`. Two managers in one process share
one registry.

## 10.2 How the agent wires it ([medicloud-agent/main.ts])

1. `new MachineManager({ dbPath: env.MEDICLOUD_MACHINES_SDK_DB_PATH, onResultPersisted: r => resultDispatcher.onResult(r) })`.
2. `const machineHandler = await manager.getHandler()`.
3. Hono app: the agent's own routes first, then `app.all('*', c => machineHandler(c.req.raw))`.
   So every SDK route is served on the agent port (default `0.0.0.0:5001`).
4. On shutdown: `server.shutdown()`, then `manager.shutdown()`.

The agent calls SDK routes over HTTP on itself (`AGENT_LOCAL_URL`, see
`medicloud-agent/lib/api.ts`):

| Agent call | SDK route | Used for |
|---|---|---|
| `fetchMachineProfiles` | `GET /profiles` | capabilities sent in heartbeats |
| `fetchMachineHealth` | `GET /health` | running/connected flags |
| `fetchDriverCatalog` | `GET /catalogs?driver=` | the test and analyte list sent upstream |
| `postMachineOrder` | `POST /orders` | orders pulled from MediCloud (empty fields stripped) |
| `fetchMachineOrder` / `patchMachineOrder` / `deleteMachineOrder` | `/orders/:id` | dashboard edits |
| `fetchMachineResultsPage` | `GET /results?limit&offset` | outbox reconcile |

## 10.3 Mismatches to keep in mind

Full details are in [KNOWN_ISSUES.md](KNOWN_ISSUES.md#agent-to-sdk-usage-mismatches):

- **A1**: the agent never restarts a disconnected profile, but the SDK needs a manual
  `/profiles/:id/start` after every disconnect.
- **A2**: dashboard sample renames hit the stale-staging bug (M1).
- **A3**: compiled agent binaries cannot run the serial helper `.mjs`.
- **A4**: reconcile paging uses an offset over a newest-first list.
- **A5**: the unauthenticated SDK admin routes are exposed on `0.0.0.0`.
- **A6**: `MEDICLOUD_MACHINES_INTERNAL_HTTP_ENABLED` is never used.
