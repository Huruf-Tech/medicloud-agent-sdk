//                  RawConnection
//                       ^
//                       |
//       +---------------+---------------+
//       |               |               |
//    Serial         TCP Client      TCP Server
//       |               |               |
//  COM Port      connect()        listen()+accept()

import type {
	RawConnection,
	SerialPortTransportOptions,
	TransportSpec,
} from '../types.ts';
import {
	dataBitsValue,
	helperPath,
	parityName,
	serialFlowValue,
	stopBitsValue,
} from '../lib/utils.ts';
import { SerialConn } from './serialConn.ts';

export class MachineCom implements RawConnection {
	private conn: RawConnection | null = null;
	private listener?: Deno.TcpListener;
	private pendingSerial?: SerialConn;
	private connectPromise?: Promise<void>;
	private pendingConnection?: Promise<RawConnection>;
	private closed = false;

	constructor(
		protected readonly spec: TransportSpec,
	) {}

	async connect(): Promise<void> {
		if (this.conn || this.listener || this.pendingConnection) return;
		if (this.connectPromise) return await this.connectPromise;

		this.closed = false;

		const operation = this.open();
		this.connectPromise = operation;

		try {
			await operation;
		} finally {
			if (this.connectPromise === operation) {
				this.connectPromise = undefined;
			}
		}
	}

	// does the analyzer actually connected?
	async whenConnected(): Promise<void> {
		if (this.conn) return;
		if (this.pendingConnection) {
			await this.pendingConnection;
			return;
		}
		throw new Error('Machine communication is not connected or listening.');
	}

	get localAddr(): Deno.Addr {
		if (this.conn) return this.conn.localAddr;
		if (this.listener) return this.listener.addr;
		throw new Error('Machine communication is not connected or listening.');
	}

	get remoteAddr(): Deno.Addr {
		return this.connection.remoteAddr;
	}

	async read(buf: Uint8Array): Promise<number | null> {
		const connection = await this.waitForConnection();
		return await connection.read(buf);
	}

	async write(buf: Uint8Array): Promise<number> {
		const connection = await this.waitForConnection();
		return await connection.write(buf);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;

		// Clear any pending connection attempt.
		this.pendingConnection = undefined;

		// close listener
		const listener = this.listener;
		this.listener = undefined;
		try {
			listener?.close();
		} catch {
			// Listener was already closed.
		}

		// close tcp
		const connection = this.conn;
		this.conn = null;
		try {
			connection?.close();
		} catch {
			// Connection was already closed.
		}

		// close serial
		const serial = this.pendingSerial;
		this.pendingSerial = undefined;
		try {
			serial?.close();
		} catch {
			// Serial connection already closed.
		}
	}

	// private helpers
	private get connection(): RawConnection {
		if (!this.conn) {
			throw new Error('Machine is not connected.');
		}

		return this.conn;
	}

	private async open(): Promise<void> {
		switch (this.spec.kind) {
			case 'tcp-server': {
				// .... tcp-base server connection here, Start listening immediately. Protocol reads wait for the analyzer without blocking registry or HTTP startup.
				const listener = Deno.listen({
					hostname: this.spec.host ?? '0.0.0.0',
					port: Number(this.spec.port ?? 8080),
					transport: 'tcp',
				});
				this.listener = listener;

				const pending = this.acceptTcpConnection(listener);
				this.pendingConnection = pending;

				void pending.finally(
					() => this.clearPendingConnection(pending),
				).catch(() => undefined);

				return;
			}
			case 'tcp-client': {
				// .... tcp-base client connection here (work as TCP client), Connect to an analyzer that owns the TCP listener.
				const connection = await Deno.connect({
					hostname: this.spec.host ?? '0.0.0.0',
					port: Number(this.spec.port ?? 8080),
					transport: 'tcp',
				});
				this.acceptOpenedConnection(connection);
				return;
			}
			case 'serial': {
				// .... serial base connection here, Use the Node helper for serial-port access.
				const connection = this.createSerialPort({
					portName: String(this.spec.portName),
					baud: this.spec.baud ?? 9600,
					dataBits: this.spec.dataBits ?? 8,
					stopBits: this.spec.stopBits ?? 1,
					parity: this.spec.parity ?? 'n',
					flowControl: this.spec.flowControl ?? 'none',
					reconnectDelayMs: this.spec.reconnectDelayMs ?? 3000,
				});
				this.pendingSerial = connection;
				try {
					await connection.opened;
					this.acceptOpenedConnection(connection);
				} finally {
					if (this.pendingSerial === connection) {
						this.pendingSerial = undefined;
					}
				}
				return;
			}
		}
	}

	private async acceptTcpConnection(
		listener: Deno.TcpListener,
	): Promise<RawConnection> {
		try {
			const connection = await listener.accept();
			this.acceptOpenedConnection(connection);
			return connection;
		} finally {
			if (this.listener === listener) {
				this.listener = undefined;
			}
			try {
				listener.close();
			} catch {
				// Listener closes after accepting one client
				// or when connect() is cancelled.
			}
		}
	}

	private acceptOpenedConnection(connection: RawConnection): void {
		if (this.closed) {
			connection.close();
			throw new Error(
				'Machine communication closed before connection was established.',
			);
		}
		this.conn = connection;
	}

	private clearPendingConnection(pending: Promise<RawConnection>): void {
		if (this.pendingConnection === pending) {
			this.pendingConnection = undefined;
		}
	}

	private async waitForConnection(): Promise<RawConnection> {
		if (this.conn) return this.conn;

		if (this.pendingConnection) {
			try {
				return await this.pendingConnection;
			} catch {
				throw new Error('Machine is not connected.');
			}
		}

		throw new Error('Machine is not connected.');
	}

	private createSerialPort(
		opts: SerialPortTransportOptions,
	): SerialConn {
		if (typeof opts.portName !== 'string') {
			throw new Error('Serial port must be a string.');
		}

		// Deno.command (communicate with another program on the operating system)
		const child = new Deno.Command('node', {
			args: [
				helperPath('../lib/node-serial.mjs'),
				'--port',
				opts.portName,
				'--baud',
				String(opts.baud),
				'--data-bits',
				String(dataBitsValue(opts.dataBits)),
				'--stop-bits',
				String(stopBitsValue(opts.stopBits)),
				'--parity',
				parityName(opts.parity),
				'--flow',
				serialFlowValue(opts.flowControl ?? 'none'),
			],
			stdin: 'piped',
			stdout: 'piped',
			stderr: 'piped',
		});

		// this will implement raw serial connection here.
		return new SerialConn(child.spawn(), opts);
	}
}
