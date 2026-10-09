/**
 * ASTM E1394-97 link layer (manual section 3.1).
 *
 * Half-duplex framing over a single TCP connection:
 *   - Receiving: <ENQ> -> we reply <ACK>; then frames
 *     <STX> FN <DATA> <ETB|ETX> <CS> <CR><LF> each ACK'd (or NAK'd on a bad
 *     checksum); finally <EOT> completes the message.
 *   - Sending: we grab the link with <ENQ>, wait for <ACK>, send each record as
 *     its own frame, then release with <EOT>.
 */

import {
	BaseProtocol,
	type BaseProtocolOptions,
	type ProtocolConnection,
} from '../../abstracts/baseProtocol.ts';
import { delay } from '../../lib/utils.ts';
import { computeAstmChecksum } from './checksum.ts';
import { ASTM_CONTROL, ASTM_MAX_FRAME_NUMBER } from './constants.ts';
import { type AstmRecord, parseAstmRecord } from './records.ts';

export interface AstmProtocolOptions
	extends BaseProtocolOptions<AstmRecord[], string[]> {
	/**
	 * Some analyzers (YHLO iFlash) use full ASTM frames with frame numbers and
	 * checksum bytes. Others (SNIBE Maglumi TCP/IP in the field) send a lighter
	 * STX...ETX wrapper with no frame number/checksum. Defaults preserve the
	 * original strict behavior.
	 */

	receiveFrameNumber?: 'required' | 'optional';
	receiveChecksum?: 'required' | 'none';
	sendFrameNumber?: boolean;
	sendChecksum?: boolean;
	/** Terminator for every non-final outbound frame. */
	intermediateTerminator?: 'etb' | 'etx';
	finalTerminator?: 'etb' | 'etx';
	/** Send all records in one frame separated by CR instead of one frame each. */
	sendRecordsInSingleFrame?: boolean;
	/** Reassemble E1381 ETB continuation frames before parsing their records. */
	reassembleEtbFrames?: boolean;
}

type ResolvedAstmProtocolOptions = Required<
	Pick<
		AstmProtocolOptions,
		| 'receiveFrameNumber'
		| 'receiveChecksum'
		| 'sendFrameNumber'
		| 'sendChecksum'
		| 'intermediateTerminator'
		| 'finalTerminator'
		| 'sendRecordsInSingleFrame'
		| 'reassembleEtbFrames'
	>
>;

const DEFAULT_OPTIONS: ResolvedAstmProtocolOptions = {
	receiveFrameNumber: 'required',
	receiveChecksum: 'required',
	sendFrameNumber: true,
	sendChecksum: true,
	intermediateTerminator: 'etx',
	finalTerminator: 'etb',
	sendRecordsInSingleFrame: false,
	reassembleEtbFrames: false,
};

const ACK_TIMEOUT_MS = 15_000;
const MAX_SEND_RETRIES = 6;

export class AstmProtocol extends BaseProtocol<AstmRecord[], string[]> {
	readonly protocolName = 'ASTM';
	override readonly protocolVersion = 'E1394-97';

	private readonly astmOptions: ResolvedAstmProtocolOptions;
	private readonly decoder = new TextDecoder('utf-8', { fatal: false });
	private readonly textEncoder = new TextEncoder();
	private records: string[] = [];
	private frameTextBuffer = '';
	private ackWaiter: ((control: number) => void) | undefined;
	private outFrameNo = 1;

	constructor(
		connection: ProtocolConnection,
		options: AstmProtocolOptions = {},
	) {
		super(connection, options); // direct passing callbacks to base protocol so that each driver link to astm protocol (base protocol)
		this.astmOptions = {
			receiveFrameNumber: options.receiveFrameNumber ??
				DEFAULT_OPTIONS.receiveFrameNumber,
			receiveChecksum: options.receiveChecksum ??
				DEFAULT_OPTIONS.receiveChecksum,
			sendFrameNumber: options.sendFrameNumber ??
				DEFAULT_OPTIONS.sendFrameNumber,
			sendChecksum: options.sendChecksum ?? DEFAULT_OPTIONS.sendChecksum,
			intermediateTerminator: options.intermediateTerminator ??
				DEFAULT_OPTIONS.intermediateTerminator,
			finalTerminator: options.finalTerminator ??
				DEFAULT_OPTIONS.finalTerminator,
			sendRecordsInSingleFrame: options.sendRecordsInSingleFrame ??
				DEFAULT_OPTIONS.sendRecordsInSingleFrame,
			reassembleEtbFrames: options.reassembleEtbFrames ??
				DEFAULT_OPTIONS.reassembleEtbFrames,
		};
	}

