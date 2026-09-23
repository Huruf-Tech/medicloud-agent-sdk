import { BaseProtocol } from '../../abstracts/baseProtocol.ts';
import { MLLP } from './constants.ts';

/** MLLP framing only; message fields and responses belong to the machine. */
export class MllpProtocol extends BaseProtocol<string, string> {
	readonly protocolName = 'MLLP';
	protected readonly decoder = new TextDecoder('utf-8', { fatal: false });
	private readonly encoder = new TextEncoder();

	override send(message: string): Promise<void> {
		const payload = this.encoder.encode(message);
		const frame = new Uint8Array(payload.length + 3);
		frame[0] = MLLP.SB;
		frame.set(payload, 1);
		frame[payload.length + 1] = MLLP.EB;
		frame[payload.length + 2] = MLLP.CR;
		return this.writeBytes(frame);
	}

	protected override async processInput(): Promise<void> {
		while (true) {
			const start = this.input.indexOf(MLLP.SB);
			if (start === -1) break;
			if (start > 0) this.takeInput(start);
			const end = this.input.indexOf(MLLP.EB);
			if (end === -1) return;
			const payload = Uint8Array.from(this.input.slice(1, end));
			this.takeInput(end + 1 + (this.input[end + 1] === MLLP.CR ? 1 : 0));
			await this.deliverMessage(this.decoder.decode(payload));
		}
		await this.processUnframedInput();
		if (this.input.length > 64_000) {
			this.log.warn(
				'Raw buffer exceeded 64 KB without a complete message; clearing',
			);
			this.input.length = 0;
		}
	}

	protected processUnframedInput(): Promise<void> {
		return Promise.resolve();
	}
}
