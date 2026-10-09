import {
	BaseProtocol,
	type BaseProtocolOptions,
	type ProtocolConnection,
} from '../../../abstracts/baseProtocol.ts';
import { delay, formatBytes, visibleBytes } from '../../../lib/utils.ts';
import { computeAstmChecksum } from '../checksum.ts';
import { ASTM_CONTROL, ASTM_MAX_FRAME_NUMBER } from '../constants.ts';
import { type AstmRecord, parseAstmRecord } from '../records.ts';

export interface CobasC111SerialAstmOptions
	extends BaseProtocolOptions<AstmRecord[], string[]> {
	/** Controls the maximum number of characters allowed in an ASTM frame before splitting it into multiple frames. */
	readonly maxFrameTextLength?: number;

	/** The delay (in milliseconds) between sending consecutive serial frames. */
	readonly sendGapMs?: number;

	/** Enables verbose logging for debugging. */
	readonly trace?: boolean;
}

const DEFAULT_MAX_FRAME_TEXT_LENGTH = 240;
const DEFAULT_SEND_GAP_MS = 120; // 120 milliseconds
const XON = 0x11; // Decimal 17 - Resume sending data
const XOFF = 0x13; // Decimal 19 - Pause sending data

export class CobasC111SerialAstmProtocol
	extends BaseProtocol<AstmRecord[], string[]> {
	readonly protocolName = 'ASTM';
	override readonly protocolVersion = 'cobas-c111-e1381';

	private readonly decoder = new TextDecoder('ascii', { fatal: false }); // does not throw instead replace the invalid data with �
	private readonly encoder = new TextEncoder();
	private readonly maxFrameTextLength: number;
	private readonly sendGapMs: number;
	private readonly traceEnabled: boolean;
	private records: string[] = [];
	private frameTextBuffer = '';
	private outFrameNo = 1;

	/**
	 * Creates the Roche cobas c111 ASTM serial protocol.
	 *
	 * The connection is owned by BaseProtocol.
	 * Roche-specific settings are kept here:
	 * maxFrameTextLength controls outbound frame splitting
	 * sendGapMs keeps the required pause between serial writes
	 * trace enables detailed Roche ASTM byte logs
	 */
	constructor(
		connection: ProtocolConnection,
		options: CobasC111SerialAstmOptions = {},
	) {
		super(connection, options);
		this.maxFrameTextLength = options.maxFrameTextLength ??
			DEFAULT_MAX_FRAME_TEXT_LENGTH;
		this.sendGapMs = options.sendGapMs ?? DEFAULT_SEND_GAP_MS;
		this.traceEnabled = options.trace ?? false;
	}

	/**
	 * Sends one full Roche ASTM message to the analyzer.
	 *
	 * Working:
	 * 1. Serialize sends so two messages never mix on the serial line
	 * 2. Send ENQ to begin a transmission session
	 * 3. Wait the Roche serial gap instead of waiting for ACK
	 * 4. Split records into Roche-sized chunks
	 * 5. Send each chunk as STX frame number text ETB or ETX checksum CR LF
	 * 6. Send EOT to close the transmission session
	 */
	override send(recordLines: string[]): Promise<void> {
		return this.serializeSend(async () => {
			this.trace(
				`send message records=${recordLines.length} raw="${
					visible(recordLines.join('\r'))
				}"`,
			);

			await this.writeControl(ASTM_CONTROL.ENQ);
			await delay(this.sendGapMs);
			this.outFrameNo = 1;

			const chunks = splitRecords(recordLines, this.maxFrameTextLength);
			for (let index = 0; index < chunks.length; index++) {
				const isLast = index === chunks.length - 1;
				const frame = this.buildFrame(chunks[index], isLast);
				this.trace(
					`TX frame=${this.outFrameNo} ${
						isLast ? 'ETX' : 'ETB'
					} text="${visible(chunks[index])}"`,
				);
				await this.writeBytes(frame);
				await delay(this.sendGapMs);
				this.outFrameNo = this.outFrameNo >= ASTM_MAX_FRAME_NUMBER
					? 0
					: this.outFrameNo + 1;
			}

			await this.writeControl(ASTM_CONTROL.EOT);
			this.trace('send complete');
		});
	}

	/**
	 * Processes bytes already read from the serial connection.
	 *
	 * Working:
	 * XON and XOFF are ignored because Roche can send serial flow bytes
	 * Peer ACK and NAK bytes are tolerated in the stream
	 * ENQ resets the current receive message and replies ACK
	 * STX starts frame parsing
	 * EOT delivers all accumulated records to the driver
	 * Unknown bytes are discarded so the parser can recover
	 */
	protected async processInput(): Promise<void> {
		while (this.bufferedByteLength > 0) {
			const byte = this.peekByte();

			if (byte === XON || byte === XOFF) {
				this.shiftByte();
				this.trace(`RX ${byte === XON ? 'XON' : 'XOFF'}`);
				continue;
			}

			if (byte === ASTM_CONTROL.ACK || byte === ASTM_CONTROL.NAK) {
				this.shiftByte();
				this.trace(`RX ${controlName(byte)}`);
				continue;
			}

			if (byte === ASTM_CONTROL.ENQ) {
				this.shiftByte();
				this.records = [];
				this.frameTextBuffer = '';
				this.trace('RX ENQ -> ACK');
				await this.writeControl(ASTM_CONTROL.ACK);
				continue;
			}

			if (byte === ASTM_CONTROL.EOT) {
				this.shiftByte();
				this.trace(`RX EOT -> deliver records=${this.records.length}`);
				this.deliverRecords();
				continue;
			}

			if (byte === ASTM_CONTROL.STX) {
				if (!await this.tryReadFrame()) return;
				continue;
			}

			this.trace(
				`discard unexpected byte ${controlName(byte)} hex=${
					byte?.toString(16).padStart(2, '0').toUpperCase()
				}`,
			);
			this.shiftByte();
		}
	}

	/**
	 * Decides whether a read error should keep the protocol alive.
	 *
	 * Roche serial helpers can report idle timeout style errors when no bytes
	 * are available. Those are not real analyzer failures, so this waits briefly
	 * and lets the read loop continue. All other read errors close the protocol.
	 */
	protected override async shouldContinueAfterReadError(
		error: unknown,
	): Promise<boolean> {
		if (!isTransientIdleReadError(error)) return false;
		await delay(100);
		return true;
	}

	/**
	 * Reads and validates one complete Roche ASTM frame.
	 *
	 * Working:
	 * 1. Wait until enough bytes exist for STX and frame number
	 * 2. Reject frames without a Roche ASTM frame number
	 * 3. Wait until CR LF marks the physical frame end
	 * 4. Find ETB or ETX inside the frame
	 * 5. Verify checksum from frame number through ETB or ETX
	 * 6. Append ETB frame text into a buffer
	 * 7. On ETX split the reassembled text into ASTM records
	 * 8. ACK a valid frame or NAK an invalid frame
	 */
	private async tryReadFrame(): Promise<boolean> {
		if (this.bufferedByteLength < 2) return false;

		if (!this.hasFrameNumber()) {
			this.log.warn(
				`cobas c111 missing ASTM frame number from ${this.remoteName}; raw=${
					formatBytes(Uint8Array.from(this.peekBytes(8)))
				}`,
			);
			await this.writeControl(ASTM_CONTROL.NAK);
			this.shiftByte();
			return true;
		}

		const frameEnd = this.findFrameEnd();
		if (frameEnd === -1) return false;

		const frameBytes = this.takeInput(frameEnd);
		this.trace(
			`raw FRAME bytes=${frameBytes.length} hex=${
				formatBytes(Uint8Array.from(frameBytes))
			} ascii="${visibleBytes(Uint8Array.from(frameBytes))}"`,
		);

		const terminatorIndex = findTerminatorIndex(frameBytes);
		if (terminatorIndex === -1) {
			this.log.warn(
				`cobas c111 frame missing ETX/ETB from ${this.remoteName}; raw=${
					formatBytes(Uint8Array.from(frameBytes))
				}`,
			);
			await this.writeControl(ASTM_CONTROL.NAK);
			return true;
		}

		if (frameBytes.length < terminatorIndex + 5) {
			this.log.warn(
				`cobas c111 frame too short after ETX/ETB from ${this.remoteName}; raw=${
					formatBytes(Uint8Array.from(frameBytes))
				}`,
			);
			await this.writeControl(ASTM_CONTROL.NAK);
			return true;
		}

		const checkInput = Uint8Array.from(
			frameBytes.slice(1, terminatorIndex + 1),
		);
		const expected = computeAstmChecksum(checkInput);
		const received = this.decoder
			.decode(
				Uint8Array.from(
					frameBytes.slice(terminatorIndex + 1, terminatorIndex + 3),
				),
			)
			.toUpperCase();

		if (expected !== received) {
			this.log.warn(
				`cobas c111 bad checksum from ${this.remoteName}: expected ${expected}, got ${received}`,
			);
			await this.writeControl(ASTM_CONTROL.NAK);
			return true;
		}

		const frameText = this.decoder.decode(
			Uint8Array.from(frameBytes.slice(2, terminatorIndex)),
		);
		this.frameTextBuffer += frameText;
		if (frameBytes[terminatorIndex] === ASTM_CONTROL.ETX) {
			this.appendRecords(this.frameTextBuffer);
			this.frameTextBuffer = '';
		}

		await this.writeControl(ASTM_CONTROL.ACK);
		return true;
	}

	/**
	 * Checks whether the byte after STX is a valid ASTM frame number.
	 *
	 * Roche requires frame numbers from 0 to 7.
	 */
	private hasFrameNumber(): boolean {
		const byte = this.peekByte(1);
		return byte !== undefined && byte >= 0x30 && byte <= 0x37;
	}

	/**
	 * Finds the physical end of a Roche serial frame.
	 *
	 * Roche frames end with CR LF after the checksum.
	 * The returned number is the byte count to consume from the buffer.
	 */
	private findFrameEnd(): number {
		for (let index = 1; index < this.bufferedByteLength; index++) {
			if (
				this.peekByte(index - 1) === ASTM_CONTROL.CR &&
				this.peekByte(index) === ASTM_CONTROL.LF
			) {
				return index + 1;
			}
		}
		return -1;
	}

	/**
	 * Converts reassembled frame text into raw ASTM record lines.
	 *
	 * Roche can split one message across ETB frames.
	 * After ETX arrives this method splits the collected text on CR or LF.
	 */
	private appendRecords(text: string): void {
		for (const record of text.split(/\r\n|\r|\n/)) {
			if (record.length > 0) this.records.push(record);
		}
	}

	/**
	 * Publishes the completed ASTM message to the machine driver.
	 *
	 * Empty messages are ignored.
	 * Non-empty record lines are parsed into AstmRecord objects first.
	 */
	private deliverRecords(): void {
		if (this.records.length === 0) return;

		const records = this.records.map(parseAstmRecord);
		this.records = [];
		this.publishMessage(records);
	}

	/**
	 * Builds one outbound Roche ASTM frame.
	 *
	 * Working:
	 * 1. Pick ETB for intermediate chunks or ETX for the final chunk
	 * 2. Prefix the text with the current frame number
	 * 3. Calculate checksum over frame number plus text plus terminator
	 * 4. Wrap with STX at the start and CR LF at the end
	 */
	private buildFrame(text: string, isLast: boolean): Uint8Array {
		const terminator = isLast ? ASTM_CONTROL.ETX : ASTM_CONTROL.ETB;
		const body = this.encoder.encode(`${this.outFrameNo}${text}`);
		const checkInput = Uint8Array.from([...body, terminator]);
		const checksum = this.encoder.encode(computeAstmChecksum(checkInput));

		return Uint8Array.from([
			ASTM_CONTROL.STX,
			...checkInput,
			...checksum,
			ASTM_CONTROL.CR,
			ASTM_CONTROL.LF,
		]);
	}

	/**
	 * Copies a small preview from the input buffer without consuming it.
	 *
	 * This is used only for safe warning logs when a frame is malformed.
	 */
	private peekBytes(count: number): number[] {
		const bytes: number[] = [];
		for (
			let index = 0;
			index < Math.min(count, this.bufferedByteLength);
			index++
		) {
			const byte = this.peekByte(index);
			if (byte !== undefined) bytes.push(byte);
		}
		return bytes;
	}

	/**
	 * Writes a trace log only when Roche trace mode is enabled.
	 *
	 * This keeps normal production logs quiet while still allowing byte-level
	 * debugging during analyzer setup.
	 */
	private trace(message: string): void {
		if (this.traceEnabled) this.log.info(`cobas c111 ASTM ${message}`);
	}
}

