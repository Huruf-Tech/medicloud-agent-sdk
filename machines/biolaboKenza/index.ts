/**
 * BioLabo Kenza 240TX driver.
 *
 * Protocol: "Custom String" (Id8/Id9 variant) over RS-232. Direct serial is the
 * normal path. A serial-to-TCP bridge is also available for sites that need one.
 *
 * Unlike ASTM analyzers (host-query), the Kenza is push-based: the LIS sends
 * orders proactively. So this driver runs two concurrent operations on each
 * connection:
 *   - receive: KenzaConnection.start() reads inbound result payloads
 *   - push: a setInterval timer polls pendingOrders and pushes them to the analyzer
 *
 * Transport is selected at connect time from the profile config:
 *   - transport "serial"     -> MachineCom opens the COM port via node-serial.mjs
 *   - transport "tcp-bridge" -> MachineCom connects as TCP client to the bridge host
 */

import * as z from '@zod/zod';
import { BaseMachine } from '../../abstracts/baseMachine.ts';
import { MachineCom } from '../../transports/machineCom.ts';
import { createLogger } from '../../lib/logger.ts';
import { formatBytes, visibleBytes } from '../../lib/utils.ts';
import type {
	DataBits,
	DriverConfigField,
	DriverTransportType,
	MachineConfig,
	MachineConfigSchema,
	MachineOrder,
	SerialFlowControl,
	SerialParity,
	StopBits,
	TransportSpec,
} from '../../types.ts';
import { KenzaSerialProtocol } from '../../protocols/serial/variants/kenza.ts';
import { BIOLABO_KENZA_MODELS } from './catalog.ts';
import { parseKenzaPayload } from './inbound.ts';
import { buildKenzaOrder } from './outbound.ts';

export interface BiolaboKenzaConfig extends MachineConfig {
	// connection mode
	transport: 'serial' | 'tcp-bridge';

	// serial settings (active when transport = 'serial')
	portName: string;
	baud: number;
	dataBits: DataBits;
	stopBits: StopBits;
	parity: SerialParity;
	flowControl: SerialFlowControl;
	reconnectDelayMs: number;

	// tcp-bridge settings (active when transport = 'tcp-bridge')
	host: string;
	port: number;

	// protocol variant
	idLength: 8 | 9;

	// order pushing
	pushIntervalMs: number;
	estimatedMinutes: number;

	// debug
	trace: boolean;
}

export const biolaboKenzaMachineId = 'biolabo-kenza';

export class BiolaboKenza extends BaseMachine {
	static readonly id = biolaboKenzaMachineId;
	static readonly brand = 'BIOLABO-KENZA240TX';
	static readonly protocol = {
		name: 'Custom String (Id8/Id9)',
		version: 'Kenza 240TX',
	} as const;
	static readonly transportType: DriverTransportType = 'serial';
	static readonly models = BIOLABO_KENZA_MODELS;

	// for backend profile config validation before save
	static readonly configSchema = z
		.object({
			transport: z.enum(['serial', 'tcp-bridge']),
			serialPort: z.string().trim().min(1, 'Serial port is required'),
			baud: z.number().int().positive(),
			dataBits: z.coerce.number().pipe(
				z.union([
					z.literal(5),
					z.literal(6),
					z.literal(7),
					z.literal(8),
					z.literal(9),
				]),
			),
			stopBits: z.coerce
				.number()
				.pipe(z.union([z.literal(1), z.literal(1.5), z.literal(2)])),
			parity: z.enum(['n', 'o', 'e']),
			flowControl: z.enum(['none', 'xonxoff', 'rtscts']),
			reconnectDelayMs: z.number().int().min(0),
			host: z.string().trim().min(1, 'TCP bridge host is required'),
			port: z.number().int().min(1).max(65535),
			idLength: z.coerce
				.number()
				.pipe(z.union([z.literal(8), z.literal(9)])),
			pushIntervalMs: z.number().int().min(100),
			estimatedMinutes: z.number().positive(),
			trace: z.boolean(),
		})
		.strict()
		.transform(({ serialPort, ...rest }) => ({
			...rest,
			portName: serialPort,
		})) satisfies MachineConfigSchema<BiolaboKenzaConfig>;

