import {
	BaseProtocol,
	type BaseProtocolOptions,
	type ProtocolConnection,
} from '../../../abstracts/baseProtocol.ts';
import { ASTM_CONTROL } from '../constants.ts';

export type SysmexFrameTerminator =
	| typeof ASTM_CONTROL.ETX
	| typeof ASTM_CONTROL.ETB;

export interface SysmexKx21nFrame {
	readonly payload: string;
	readonly rawFrame: Uint8Array;
	readonly terminator: SysmexFrameTerminator;
}

export interface SysmexKx21nAstmOptions
	extends BaseProtocolOptions<SysmexKx21nFrame> {
	/** Class B ACKs ENQ and every received frame, Class A is one-way. */
	readonly classB?: boolean;
	readonly trace?: boolean;
}

/**
 * KX-21/KX-21N serial host-output variant.
 *
 * Native KX output uses ASTM control bytes around fixed-width records. Some
 * installations also emit ASTM H/P/O/R/L payloads through the same session.
 */
export class SysmexKx21nAstmProtocol extends BaseProtocol<SysmexKx21nFrame> {
	readonly protocolName = 'ASTM';
	override readonly protocolVersion = 'sysmex-kx-class-a-b';

	private readonly decoder = new TextDecoder('ascii', { fatal: false }); // does not throw instead replace the invalid data with �
	private readonly classB: boolean;
	private readonly traceEnabled: boolean;

	constructor(
		connection: ProtocolConnection,
		options: SysmexKx21nAstmOptions = {},
	) {
		super(connection, options);
		this.classB = options.classB ?? true;
		this.traceEnabled = options.trace ?? false;
	}

	// protected/private helpers
	protected override async processInput(): Promise<void> {
		while (this.bufferedByteLength > 0) {
			const first = this.peekByte();
			if (first === ASTM_CONTROL.ENQ) {
				this.shiftByte();
				this.trace('RX [ENQ]');
				if (this.classB) await this.writeControl(ASTM_CONTROL.ACK);
				continue;
			}

			if (first === ASTM_CONTROL.EOT) {
				this.shiftByte();
				this.trace('RX [EOT]');
				continue;
			}

			if (
				first === ASTM_CONTROL.ACK || first === ASTM_CONTROL.NAK ||
				first === ASTM_CONTROL.CR || first === ASTM_CONTROL.LF ||
				first === 0x00
			) {
				this.shiftByte();
				continue;
			}

			const buffered = this.snapshotInput();
			const stx = buffered.indexOf(ASTM_CONTROL.STX);
			if (stx === -1) {
				this.dropStrayBytes(this.takeInput(this.bufferedByteLength));
				return;
			}
			if (stx > 0) this.dropStrayBytes(this.takeInput(stx));

			const frame = this.snapshotInput();
			const terminatorIndex = indexOfAny(
				frame,
				[ASTM_CONTROL.ETX, ASTM_CONTROL.ETB],
				1,
			);
			if (terminatorIndex === -1) return;

			const terminator = frame[terminatorIndex] as SysmexFrameTerminator;
			const end = frameEnd(frame, terminatorIndex + 1);
			const rawFrame = Uint8Array.from(this.takeInput(end));
			const payload = this.decoder.decode(
				rawFrame.subarray(1, terminatorIndex),
			);
			this.trace(
				`RX frame bytes=${rawFrame.length} ascii="${
					visible(rawFrame)
				}"`,
			);

			if (this.classB) {
				await this.writeControl(ASTM_CONTROL.ACK);
				this.trace('ACK sent for frame terminator');
			}

			await this.deliverMessage({ payload, rawFrame, terminator });
		}
	}

	private snapshotInput(): number[] {
		const bytes: number[] = [];
		for (let index = 0; index < this.bufferedByteLength; index++) {
			const byte = this.peekByte(index);
			if (byte !== undefined) bytes.push(byte);
		}
		return bytes;
	}

	private dropStrayBytes(bytes: number[]): void {
		const useful = bytes.filter((byte) =>
			byte !== ASTM_CONTROL.CR && byte !== ASTM_CONTROL.LF &&
			byte !== 0x00 && byte !== ASTM_CONTROL.ENQ
		);
		if (useful.length > 0) {
			this.trace(
				`dropped stray bytes=${useful.length} ascii="${
					visible(Uint8Array.from(useful))
				}"`,
			);
		}
	}

	private trace(message: string): void {
		if (this.traceEnabled) this.log.info(`Sysmex KX-21N ${message}`);
	}
}

function indexOfAny(bytes: number[], needles: number[], from: number): number {
	let best = -1;
	for (const needle of needles) {
		const index = bytes.indexOf(needle, from);
		if (index >= 0 && (best === -1 || index < best)) best = index;
	}
	return best;
}

function frameEnd(bytes: number[], offset: number): number {
	let end = offset;
	if (isHexByte(bytes[end]) && isHexByte(bytes[end + 1])) end += 2;
	if (bytes[end] === ASTM_CONTROL.CR) end++;
	if (bytes[end] === ASTM_CONTROL.LF) end++;
	return end;
}

function isHexByte(byte: number | undefined): boolean {
	return byte !== undefined &&
		((byte >= 0x30 && byte <= 0x39) ||
			(byte >= 0x41 && byte <= 0x46) ||
			(byte >= 0x61 && byte <= 0x66));
}

function visible(bytes: Uint8Array): string {
	let output = '';
	for (const byte of bytes) {
		const name = Object.entries(ASTM_CONTROL).find(([, code]) =>
			code === byte
		)?.[0];
		if (name) output += `[${name}]`;
		else if (byte >= 0x20 && byte <= 0x7e) {
			output += String.fromCharCode(byte);
		} else {
			output += `[0x${byte.toString(16).padStart(2, '0').toUpperCase()}]`;
		}
	}
	return output;
}