/**
 * Splits outbound ASTM records into Roche-sized frame text chunks.
 *
 * Each record keeps its CR terminator.
 * Long records are split every maxLength characters to match tested Roche
 * behavior from the legacy driver.
 */
function splitRecords(records: readonly string[], maxLength: number): string[] {
	const chunks: string[] = [];
	for (const record of records) {
		const text = `${record}\r`;
		for (let offset = 0; offset < text.length; offset += maxLength) {
			chunks.push(text.slice(offset, offset + maxLength));
		}
	}
	return chunks;
}

/**
 * Finds the ASTM text terminator inside a received frame.
 *
 * ETB means more frame text is coming.
 * ETX means the message text is complete and can be parsed.
 */
function findTerminatorIndex(bytes: readonly number[]): number {
	return Math.max(
		bytes.lastIndexOf(ASTM_CONTROL.ETX),
		bytes.lastIndexOf(ASTM_CONTROL.ETB),
	);
}

/**
 * Converts a control byte into a readable name for logs.
 *
 * Known ASTM control bytes get names.
 * Unknown values are shown as hexadecimal.
 */
function controlName(code: number | undefined): string {
	if (code === ASTM_CONTROL.ENQ) return 'ENQ';
	if (code === ASTM_CONTROL.ACK) return 'ACK';
	if (code === ASTM_CONTROL.NAK) return 'NAK';
	if (code === ASTM_CONTROL.EOT) return 'EOT';
	if (code === ASTM_CONTROL.STX) return 'STX';
	if (code === ASTM_CONTROL.ETX) return 'ETX';
	if (code === ASTM_CONTROL.ETB) return 'ETB';
	if (code === undefined) return 'unknown';
	return `0x${code.toString(16).padStart(2, '0')}`;
}

/**
 * Makes CR and LF visible in trace messages.
 *
 * This helps compare logs with ASTM records without changing the real bytes.
 */
function visible(text: string): string {
	return text.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

/**
 * Detects serial idle timeout errors that should not close the protocol.
 *
 * Some serial helpers raise timeout-like errors when the port is simply idle.
 * Those are treated as normal waiting conditions.
 */
function isTransientIdleReadError(error: unknown): boolean {
	if (error instanceof Deno.errors.TimedOut) return true;

	const err = error as { code?: unknown; message?: unknown; name?: unknown };
	const code = String(err.code ?? '');
	const name = String(err.name ?? '');
	const message = String(err.message ?? '');

	return name === 'TimedOut' ||
		(code === 'ECANCELED' && /aborted|timed\s*out/i.test(message));
}