	// for frontend form field generation
	static readonly configFields = [
		{
			key: 'transport',
			label: 'Connection mode',
			type: 'select',
			required: true,
			default: 'serial',
			options: [
				{ value: 'serial', label: 'Direct RS-232 serial' },
				{ value: 'tcp-bridge', label: 'TCP bridge (serial-to-TCP)' },
			],
			hint: 'Serial uses a COM port directly. TCP bridge connects to a serial redirector.',
		},
		{
			key: 'serialPort',
			label: 'Serial port',
			type: 'string',
			required: true,
			default: 'COM4',
			hint: 'COM port the Kenza RS-232 cable is plugged into, e.g. COM4 on Windows.',
		},
		{
			key: 'baud',
			label: 'Baud rate',
			type: 'number',
			required: true,
			default: 19200,
			hint: 'Must match the baud rate configured on the analyzer.',
		},
		{
			key: 'dataBits',
			label: 'Data bits',
			type: 'select',
			required: true,
			default: '8',
			options: [
				{ value: '5', label: '5' },
				{ value: '6', label: '6' },
				{ value: '7', label: '7' },
				{ value: '8', label: '8' },
				{ value: '9', label: '9' },
			],
		},
		{
			key: 'stopBits',
			label: 'Stop bits',
			type: 'select',
			required: true,
			default: '1',
			options: [
				{ value: '1', label: '1' },
				{ value: '1.5', label: '1.5' },
				{ value: '2', label: '2' },
			],
		},
		{
			key: 'parity',
			label: 'Parity',
			type: 'select',
			required: true,
			default: 'n',
			options: [
				{ value: 'n', label: 'None (n)' },
				{ value: 'o', label: 'Odd (o)' },
				{ value: 'e', label: 'Even (e)' },
			],
		},
		{
			key: 'flowControl',
			label: 'Flow control',
			type: 'select',
			required: true,
			default: 'none',
			options: [
				{ value: 'none', label: 'None' },
				{ value: 'xonxoff', label: 'XON/XOFF' },
				{ value: 'rtscts', label: 'RTS/CTS' },
			],
		},
		{
			key: 'reconnectDelayMs',
			label: 'Reconnect delay (ms)',
			type: 'number',
			required: true,
			default: 5000,
			hint: 'Retained for serial transport compatibility.',
		},
		{
			key: 'host',
			label: 'TCP bridge host',
			type: 'string',
			required: true,
			default: '127.0.0.1',
			hint: 'Host address of the serial-to-TCP bridge (only used when transport is tcp-bridge).',
		},
		{
			key: 'port',
			label: 'TCP bridge port',
			type: 'number',
			required: true,
			default: 9100,
			hint: 'Port of the serial-to-TCP bridge (only used when transport is tcp-bridge).',
		},
		{
			key: 'idLength',
			label: 'Patient ID width',
			type: 'select',
			required: true,
			default: '9',
			options: [
				{ value: '8', label: '8 (Id8 variant)' },
				{ value: '9', label: '9 (Id9 variant)' },
			],
			hint: 'Fixed-width patient ID field as configured on the Kenza analyzer.',
		},
		{
			key: 'pushIntervalMs',
			label: 'Order push interval (ms)',
			type: 'number',
			required: true,
			default: 5000,
			hint: 'How often the LIS polls for pending orders and pushes them to the analyzer.',
		},
		{
			key: 'estimatedMinutes',
			label: 'Estimated minutes',
			type: 'number',
			required: true,
			default: 15,
			hint: 'Initial completion time estimate shown while a sample is being analyzed.',
		},
		{
			key: 'trace',
			label: 'Trace logging',
			type: 'boolean',
			required: true,
			default: false,
			hint: 'Enable verbose protocol logging (raw payloads, BCC values, push attempts).',
		},
	] as const satisfies DriverConfigField[];

	readonly id = BiolaboKenza.id;
	readonly brand = BiolaboKenza.brand;
	readonly model = 'Kenza 240TX';

	private configuration?: BiolaboKenzaConfig;
	private kenzaConn?: KenzaSerialProtocol;
	private pushTimer?: ReturnType<typeof setInterval>;
	private pushing = false;
	/** Background read loop, resolves once the link closes. */
	private readLoop?: Promise<void>;
	private readonly pendingOrders = new Map<string, MachineOrder>();

	constructor() {
		super();
	}

	override configure(config: unknown): void {
		if (this.connected || this.running || this.com || this.kenzaConn) {
			throw new Error(
				'BiolaboKenza cannot be reconfigured while it is active.',
			);
		}
		this.configuration = BiolaboKenza.configSchema.parse(config);
	}

	override async connect(): Promise<void> {
		if (this.connected) return;
		const config = this.requireConfiguration();

		const com = new MachineCom(this.buildTransportSpec(config));
		this.com = com;
		await com.connect();
		this.watchConnection(com);

		this.kenzaConn = new KenzaSerialProtocol(
			com,
			async (payload) => await this.handlePayload(payload),
			createLogger('BiolaboKenza:Serial'),
		);
	}

	override start(): Promise<void> {
		if (!this.kenzaConn) {
			throw new Error(
				'BiolaboKenza protocol is not initialized. Call connect() first.',
			);
		}
		this.markStarted();
		this.startPushTimer();

		// The serial read loop blocks until the port closes, so it runs in the
		// background. Awaiting it here would never return, and the registry
		// would never record this machine as running. shutdown() drains it.
		this.readLoop = this.kenzaConn.start().finally(() => {
			this.clearPushTimer();
			if (this.connected) this.markDisconnected();
		});
		return Promise.resolve();
	}

