/**
 * Generic half-duplex "Custom String" serial link layer.
 *
 * Frame format: ENQ/ACK handshake, then one or more frames
 * STX payload BCC(2) ETX, each ACK'd by the receiver, closed with EOT.
 *
 * This is the reusable base for any analyzer that uses this framing.
 * Machine-specific variants live under protocols/serial/variants/.
 *
 * Comparison to AstmProtocol (protocols/astm/link.ts):
 *   - ASTM uses frame numbers and CR/LF tails. This protocol uses a 2-char
 *     BCC after the payload, no frame numbers, and no CR/LF tails.
 *   - ASTM is a server model (machine connects to us). SerialStringProtocol
 *     is peer-to-peer: both sides may send ENQ and start a transaction.
 */

import type { RawConnection } from '../../types.ts';
import type { Logger } from '../../lib/logger.ts';
import { delay } from '../../lib/utils.ts';
import { computeKenzaBcc } from './checksum.ts';
import { KENZA_CONTROL } from './constants.ts';

const ACK_TIMEOUT_MS = 15_000;
const MAX_SEND_RETRIES = 3;

export type SerialStringPayloadHandler = (
	payload: string,
	protocol: SerialStringProtocol,
) => Promise<void> | void;

/** Encode a string to 8-bit bytes (latin1). */
export function serialStringEncode(s: string): Uint8Array {
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
	return out;
}

/** Decode 8-bit bytes back to a string. */
export function serialStringDecode(bytes: number[]): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return s;
}

function resolveRemoteId(conn: RawConnection): string {
	try {
		const addr = conn.remoteAddr as Partial<Deno.NetAddr>;
		return typeof addr.hostname === 'string' && addr.hostname.length > 0
			? addr.hostname
			: 'serial-link';
	} catch {
		return 'serial-link';
	}
}

/**
 * Half-duplex "Custom String" serial link layer.
 *
 * Reusable by any machine that follows the ENQ/ACK/STX/BCC/ETX framing
 * convention. Each machine-specific variant lives in protocols/serial/variants/
 * and either subclasses or wraps this class with machine-specific payload
 * encoding/decoding and protocol logic.
 */
export class SerialStringProtocol {
	/** Identifier of the remote peer (hostname for TCP, "serial-link" for COM ports). */
	readonly remoteId: string;

	private readonly buf: number[] = [];
	private payloads: string[] = [];
	private ackWaiter: ((control: number) => void) | undefined;
	private inboundActive = false;
	private closed = false;
	private writeChain: Promise<void> = Promise.resolve();

	constructor(
		protected readonly conn: RawConnection,
		private readonly onMessage: SerialStringPayloadHandler,
		protected readonly log: Logger,
	) {
		this.remoteId = resolveRemoteId(conn);
	}

