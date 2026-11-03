# 9. HTTP API

[← Index](README.md)

The dispatcher is [http/routes.ts](../../http/routes.ts) (`createMachineManagerHandler`). It is a
plain `(Request) => Promise<Response>` function, so any framework can host it. The agent hosts it
with Hono.

General rules:

- Bodies and query strings are validated with **strict** Zod schemas ([schema.ts](../../schema.ts),
  [http/validation.ts](../../http/validation.ts)). Unknown fields → 400.
- Path IDs must be positive safe integers. `limit` must be positive. `offset` must be ≥ 0.
- Errors: `HttpError` → its own status. Zod → 400. `CatalogInUseError` → 409. **Everything else →
  500** `{error:'internal error', detail}`. This includes conflicts such as "already has an
  active order" (KNOWN_ISSUES L8).
- CORS: `*`, methods `GET,POST,PATCH,DELETE,OPTIONS` (PUT is missing; L9). `OPTIONS` on any path →
  204.
- There is **no authentication**.

## 9.1 System

| Method and path | Response |
|---|---|
| `GET /health` | `{status:'ok', registered_drivers: MachineDriverView[], running_machines: RunningMachineView[]}` |
| `GET /drivers[?id=…|?brand=…]` | `{drivers}`. The filter matches the id or brand, ignoring case. 404 if nothing matches |

`MachineDriverView` = `{id, brand, models, protocol:{name,version}, defaultOrderTests, configFields,
transportType}`. `RunningMachineView` = `{profile, machine:{id, brand, model, connected, running}}`.

## 9.2 Profiles ([http/profile.routes.ts](../../http/profile.routes.ts))

| Method and path | Body / query | Result |
|---|---|---|
| `GET /profiles` | `?id&driverId&name&enabled=true|false&limit&offset` | `{profiles}` (newest first) |
| `GET /profiles/count` | | `{count}` |
| `POST /profiles` | `{driverId, name?, enabled=false, config:{…}}` | 201 `{profile}`. Starts it if `enabled` |
| `GET /profiles/:id` | | `{profile}` or 404 |
| `PATCH /profiles/:id` | any of `{driverId, name|null, enabled, config}` | `{profile}`. Config or driver changes are refused while running |
| `DELETE /profiles/:id` | | `{success, id}`. Refused if orders, results, or statistics exist |
| `POST /profiles/:id/start` | | `{started, profile}`. Sets `enabled=true` |
| `POST /profiles/:id/stop` | | `{stopped, profile}`. Sets `enabled=false` |

Example:

```bash
curl -X POST localhost:5001/profiles -H 'content-type: application/json' -d '{
  "driverId":"iflash3000","name":"iFlash lab 1","enabled":true,
  "config":{"host":"0.0.0.0","port":7001}}'
```

## 9.3 Orders ([http/orders.routes.ts](../../http/orders.routes.ts))

| Method and path | Body / query | Result |
|---|---|---|
| `GET /orders` | `?machineId&sampleId(substring)&status&limit&offset` | `{orders}` |
| `GET /orders/count` | | `{count}` |
| `POST /orders` | `{machineId, sampleId, tests?[], patientId?, patientName?, dob?, sex?, species?, sampleType?, rackPosition?, raw?, createdAt?, expiresAt?}` | 201 `{order}`. The default expiry is createdAt + 24 h |
| `GET /orders/:id` | | `{order}` |
| `PATCH /orders/:id` | any of `sampleId, tests, patient fields, raw, expiresAt` | `{order}` |
| `POST /orders/:id/resend` | | `{order}`. Only `failed`/`pending`, otherwise 409 |
| `DELETE /orders/:id` | | `{success, id}`. Not allowed once completed or once a result exists |

```bash
curl -X POST localhost:5001/orders -H 'content-type: application/json' \
  -d '{"machineId":1,"sampleId":"S0001","tests":["TSH","FT4"],"patientName":"DOE^JOHN"}'
```

## 9.4 Results ([http/results.routes.ts](../../http/results.routes.ts))

Results can only be read.

| Method and path | Query | Result |
|---|---|---|
| `GET /results` | `?orderId&machineId&sampleId(exact)&limit&offset` | `{results}` (newest first) |
| `GET /results/count` | | `{count}` |
| `GET /results/:id` | | `{result}` |

A result is `{id, orderId, machineId, sampleId, patientId?, payload:{results: MachineAnalyteResult[]}, raw, receivedAt}`.
`MachineAnalyteResult` = `{assayNo, assayName?, resultType 'I'|'F'|'B', value?, qualitative?, unit?,
lowReference?, highReference?, abnormalFlag?, status?, completedAt?}`.

## 9.5 Test statistics ([http/testStatistics.routes.ts](../../http/testStatistics.routes.ts))

| Method and path | Result |
|---|---|
| `GET /test-statistics?machineId&testId&limit&offset` | `{statistics}` |
| `GET /test-statistics/count` | `{count}` |
| `GET /test-statistics/:id` | `{statistic}` |
| `DELETE /test-statistics/:id` | 204 |

## 9.6 Catalogs ([http/catalog.routes.ts](../../http/catalog.routes.ts))

| Method and path | Body | Result |
|---|---|---|
| `GET /catalogs` | | `{catalogs:[{id, driverId, machine, catalogCount, source}]}` |
| `GET /catalogs?driver=…` or `?machine=…` | | the full `CatalogView` (the agent uses this) |
| `POST /catalogs` | `{driverId, machine}` | 201. The driver must be registered and must not have a catalog yet |
| `GET /catalogs/:driverId` | | `CatalogView` |
| `PATCH /catalogs/:driverId` | `{machine}` | renamed view |
| `POST /catalogs/:driverId/tests` | `CatalogTestEntry` | 201 `{test}` |
| `PUT /catalogs/:driverId/tests/:code` | `CatalogTestEntry` (same code) | `{test}` |
| `DELETE /catalogs/:driverId/tests/:code` | | `{success, code}`. 409 if an active order uses it |

Driver-specific checks (`validateDriverTest`): iFlash needs exactly one numeric channel analyte.
Kenza needs a `slot`. DrAccu needs one numeric item-ID analyte. Bonavera 200 needs a numeric code.
Bonavera Count accepts only `CBC`. Maglumi, Roche, and Kenza also reject identifiers or aliases
that clash with another test. Note that `:code` is **not URL-decoded**, so codes with spaces cannot
be updated or deleted (KNOWN_ISSUES M15).
