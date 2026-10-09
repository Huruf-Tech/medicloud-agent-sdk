import { createLogger } from '../lib/logger.ts';
import {
	decodeBase64,
	encodeBase64,
	formatBytes,
	serialTraceEnabled,
	visibleBytes,
} from '../lib/utils.ts';
import { RawConnection, SerialPortTransportOptions } from '../types.ts';

type HelperMessage =
	| { type: 'open' }
	| { type: 'data'; data: string }
	| { type: 'writeDone'; id: number; bytes: number }
	| { type: 'writeError'; id: number; message: string }
	| {
		type: 'log';
		level: 'info' | 'warn' | 'error' | 'debug';
		message: string;
	}
	| { type: 'error'; message: string }
	| { type: 'close' };

export class SerialConn implements RawConnection {
	readonly localAddr: Deno.Addr;
	readonly remoteAddr: Deno.Addr;
	private readonly chunks: Uint8Array[] = [];
	private readonly pendingWrites = new Map<
		number,
		{ resolve: (bytes: number) => void; reject: (error: Error) => void }
	>();
	private readonly stdin: WritableStreamDefaultWriter<Uint8Array>;
	private readonly encoder = new TextEncoder();
	// private readonly decoder = new TextDecoder();
	private readonly stdoutDecoder = new TextDecoder();
	private readonly stderrDecoder = new TextDecoder();
	private writeId = 0;
	private wakeReader: (() => void) | undefined;
	private closed = false;
	private readError: Error | undefined;
	private readonly portName: string;
	readonly opened: Promise<void>;
	private resolveOpen!: () => void;
	private rejectOpen!: (error: Error) => void;
	private readonly log = createLogger('Serial:Conn');

	constructor(
		private readonly child: Deno.ChildProcess,
		opts: SerialPortTransportOptions,
	) {
		const addr = {
			transport: 'tcp',
			hostname: opts.portName,
			port: opts.baud,
		} as Deno.NetAddr;
		this.localAddr = addr;
		this.remoteAddr = addr;
		this.portName = opts.portName;
		this.stdin = child.stdin.getWriter();
		this.opened = new Promise<void>((resolve, reject) => {
			this.resolveOpen = resolve;
			this.rejectOpen = reject;
		});

		this.readStdout();
		this.readStderr();
		this.watchExit();
	}

	async read(p: Uint8Array): Promise<number | null> {
		while (this.chunks.length === 0 && !this.closed && !this.readError) {
			await new Promise<void>((resolve) => this.wakeReader = resolve);
		}
		if (this.readError) throw this.readError;
		const chunk = this.chunks.shift();
		if (!chunk) return null;

		const count = Math.min(p.length, chunk.length);
		p.set(chunk.subarray(0, count));
		if (count < chunk.length) {
			this.chunks.unshift(chunk.subarray(count));
		}
		return count;
	}

	write(p: Uint8Array): Promise<number> {
		if (this.closed) {
			return Promise.reject(new Error('serial port is closed'));
		}
		const bytes = p.slice();
		this.trace(
			`serial TX ${this.portName} bytes=${bytes.length} hex=${
				formatBytes(bytes)
			} ascii="${visibleBytes(bytes)}"`,
		);
		return new Promise((resolve, reject) => {
			const id = ++this.writeId;
			this.pendingWrites.set(id, { resolve, reject });
			this.send({ type: 'write', id, data: encodeBase64(bytes) }).catch(
				(error) => {
					this.pendingWrites.delete(id);
					reject(
						error instanceof Error
							? error
							: new Error(String(error)),
					);
				},
			);
		});
	}

	close(): void {
		if (this.closed) return;

		const error = new Error('serial connection closed');
		this.closed = true;
		this.rejectOpen(error);
		for (const pending of this.pendingWrites.values()) {
			pending.reject(error);
		}
		this.pendingWrites.clear();

		this.send({ type: 'close' }).catch(() => {});
		this.stdin.releaseLock();
		try {
			this.child.kill();
		} catch {
			// Already exited.
		}
		this.wake();
	}

