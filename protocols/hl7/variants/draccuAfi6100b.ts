import { MllpProtocol } from '../link.ts';

/** Preserve the tested mixed MLLP / unframed R-line receive behavior. */
export class DrAccuAfi6100bProtocol extends MllpProtocol {
	protected override async processUnframedInput(): Promise<void> {
		while (true) {
			const cr = this.input.indexOf(0x0d);
			const lf = this.input.indexOf(0x0a);
			const separator = cr === -1
				? lf
				: lf === -1
				? cr
				: Math.min(cr, lf);
			if (separator === -1) return;
			const line = this.decoder.decode(
				Uint8Array.from(this.input.slice(0, separator)),
			).trim();
			const consumed = separator +
				(this.input[separator] === 0x0d &&
						this.input[separator + 1] === 0x0a
					? 2
					: 1);
			if (line === '') {
				this.takeInput(consumed);
				continue;
			}
			if (!line.startsWith('R|')) return;
			this.takeInput(consumed);
			await this.deliverMessage(line);
		}
	}
}
