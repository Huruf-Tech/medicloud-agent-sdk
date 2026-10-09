import { createLogger, type Logger } from '../lib/logger.ts';
import { RawConnection } from '../types.ts';

export type ProtocolConnection = RawConnection;
export type ProtocolState =
	| 'idle'
	| 'starting'
	| 'running'
	| 'stopping'
	| 'closed';

export interface ProtocolMessageContext {
	readonly receivedAt: Date;
	readonly localAddr?: Deno.Addr;
	readonly remoteAddr?: Deno.Addr;
}

export type ProtocolMessageHandler<TMessage, TOutbound = unknown> = (
	message: TMessage,
	protocol: BaseProtocol<TMessage, TOutbound>,
	context: ProtocolMessageContext,
) => void | Promise<void>;

export type ProtocolErrorHandler<TMessage, TOutbound = unknown> = (
	error: Error,
	protocol: BaseProtocol<TMessage, TOutbound>,
) => void | Promise<void>;

export type ProtocolCloseHandler<TMessage, TOutbound = unknown> = (
	protocol: BaseProtocol<TMessage, TOutbound>,
) => void | Promise<void>;

export type ProtocolStateChangeHandler<TMessage, TOutbound = unknown> = (
	state: ProtocolState,
	previousState: ProtocolState,
	protocol: BaseProtocol<TMessage, TOutbound>,
) => void | Promise<void>;

export interface BaseProtocolOptions<TMessage = unknown, TOutbound = unknown> {
	readonly logger?: Logger;
	readonly loggerScope?: string;
	readonly readBufferSize?: number;
	readonly closeConnectionOnStop?: boolean;
	readonly onError?: ProtocolErrorHandler<TMessage, TOutbound>;
	readonly onClose?: ProtocolCloseHandler<TMessage, TOutbound>;
	readonly onMessage?: ProtocolMessageHandler<TMessage, TOutbound>;
	readonly onStateChange?: ProtocolStateChangeHandler<TMessage, TOutbound>;
}

const DEFAULT_READ_BUFFER_SIZE = 4096;

export abstract class BaseProtocol<TMessage = unknown, TOutbound = unknown> {
	abstract readonly protocolName: string;
	readonly protocolVersion?: string;

	protected readonly input: number[] = [];
	protected readonly log: Logger;

	private readonly readBufferSize: number;
	private readonly closeConnectionOnStop: boolean;
	private readonly onError?: ProtocolErrorHandler<TMessage, TOutbound>;
	private readonly onClose?: ProtocolCloseHandler<TMessage, TOutbound>;
	private readonly onMessage?: ProtocolMessageHandler<TMessage, TOutbound>;
	private readonly onStateChange?: ProtocolStateChangeHandler<
		TMessage,
		TOutbound
	>;
	private state: ProtocolState = 'idle';
	private readLoopPromise?: Promise<void>;
	private writeChain: Promise<void> = Promise.resolve();
	private sendChain: Promise<void> = Promise.resolve();

	constructor(
		protected readonly connection: ProtocolConnection,
		options: BaseProtocolOptions<TMessage, TOutbound> = {},
	) {
		this.log = options.logger ??
			createLogger(options.loggerScope ?? this.constructor.name);
		this.readBufferSize = options.readBufferSize ??
			DEFAULT_READ_BUFFER_SIZE;
		this.closeConnectionOnStop = options.closeConnectionOnStop ?? true;
		this.onError = options.onError;
		this.onClose = options.onClose;
		this.onMessage = options.onMessage;
		this.onStateChange = options.onStateChange;
	}

	get currentState(): ProtocolState {
		return this.state;
	}

	get isRunning(): boolean {
		return this.state === 'starting' || this.state === 'running';
	}

	get isClosed(): boolean {
		return this.state === 'closed';
	}

	get remoteName(): string {
		return protocolAddressName(this.safeRemoteAddr());
	}

	/**
	 * Start the protocol read loop in the background.
	 */
	start(): Promise<void> {
		if (this.readLoopPromise) return Promise.resolve();
		if (this.state === 'closed') {
			throw new Error(
				`${this.constructor.name} cannot be restarted after close.`,
			);
		}

		this.setState('starting');
		this.readLoopPromise = this.readLoop();
		this.setState('running');
		return Promise.resolve();
	}

	/**
	 * Close immediately. This is intentionally idempotent.
	 */
	close(): void {
		if (this.state === 'closed') return;

		this.setState('stopping');
		this.input.length = 0;

		if (this.closeConnectionOnStop) {
			try {
				this.connection.close();
			} catch {
				// Already closed by the transport or peer.
			}
		}

		this.setState('closed');
	}

	async waitUntilClosed(): Promise<void> {
		await this.readLoopPromise;
	}

	/**
	 * Optional outbound API. Concrete protocols should override this when the
	 * machine supports orders, ACKs, query responses or polling requests.
	 */
	send(_message: TOutbound): Promise<void> {
		return Promise.reject(
			new Error(`${this.constructor.name}.send() not supported`),
		);
	}