	override async shutdown(): Promise<void> {
		this.clearPushTimer();

		const conn = this.kenzaConn;
		this.kenzaConn = undefined;
		if (conn) conn.close();

		// Let the background reader observe the close before we tear down.
		const readLoop = this.readLoop;
		this.readLoop = undefined;
		if (readLoop) await readLoop.catch((error) => this.handleError(error));

		this.com = undefined;
		this.pendingOrders.clear();
		this.pushing = false;
		this.markStopped();
		if (this.connected) this.markDisconnected();
	}

	override sendOrder(order: MachineOrder): Promise<void> {
		if (order.sampleId.trim() === '') {
			throw new Error('BiolaboKenza order sampleId is required.');
		}
		if (order.tests.length === 0) {
			throw new Error(
				`BiolaboKenza order "${order.sampleId}" has no tests.`,
			);
		}
		this.pendingOrders.set(order.sampleId, {
			...order,
			status: order.status ?? 'pending',
		});
		return Promise.resolve();
	}

	override removeOrder(sampleId: string): Promise<void> {
		this.pendingOrders.delete(sampleId);
		return Promise.resolve();
	}

	// private helpers
	private async handlePayload(payload: string): Promise<void> {
		const config = this.requireConfiguration();

		if (config.trace) {
			const bytes = new TextEncoder().encode(payload);
			this.createTraceLogger().info(
				`Kenza RX len=${payload.length} visible="${visibleBytes(bytes)}" hex=${formatBytes(bytes)}`,
			);
		}

		const result = parseKenzaPayload(payload, config.idLength);

		if (result.payload.results.length === 0) {
			this.createTraceLogger().warn(
				`Kenza ignored empty result payload sample="${result.sampleId}"`,
			);
			return;
		}

		await this.emit('result', result);
		this.pendingOrders.delete(result.sampleId);
	}

	private startPushTimer(): void {
		const config = this.requireConfiguration();

		this.pushTimer = setInterval(async () => {
			if (this.pushing || !this.kenzaConn || this.kenzaConn.isClosed) return;

			const pending = [...this.pendingOrders.values()].filter(
				(o) => o.status === 'pending',
			);
			if (pending.length === 0) return;

			this.pushing = true;
			try {
				for (const order of pending) {
					if (!this.kenzaConn || this.kenzaConn.isClosed) break;

					const payload = buildKenzaOrder(order, config.idLength);

					if (config.trace) {
						const bytes = new TextEncoder().encode(payload);
						this.createTraceLogger().info(
							`Kenza TX sample="${order.sampleId}" Id${config.idLength} ` +
							`tests=[${order.tests.join(',')}] ` +
							`visible="${visibleBytes(bytes)}" hex=${formatBytes(bytes)}`,
						);
					}

					await this.kenzaConn.send(payload);

					const now = new Date();
					const sentOrder: MachineOrder = {
						...order,
						status: 'testing',
						sentAt: now,
						startedAt: now,
						estimatedDurationMinutes: config.estimatedMinutes,
						estimatedCompletionAt: new Date(
							now.getTime() + config.estimatedMinutes * 60_000,
						),
					};
					this.pendingOrders.set(order.sampleId, sentOrder);
					await this.emit('order-sent', { order: sentOrder });
				}
			} catch (error) {
				await this.handleError(error);
			} finally {
				this.pushing = false;
			}
		}, config.pushIntervalMs);
	}

	private clearPushTimer(): void {
		if (this.pushTimer !== undefined) {
			clearInterval(this.pushTimer);
			this.pushTimer = undefined;
		}
	}

	private buildTransportSpec(config: BiolaboKenzaConfig): TransportSpec {
		if (config.transport === 'tcp-bridge') {
			return { kind: 'tcp-client', host: config.host, port: config.port };
		}
		return {
			kind: 'serial',
			portName: config.portName,
			baud: config.baud,
			dataBits: config.dataBits,
			stopBits: config.stopBits,
			parity: config.parity,
			flowControl: config.flowControl,
			reconnectDelayMs: config.reconnectDelayMs,
		};
	}

	private watchConnection(com: MachineCom): void {
		void com
			.whenConnected()
			.then(() => {
				if (this.com === com && !this.connected) this.markConnected();
			})
			.catch((error) => {
				if (this.com === com) void this.handleError(error);
			});
	}

	private requireConfiguration(): BiolaboKenzaConfig {
		if (!this.configuration) {
			throw new Error(
				'BiolaboKenza is not configured. Call configure() before connect().',
			);
		}
		return this.configuration;
	}

	private createTraceLogger() {
		return createLogger('BiolaboKenza:Trace');
	}

	private async handleError(error: unknown): Promise<void> {
		await this.emit(
			'error',
			error instanceof Error ? error : new Error(String(error)),
		);
	}
}
