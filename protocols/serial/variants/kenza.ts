/**
 * Kenza 240TX serial protocol variant.
 *
 * The Kenza uses the same generic ENQ/ACK/STX/BCC/ETX framing as
 * SerialStringProtocol but has no extra protocol-level behavior on top of it.
 * This variant exists to:
 *   - Give the connection a Kenza-specific class name for clearer logging
 *   - Let the machine driver import a named type rather than the generic base
 *   - Serve as the place to add any future Kenza-specific link-layer tweaks
 *     (e.g., custom NAK retry timing, timeout overrides, heartbeat logic)
 *
 * Pattern mirrors protocols/astm/variants/cobasC111Serial.ts and sysmexKx21n.ts
 * relative to protocols/astm/link.ts.
 */

import type { RawConnection } from '../../../types.ts';
import type { Logger } from '../../../lib/logger.ts';
import {
	type SerialStringPayloadHandler,
	SerialStringProtocol,
} from '../link.ts';

export class KenzaSerialProtocol extends SerialStringProtocol {
	constructor(
		conn: RawConnection,
		onMessage: SerialStringPayloadHandler,
		log: Logger,
	) {
		super(conn, onMessage, log);
	}
}
