# 14. Order recovery and driver boundaries

The [machine registry](../../registry.ts) coordinates the SQLite order record and the in-memory driver. The [order store](../../store/orderStore.ts) handles persistence. When debugging an order, distinguish the row's status from whether its driver accepted, staged, or transmitted the order.

## Submit, edit, and resend

| Operation | Checks and side effects |
| --- | --- |
| Submit | Requires a running profile. If no test codes are supplied, the registry resolves active default tests. It rejects expired orders and active sample conflicts on the same profile. It inserts a pending row before calling the driver. If that call throws, the row is retained as failed with a reason. |
| Edit | Completed orders cannot be edited and an order cannot move to another profile. Active orders are checked for expiration and sample conflicts. If the existing order is pending or testing and a running driver supports order sends, the driver receives the merged order before the update is written to SQLite. |
| Resend | Only pending and failed orders qualify. The same row is prepared again, keeping its ID. An expired order receives a new default deadline. Estimates are recalculated and prior processing and failure fields are cleared. A new send error marks the same row failed. |

A successful driver call means that driver's send method returned. A query-based analyzer can request the staged order later. For driver-specific timing and framing, see [Machines](06-machines.md) and [Protocols](05-protocols.md).

## Debugging the local order boundary

1. Check the numeric profile ID and whether the profile is running. Driver IDs identify a driver family and can be shared by multiple profiles.
2. Compare the sample ID, stored test codes, order status, and expiration with what the driver expects. Defaults are selected on submit when the caller omits codes.
3. Check driver logs and connection state after a failed send. A failed row can be inspected before resending.
4. For result association, consult the matching rules and limitations in [Registry and lifecycle](07-registry-and-lifecycle.md#75-result-matching-persistresult) and [Known issues](KNOWN_ISSUES.md). The [HTTP order routes](../../http/orders.routes.ts) call the registry for these operations.

## Result commit and notification

For a newly matched result, the registry inserts the result, marks the order completed, and records turnaround statistics inside one SQLite transaction. The optional `onResultPersisted` callback receives the stored result with its generated ID after the transaction. It is not awaited by the result pipeline. A repeated result for an order with a stored result marks the order complete again but skips insertion and callback. When no order matches, an existing result for that profile and sample suppresses the duplicate; otherwise persistence fails. See [result persistence](../../registry.ts#L947).