	/**
	 * Send a full message: acquire the link, send each record as a frame, release.
	 * Throws if the peer never acknowledges.
	 */
	override send(recordLines: string[]): Promise<void> {
		return this.serializeSend(async () => {
			await this.acquireLink();
			this.outFrameNo = 1;

			const lines = this.astmOptions.sendRecordsInSingleFrame
				? [recordLines.join('\r')]
				: recordLines;

			for (let index = 0; index < lines.length; index++) {
				await this.sendFrame(lines[index], index === lines.length - 1);
				this.outFrameNo = this.outFrameNo >= ASTM_MAX_FRAME_NUMBER
					? 0
					: this.outFrameNo + 1;
			}

			await this.writeControl(ASTM_CONTROL.EOT);
		});
	}

	// private & protected helpers
	protected async processInput(): Promise<void> {
		while (this.bufferedByteLength > 0) {
			const byte = this.peekByte();

			// While sending, a lone ACK/NAK is the peer's frame acknowledgment.
			if (
				this.ackWaiter &&
				(byte === ASTM_CONTROL.ACK || byte === ASTM_CONTROL.NAK)
			) {
				this.shiftByte();
				const resolve = this.ackWaiter;
				this.ackWaiter = undefined;
				resolve(byte);
				continue;
			}

			if (byte === ASTM_CONTROL.ENQ) {
				this.shiftByte();
				this.records = [];
				this.frameTextBuffer = '';
				await this.writeControl(ASTM_CONTROL.ACK);
				continue;
			}

			if (byte === ASTM_CONTROL.EOT) {
				this.shiftByte();
				this.deliverRecords();
				continue;
			}

			if (byte === ASTM_CONTROL.STX) {
				if (!await this.tryReadFrame()) return; // incomplete frame, wait for more bytes
				continue;
			}

			// CR/LF between control chars and anything unexpected: drop quietly.
			this.shiftByte();
		}
	}

	/**
	 * Attempt to read one full frame from the front of the buffer.
	 * Returns false (without consuming) if the frame is not yet complete.
	 */
	private async tryReadFrame(): Promise<boolean> {
		// Find terminator (ETB or ETX) after STX and optional frame number.
		const hasFrameNumber = this.hasFrameNumber();
		if (
			this.astmOptions.receiveFrameNumber === 'required' &&
			!hasFrameNumber
		) {
			this.log.warn(`missing ASTM frame number from ${this.remoteName}`);
			await this.writeControl(ASTM_CONTROL.NAK);
			this.shiftByte();
			return true;
		}

		let terminatorIndex = -1;
		for (
			let index = hasFrameNumber ? 2 : 1;
			index < this.bufferedByteLength;
			index++
		) {
			const byte = this.peekByte(index);
			if (byte === ASTM_CONTROL.ETB || byte === ASTM_CONTROL.ETX) {
				terminatorIndex = index;
				break;
			}
		}
		if (terminatorIndex === -1) return false; // terminator not arrived yet

		const needsChecksum = this.astmOptions.receiveChecksum === 'required';
		if (needsChecksum && this.bufferedByteLength < terminatorIndex + 3) {
			return false; // need 2 checksum chars
		}

		const frameEnd = needsChecksum
			? terminatorIndex + 3
			: terminatorIndex + 1;
		const frameBytes = this.takeInput(frameEnd);

		// Drop the frame plus an optional trailing CR/LF pair.
		if (this.peekByte() === ASTM_CONTROL.CR) this.shiftByte();
		if (this.peekByte() === ASTM_CONTROL.LF) this.shiftByte();

		if (needsChecksum) {
			// Checksum covers frame number through the terminator (inclusive).
			const checkInput = Uint8Array.from(
				frameBytes.slice(1, terminatorIndex + 1),
			);
			const expected = computeAstmChecksum(checkInput);
			const received = this.decoder
				.decode(
					Uint8Array.from(
						frameBytes.slice(
							terminatorIndex + 1,
							terminatorIndex + 3,
						),
					),
				)
				.toUpperCase();

			if (expected !== received) {
				this.log.warn(
					`bad ASTM checksum from ${this.remoteName}: expected ${expected}, got ${received}`,
				);
				await this.writeControl(ASTM_CONTROL.NAK);
				return true;
			}
		}

		const contentStart = hasFrameNumber ? 2 : 1;
		if (this.astmOptions.reassembleEtbFrames) {
			this.frameTextBuffer += this.decoder.decode(
				Uint8Array.from(
					frameBytes.slice(contentStart, terminatorIndex),
				),
			);
			if (frameBytes[terminatorIndex] === ASTM_CONTROL.ETX) {
				this.appendRecords(this.frameTextBuffer);
				this.frameTextBuffer = '';
			}
		} else {
			// Legacy drivers treat each frame as complete record text.
			let dataEnd = terminatorIndex;
			if (frameBytes[dataEnd - 1] === ASTM_CONTROL.CR) dataEnd--;
			this.appendRecords(
				this.decoder.decode(
					Uint8Array.from(frameBytes.slice(contentStart, dataEnd)),
				),
			);
		}

		await this.writeControl(ASTM_CONTROL.ACK);
		return true;
	}