	// protected helpers
	protected shouldContinueAfterProtocolError(
		_error: unknown,
	): boolean | Promise<boolean> {
		return false;
	}
	protected shouldContinueAfterReadError(
		_error: unknown,
	): boolean | Promise<boolean> {
		return false;
	}
	protected async reportError(error: unknown): Promise<void> {
		const normalized = toError(error);
		this.log.warn(`${this.protocolName} protocol error`, normalized);

		if (!this.onError) return;

		try {
			await this.onError(normalized, this);
		} catch (handlerError) {
			this.log.error(
				`${this.protocolName} error handler failed`,
				handlerError,
			);
		}
	}

	/**
	 * Consume buffered input after each read. Concrete protocols implement the
	 * byte state machine here and call deliverMessage() when a complete protocol
	 * message is ready.
	 */
	protected abstract processInput(): Promise<void>;

	protected async handleReadBytes(bytes: Uint8Array): Promise<void> {
		this.appendInput(bytes);
		await this.processInput();
	}

	protected appendInput(bytes: Uint8Array): void {
		for (let index = 0; index < bytes.length; index++) {
			this.input.push(bytes[index]);
		}
	}

	protected get bufferedByteLength(): number {
		return this.input.length;
	}

	protected peekByte(offset = 0): number | undefined {
		return this.input[offset];
	}

	protected shiftByte(): number | undefined {
		return this.input.shift();
	}

	protected takeInput(count: number): number[] {
		return this.input.splice(0, Math.max(0, count));
	}

	protected async deliverMessage(message: TMessage): Promise<void> {
		if (!this.onMessage) return;

		try {
			await this.onMessage(message, this, {
				receivedAt: new Date(),
				localAddr: this.safeLocalAddr(),
				remoteAddr: this.safeRemoteAddr(),
			});
		} catch (error) {
			await this.reportError(error);
		}
	}

	protected publishMessage(message: TMessage): void {
		void this.deliverMessage(message);
	}

	protected writeControl(code: number): Promise<void> {
		return this.writeBytes(Uint8Array.of(code));
	}

	/** Serialize all writes so concurrent send()/ACK paths never interleave. */
	protected writeBytes(bytes: Uint8Array): Promise<void> {
		const chunk = bytes.slice();
		const operation = this.writeChain.catch(() => undefined).then(
			async () => {
				this.assertWritable();

				let offset = 0;
				while (offset < chunk.length) {
					const written = await this.connection.write(
						chunk.subarray(offset),
					);
					if (written <= 0) {
						throw new Error('Connection write made no progress.');
					}
					offset += written;
				}
			},
		);

		this.writeChain = operation.catch(() => undefined);
		return operation;
	}

	protected serializeSend<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.sendChain.catch(() => undefined).then(operation);
		this.sendChain = next.then(() => undefined, () => undefined);
		return next;
	}

	// private helpers
	private async readLoop(): Promise<void> {
		const chunk = new Uint8Array(this.readBufferSize);

		try {
			while (!this.isClosed) {
				let count: number | null;
				try {
					count = await this.connection.read(chunk);
				} catch (error) {
					if (this.isClosed) break;
					if (await this.shouldContinueAfterReadError(error)) {
						continue;
					}
					await this.reportError(error);
					break;
				}

				if (count === null) break;
				if (count === 0) continue;

				try {
					await this.handleReadBytes(chunk.slice(0, count));
				} catch (error) {
					if (await this.shouldContinueAfterProtocolError(error)) {
						continue;
					}
					await this.reportError(error);
					break;
				}
			}
		} finally {
			this.close();
			await this.notifyClosed();
		}
	}

	private async notifyClosed(): Promise<void> {
		if (!this.onClose) return;

		try {
			await this.onClose(this);
		} catch (error) {
			this.log.error(`${this.protocolName} close handler failed`, error);
		}
	}

	private setState(next: ProtocolState): void {
		if (this.state === next) return;

		const previous = this.state;
		this.state = next;

		if (!this.onStateChange) return;

		Promise.resolve(this.onStateChange(next, previous, this)).catch(
			(error) => {
				this.log.error(
					`${this.protocolName} state handler failed`,
					error,
				);
			},
		);
	}

	private safeRemoteAddr(): Deno.Addr | undefined {
		try {
			return this.connection.remoteAddr;
		} catch {
			return undefined;
		}
	}

	private safeLocalAddr(): Deno.Addr | undefined {
		try {
			return this.connection.localAddr;
		} catch {
			return undefined;
		}
	}

	private assertWritable(): void {
		if (this.isClosed) {
			throw new Error(`${this.constructor.name} is closed.`);
		}
	}
}

// helpers
function protocolAddressName(
	addr: Deno.Addr | undefined,
	fallback = 'unknown',
): string {
	if (!addr) return fallback;

	const netAddr = addr as Partial<Deno.NetAddr>;
	if (typeof netAddr.hostname === 'string' && netAddr.hostname.length > 0) {
		return netAddr.hostname;
	}

	const unixAddr = addr as { path?: unknown };
	if (typeof unixAddr.path === 'string' && unixAddr.path.length > 0) {
		return unixAddr.path;
	}

	if (typeof addr.transport === 'string' && addr.transport.length > 0) {
		return addr.transport;
	}

	return fallback;
}
function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