	get isClosed(): boolean {
		return this.closed;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.conn.close();
		} catch {
			// already closed, ignore
		}
	}

	/** Read loop: blocks until the connection is closed. */
	async start(): Promise<void> {
		const chunk = new Uint8Array(4096);
		try {
			while (!this.closed) {
				const n = await this.conn.read(chunk);
				if (n === null) break;
				for (let i = 0; i < n; i++) this.buf.push(chunk[i]);
				await this.process();
			}
		} catch (err) {
			if (!this.closed) {
				this.log.warn(`serial read error from ${this.remoteId}`, err);
			}
		} finally {
			this.close();
		}
	}

	/**
	 * Send one payload string to the peer (ENQ -> frame -> EOT).
	 * Waits if an inbound transaction is in progress.
	 */
	async send(payload: string): Promise<void> {
		const start = Date.now();
		while (this.inboundActive && Date.now() - start < ACK_TIMEOUT_MS) {
			await delay(100);
		}
		await this.acquireLink();
		await this.sendFrame(payload);
		await this.writeControl(KENZA_CONTROL.EOT);
	}

	// protected methods -- variants may override to customize behavior
	protected async process(): Promise<void> {
		while (this.buf.length > 0) {
			const b = this.buf[0];

			if (b === KENZA_CONTROL.ENQ) {
				this.buf.shift();
				if (this.ackWaiter) {
					// We are mid-send, tell the peer we are busy.
					await this.writeControl(KENZA_CONTROL.NAK);
				} else {
					this.inboundActive = true;
					this.payloads = [];
					await this.writeControl(KENZA_CONTROL.ACK);
				}
				continue;
			}

			if (
				this.ackWaiter &&
				(b === KENZA_CONTROL.ACK || b === KENZA_CONTROL.NAK)
			) {
				this.buf.shift();
				const resolve = this.ackWaiter;
				this.ackWaiter = undefined;
				resolve(b);
				continue;
			}

			if (b === KENZA_CONTROL.EOT) {
				this.buf.shift();
				this.inboundActive = false;
				this.deliver();
				continue;
			}

			if (b === KENZA_CONTROL.STX) {
				const consumed = await this.tryReadFrame();
				if (!consumed) return;
				continue;
			}

			this.buf.shift(); // drop unexpected byte
		}
	}

	/** Attempt to read and validate one full frame from the buffer. */
	private async tryReadFrame(): Promise<boolean> {
		let etxIndex = -1;
		for (let i = 1; i < this.buf.length; i++) {
			if (
				this.buf[i] === KENZA_CONTROL.ETX ||
				this.buf[i] === KENZA_CONTROL.ETB
			) {
				etxIndex = i;
				break;
			}
		}
		if (etxIndex === -1) return false; // frame not complete yet

		if (etxIndex < 3) {
			// Not enough room for payload + BCC, discard and NAK.
			this.buf.splice(0, etxIndex + 1);
			await this.writeControl(KENZA_CONTROL.NAK);
			return true;
		}

		const payloadBytes = this.buf.slice(1, etxIndex - 2);
		const bccBytes = this.buf.slice(etxIndex - 2, etxIndex);
		this.buf.splice(0, etxIndex + 1);

		const expected = computeKenzaBcc(Uint8Array.from(payloadBytes));
		const received = serialStringDecode(bccBytes).toLowerCase();

		if (expected !== received) {
			this.log.warn(
				`serial bad BCC from ${this.remoteId}: expected ${expected}, got ${received}`,
			);
			await this.writeControl(KENZA_CONTROL.NAK);
			return true;
		}

		this.payloads.push(serialStringDecode(payloadBytes));
		await this.writeControl(KENZA_CONTROL.ACK);
		return true;
	}

	private deliver(): void {
		if (this.payloads.length === 0) return;
		const payloads = this.payloads;
		this.payloads = [];
		for (const payload of payloads) {
			Promise.resolve(this.onMessage(payload, this)).catch((err) =>
				this.log.error('serial message handler failed', err)
			);
		}
	}

	private async acquireLink(): Promise<void> {
		for (let attempt = 0; attempt < MAX_SEND_RETRIES; attempt++) {
			await this.writeControl(KENZA_CONTROL.ENQ);
			const reply = await this.waitForAck();
			if (reply === KENZA_CONTROL.ACK) return;
			this.log.warn(
				`serial peer NAK on ENQ, retrying (${attempt + 1})`,
			);
			await delay(1000);
		}
		throw new Error('could not acquire serial link: no ACK to ENQ');
	}

	private async sendFrame(payload: string): Promise<void> {
		const payloadBytes = serialStringEncode(payload);
		const bcc = serialStringEncode(computeKenzaBcc(payloadBytes));
		const frame = Uint8Array.from([
			KENZA_CONTROL.STX,
			...payloadBytes,
			...bcc,
			KENZA_CONTROL.ETX,
		]);

		for (let attempt = 0; attempt < MAX_SEND_RETRIES; attempt++) {
			await this.writeBytes(frame);
			const reply = await this.waitForAck();
			if (reply === KENZA_CONTROL.ACK) return;
			this.log.warn(
				`serial frame NAK from ${this.remoteId}, retrying (${
					attempt + 1
				})`,
			);
		}
		throw new Error('serial frame rejected after maximum retries');
	}

	private waitForAck(): Promise<number> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.ackWaiter = undefined;
				reject(new Error('serial ACK timeout'));
			}, ACK_TIMEOUT_MS);

			this.ackWaiter = (control: number) => {
				clearTimeout(timer);
				resolve(control);
			};
		});
	}

	protected writeControl(code: number): Promise<void> {
		return this.writeBytes(Uint8Array.of(code));
	}

	protected writeBytes(bytes: Uint8Array): Promise<void> {
		this.writeChain = this.writeChain.then(async () => {
			let offset = 0;
			while (offset < bytes.length) {
				offset += await this.conn.write(bytes.subarray(offset));
			}
		});
		return this.writeChain;
	}
}