	private hasFrameNumber(): boolean {
		if (this.bufferedByteLength < 2) return false;
		const byte = this.peekByte(1);
		return byte !== undefined && byte >= 0x30 && byte <= 0x37;
	}

	private appendRecords(text: string): void {
		for (const record of text.split(/\r\n|\r|\n/)) {
			if (record.length > 0) this.records.push(record);
		}
	}

	/** Hand the completed message to the driver without blocking the read loop. */
	private deliverRecords(): void {
		if (this.records.length === 0) return;

		const records = this.records.map(parseAstmRecord);
		this.records = [];
		this.publishMessage(records);
	}

	private async acquireLink(): Promise<void> {
		for (let attempt = 0; attempt < MAX_SEND_RETRIES; attempt++) {
			await this.writeControl(ASTM_CONTROL.ENQ);
			const reply = await this.waitForAck();
			if (reply === ASTM_CONTROL.ACK) return;

			this.log.warn(`ASTM peer NAK on ENQ, retrying (${attempt + 1})`);
			await delay(1000);
		}

		throw new Error('could not acquire ASTM link: no ACK to ENQ');
	}

	private async sendFrame(
		recordText: string,
		isLast: boolean,
	): Promise<void> {
		const frame = this.buildFrame(this.outFrameNo, recordText, isLast);

		for (let attempt = 0; attempt < MAX_SEND_RETRIES; attempt++) {
			await this.writeBytes(frame);
			const reply = await this.waitForAck();
			if (reply === ASTM_CONTROL.ACK) return;

			this.log.warn(
				`ASTM frame NAK from ${this.remoteName}, retrying (${
					attempt + 1
				})`,
			);
		}

		throw new Error('ASTM frame rejected after maximum retries');
	}

	private buildFrame(
		frameNo: number,
		recordText: string,
		isLast: boolean,
	): Uint8Array {
		// Inner content is the record plus its own CR terminator. YHLO's documented
		// examples use ETX for earlier record frames and ETB for the final record.
		// Other analyzers can override both terminators through protocol options.

		const terminatorName = isLast
			? this.astmOptions.finalTerminator
			: this.astmOptions.intermediateTerminator;
		const terminator = terminatorName === 'etx'
			? ASTM_CONTROL.ETX
			: ASTM_CONTROL.ETB;
		const prefix = this.astmOptions.sendFrameNumber ? String(frameNo) : '';
		const payload = this.textEncoder.encode(`${prefix}${recordText}\r`);
		const checkInput = Uint8Array.from([...payload, terminator]);
		const checksum = this.astmOptions.sendChecksum
			? this.textEncoder.encode(computeAstmChecksum(checkInput))
			: [];
		const suffix = this.astmOptions.sendChecksum
			? [ASTM_CONTROL.CR, ASTM_CONTROL.LF]
			: [];

		return Uint8Array.from([
			ASTM_CONTROL.STX,
			...payload,
			terminator,
			...checksum,
			...suffix,
		]);
	}

	private waitForAck(): Promise<number> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.ackWaiter = undefined;
				reject(new Error('ASTM ACK timeout'));
			}, ACK_TIMEOUT_MS);

			this.ackWaiter = (control: number) => {
				clearTimeout(timer);
				resolve(control);
			};
		});
	}
}