	private wake(): void {
		this.wakeReader?.();
		this.wakeReader = undefined;
	}

	private readStdout(): void {
		void (async () => {
			let pending = '';
			try {
				for await (const chunk of this.child.stdout) {
					pending += this.stdoutDecoder.decode(chunk, {
						stream: true,
					});
					let newline = pending.indexOf('\n');
					while (newline !== -1) {
						const line = pending.slice(0, newline).trim();
						pending = pending.slice(newline + 1);
						if (line) this.handleHelperLine(line);
						newline = pending.indexOf('\n');
					}
				}
				pending += this.stdoutDecoder.decode();
				const tail = pending.trim();
				if (tail) this.handleHelperLine(tail);
			} catch (error) {
				this.fail(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		})();
	}

	private readStderr(): void {
		void (async () => {
			try {
				for await (const chunk of this.child.stderr) {
					// const text = this.decoder.decode(chunk).trim();
					const text = this.stderrDecoder.decode(chunk, {
						stream: true,
					}).trim();
					if (text) {
						this.log.warn(
							`serial helper stderr ${this.portName}: ${text}`,
						);
					}
				}
				const tail = this.stderrDecoder.decode().trim();
				if (tail) {
					this.log.warn(
						`serial helper stderr ${this.portName}: ${tail}`,
					);
				}
			} catch {
				// Child ended.
			}
		})();
	}

	private watchExit(): void {
		void this.child.status.then((status) => {
			const error = new Error(`serial helper exited code=${status.code}`);
			if (!this.closed) {
				this.log.warn(`${this.portName} ${error.message}`);
			}
			this.fail(error);
		}).catch((error) => {
			this.fail(
				error instanceof Error ? error : new Error(String(error)),
			);
		});
	}

	private handleHelperLine(line: string): void {
		let message: HelperMessage;
		try {
			message = JSON.parse(line) as HelperMessage;
		} catch {
			this.log.warn(`serial helper non-json ${this.portName}: ${line}`);
			return;
		}

		if (message.type === 'open') {
			this.resolveOpen();
			return;
		}

		if (message.type === 'data') {
			const data = decodeBase64(message.data);
			if (this.closed) return;
			this.chunks.push(data);
			this.trace(
				`serial RX ${this.portName} bytes=${data.length} hex=${
					formatBytes(data)
				} ascii="${visibleBytes(data)}"`,
			);
			this.wake();
			return;
		}

		if (message.type === 'writeDone') {
			const pending = this.pendingWrites.get(message.id);
			if (!pending) return;
			this.pendingWrites.delete(message.id);
			this.trace(
				`serial TX drained ${this.portName} bytes=${message.bytes}`,
			);
			pending.resolve(message.bytes);
			return;
		}

		if (message.type === 'writeError') {
			const pending = this.pendingWrites.get(message.id);
			if (!pending) return;
			this.pendingWrites.delete(message.id);
			const error = new Error(message.message);
			this.log.error(
				`serial TX failed ${this.portName}: ${error.message}`,
			);
			pending.reject(error);
			return;
		}

		if (message.type === 'log') {
			this.log[message.level](
				`serial helper ${this.portName}: ${message.message}`,
			);
			return;
		}

		if (message.type === 'error') {
			this.fail(new Error(message.message));
			return;
		}

		if (message.type === 'close') {
			if (this.closed) {
				this.trace(`serial close event ${this.portName}`);
				return;
			}
			this.log.warn(`serial close event ${this.portName}`);
			this.fail(new Error('serial helper closed'));
		}
	}

	private async send(message: Record<string, unknown>): Promise<void> {
		await this.stdin.write(
			this.encoder.encode(`${JSON.stringify(message)}\n`),
		);
	}

	private trace(message: string): void {
		if (serialTraceEnabled()) this.log.info(message);
	}

	private fail(error: Error): void {
		if (!this.closed) {
			this.readError = error;
			this.closed = true;
			this.rejectOpen(error);
			for (const pending of this.pendingWrites.values()) {
				pending.reject(error);
			}
			this.pendingWrites.clear();
			this.wake();
		}
	}
}
