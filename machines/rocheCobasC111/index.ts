// Roche is serial RS-232 ASTM E1381/E1394, not generic TCP ASTM.

import * as z from '@zod/zod';
import { BaseMachine } from '../../abstracts/baseMachine.ts';
import { delay } from '../../lib/utils.ts';
import { MachineCom } from '../../transports/machineCom.ts';
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
import { COBAS_C111_MODELS, toCobasC111HostCode } from './catalog.ts';
import {
	CobasC111SerialAstmProtocol,
	ROCHE_COBAS_C111_ASTM_OPTIONS,
} from './astm.ts';
import {
	parseCobasC111Message,
	rawCobasC111Records,
	toMachineResult,
} from './inbound.ts';
import {
	buildCobasC111BatchOrder,
	buildCobasC111NoOrderResponse,
	buildCobasC111OrderResponse,
	buildCobasC111ResultQuery,
	type CobasC111HostSettings,
} from './outbound.ts';
import { rocheCobasC111MachineId } from '../../lib/constants.ts';

export interface RocheCobasC111Config extends MachineConfig {
	portName: string;
	baud: number;
	dataBits: DataBits;
	stopBits: StopBits;
	parity: SerialParity;
	flowControl: SerialFlowControl;
	reconnectDelayMs: number;
	replyToQueries: boolean;
	pushOrders: boolean;
	pushIntervalMs: number;
	resultPollingEnabled: boolean;
	resultPollInitialDelayMs: number;
	resultPollIntervalMs: number;
	hostSenderName: string;
	analyzerName: string;
	defaultComment?: string;
	trace: boolean;
}

export class RocheCobasC111 extends BaseMachine {
	static readonly id = rocheCobasC111MachineId;
	static readonly brand = 'ROCHE COBAS C111';
	static readonly protocol = {
		name: 'ASTM',
		version: 'E1381/E1394-97 (Roche serial variant)',
	} as const;
	static readonly transportType: DriverTransportType = 'serial';
	static readonly models = COBAS_C111_MODELS;

	// for backend profile config before save
	static readonly configSchema = z.object({
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
		stopBits: z.coerce.number().pipe(
			z.union([
				z.literal(1),
				z.literal(1.5),
				z.literal(2),
			]),
		),
		parity: z.enum(['n', 'o', 'e']),
		flowControl: z.enum(['none', 'xonxoff', 'rtscts']),
		reconnectDelayMs: z.number().int().min(0),
		replyToQueries: z.boolean(),
		pushOrders: z.boolean(),
		pushIntervalMs: z.number().int().min(1),
		resultPollingEnabled: z.boolean(),
		resultPollInitialDelayMs: z.number().int().min(0),
		resultPollIntervalMs: z.number().int().min(1),
		hostSenderName: z.string().trim().min(1),
		analyzerName: z.string().trim().min(1),
		defaultComment: z.string().optional(),
		trace: z.boolean(),
	}).strict().transform(({ serialPort, ...config }) => ({
		...config,
		portName: serialPort,
	})) satisfies MachineConfigSchema<RocheCobasC111Config>;

	// for frontend fields generation
	static readonly configFields = [
		{
			key: 'serialPort',
			label: 'Serial port',
			type: 'string',
			required: true,
			default: 'COM3',
			hint: 'COM port name (e.g. COM3 on Windows, /dev/ttyS0 on Linux).',
		},
		{
			key: 'baud',
			label: 'Baud rate',
			type: 'number',
			required: true,
			default: 9600,
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
			options: [{ value: '1', label: '1' }, {
				value: '1.5',
				label: '1.5',
			}, { value: '2', label: '2' }],
		},
		{
			key: 'parity',
			label: 'Parity',
			type: 'select',
			required: true,
			default: 'n',
			options: [{ value: 'n', label: 'None (n)' }, {
				value: 'o',
				label: 'Odd (o)',
			}, { value: 'e', label: 'Even (e)' }],
		},
		{
			key: 'flowControl',
			label: 'Flow control',
			type: 'select',
			required: true,
			default: 'xonxoff',
			options: [{ value: 'none', label: 'None' }, {
				value: 'xonxoff',
				label: 'XON/XOFF',
			}, { value: 'rtscts', label: 'RTS/CTS' }],
		},
		{
			key: 'reconnectDelayMs',
			label: 'Reconnect delay (ms)',
			type: 'number',
			required: true,
			default: 5000,
			hint: 'Wait time before reconnecting after a disconnect.',
		},
		{
			key: 'replyToQueries',
			label: 'Reply to queries',
			type: 'boolean',
			required: true,
			default: true,
			hint: 'Send worklist response when analyzer queries.',
		},
		{
			key: 'pushOrders',
			label: 'Push orders',
			type: 'boolean',
			required: true,
			default: false,
			hint: 'Proactively push pending orders to the analyzer.',
		},
		{
			key: 'pushIntervalMs',
			label: 'Push interval (ms)',
			type: 'number',
			required: true,
			default: 1000,
		},
		{
			key: 'resultPollingEnabled',
			label: 'Result polling',
			type: 'boolean',
			required: true,
			default: true,
		},
		{
			key: 'resultPollInitialDelayMs',
			label: 'Poll initial delay (ms)',
			type: 'number',
			required: true,
			default: 30000,
		},
		{
			key: 'resultPollIntervalMs',
			label: 'Poll interval (ms)',
			type: 'number',
			required: true,
			default: 30000,
		},
		{
			key: 'hostSenderName',
			label: 'Host sender name',
			type: 'string',
			required: true,
			default: 'Agent',
			hint: 'Sender name sent in ASTM H record.',
		},
		{
			key: 'analyzerName',
			label: 'Analyzer name',
			type: 'string',
			required: true,
			default: 'c111',
			hint: 'Receiver name expected in ASTM H record.',
		},
		{
			key: 'defaultComment',
			label: 'Default comment',
			type: 'string',
			required: false,
			default: 'Agent Com',
			hint: 'Comment appended to every order.',
		},
		{
			key: 'trace',
			label: 'Trace logging',
			type: 'boolean',
			required: true,
			default: false,
			hint: 'Enable verbose serial protocol logging.',
		},
	] as const satisfies DriverConfigField[];

	readonly id = RocheCobasC111.id;
	readonly brand = RocheCobasC111.brand;
	readonly model = 'cobas c111';

	private configuration?: RocheCobasC111Config;
	private readonly pendingOrders = new Map<string, MachineOrder>();
	private readonly deliveredResults = new Set<string>();
	private protocol?: CobasC111SerialAstmProtocol;
	private loopsStopped = true;

	constructor() {
		super();
	}

	override configure(
		config: z.infer<typeof RocheCobasC111.configSchema>,
	): void {
		if (this.connected || this.running || this.com || this.protocol) {
			throw new Error(
				'Roche cobas c111 cannot be reconfigured while it is active.',
			);
		}

		const parsed = RocheCobasC111.configSchema.parse(config);
		this.configuration = parsed;
	}

	override async connect(): Promise<void> {
		if (this.connected) return;
		const config = this.requireConfiguration();

		const com = new MachineCom(this.transportSpec(config));
		this.com = com;
		await com.connect(); // start listening/open transport
		this.watchConnection(com);

		// initialize astm protocol
		this.protocol = new CobasC111SerialAstmProtocol(com, {
			...ROCHE_COBAS_C111_ASTM_OPTIONS,
			loggerScope: 'RocheCobasC111:ASTM',
			trace: config.trace,
			onMessage: (records, protocol, context) =>
				this.handleAstmMessage(
					records,
					protocol as CobasC111SerialAstmProtocol,
					context.remoteAddr,
				),
			onError: (error) => this.handleError(error),
			onClose: () => {
				this.stopLoops();
				this.markStopped();
				if (this.connected) this.markDisconnected();
			},
		});
	}

	override async start(): Promise<void> {
		if (!this.protocol) {
			throw new Error(
				'Roche cobas c111 protocol is not initialized. Call connect() first.',
			);
		}

		await this.protocol.start();
		this.markStarted();
		this.startLoops(this.protocol);
	}

	override async shutdown(): Promise<void> {
		this.stopLoops();
		const protocol = this.protocol;
		this.protocol = undefined;

		if (protocol) {
			protocol.close();
			await protocol.waitUntilClosed().catch((error) =>
				this.handleError(error)
			);
		} else if (this.com) {
			try {
				this.com.close();
			} catch {
				// Already closed or never connected.
			}
		}

		this.com = undefined;
		this.pendingOrders.clear();
		this.deliveredResults.clear();
		this.markStopped();
		if (this.connected) this.markDisconnected();
	}

	override async sendOrder(order: MachineOrder): Promise<void> {
		this.assertOrder(order);

		// ASTM analyzers pull orders: stage now, respond when this sample is
		// requested by a Q record in handleAstmMessage().
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

	// private/protected helpers
	private async handleAstmMessage(
		records: Parameters<typeof rawCobasC111Records>[0],
		protocol: CobasC111SerialAstmProtocol,
		remoteAddr?: Deno.Addr,
	): Promise<void> {
		const raw = rawCobasC111Records(records);
		const address = this.remoteAddressName(remoteAddr, protocol.remoteName);
		const parsed = parseCobasC111Message(records, address, raw);

		if (parsed.kind === 'query') {
			const sampleId = parsed.querySampleId ?? '';
			await this.emit('order-query', { sampleId, raw });
			if (!this.requireConfiguration().replyToQueries) return;

			const order = sampleId
				? this.pendingOrders.get(sampleId)
				: undefined;
			if (!order || this.isExpiredOrder(order)) {
				await protocol.send(
					buildCobasC111NoOrderResponse(
						sampleId,
						this.hostSettings(),
					),
				);
				return;
			}

			const response = buildCobasC111OrderResponse(
				order,
				this.hostSettings(),
			);
			await protocol.send(response);
			await this.markOrderSent(order, response);
			return;
		}

		if (parsed.kind === 'results' && parsed.result) {
			const result = toMachineResult(parsed.result);
			const resultKey = this.resultKey(result.sampleId, result.raw ?? '');
			if (this.deliveredResults.has(resultKey)) return;

			this.deliveredResults.add(resultKey);
			try {
				await this.emit('result', result);
				this.pendingOrders.delete(result.sampleId);
			} catch (error) {
				this.deliveredResults.delete(resultKey);
				throw error;
			}
		}
	}

	private transportSpec(config: RocheCobasC111Config): TransportSpec {
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

	// to delay markConnected() until real analyzer connection exists.
	private watchConnection(com: MachineCom): void {
		void com.whenConnected().then(() => {
			if (this.com === com && !this.connected) this.markConnected();
		}).catch((error) => {
			if (this.com === com) void this.handleError(error);
		});
	}

	private startLoops(protocol: CobasC111SerialAstmProtocol): void {
		this.loopsStopped = false;
		const config = this.requireConfiguration();

		if (config.pushOrders) {
			void this.pushOrdersLoop(protocol).catch((error) =>
				this.handleError(error)
			);
		}

		if (config.resultPollingEnabled) {
			void this.resultPollingLoop(protocol).catch((error) =>
				this.handleError(error)
			);
		}
	}

	private stopLoops(): void {
		this.loopsStopped = true;
	}

	private async pushOrdersLoop(
		protocol: CobasC111SerialAstmProtocol,
	): Promise<void> {
		while (!this.loopsStopped && this.protocol === protocol) {
			for (const order of this.pendingOrders.values()) {
				if (this.loopsStopped || this.protocol !== protocol) return;
				if (order.status === 'testing' || this.isExpiredOrder(order)) {
					continue;
				}

				const message = buildCobasC111BatchOrder(
					order,
					this.hostSettings(),
				);
				await protocol.send(message);
				await this.markOrderSent(order, message);
			}

			await delay(this.requireConfiguration().pushIntervalMs);
		}
	}

	private async resultPollingLoop(
		protocol: CobasC111SerialAstmProtocol,
	): Promise<void> {
		await delay(this.requireConfiguration().resultPollInitialDelayMs);

		while (!this.loopsStopped && this.protocol === protocol) {
			for (const order of this.pendingOrders.values()) {
				if (this.loopsStopped || this.protocol !== protocol) return;
				if (order.status !== 'testing') continue;

				await protocol.send(
					buildCobasC111ResultQuery(
						order.sampleId,
						this.hostSettings(),
					),
				);
			}

			await delay(this.requireConfiguration().resultPollIntervalMs);
		}
	}

	private async markOrderSent(
		order: MachineOrder,
		raw: string[],
	): Promise<void> {
		const startedAt = new Date();
		const estimatedDurationMinutes = order.estimatedDurationMinutes;
		const sentOrder: MachineOrder = {
			...order,
			status: 'testing',
			sentAt: startedAt,
			startedAt,
			estimatedDurationMinutes,
			estimatedCompletionAt: estimatedDurationMinutes === undefined
				? undefined
				: new Date(
					startedAt.getTime() + estimatedDurationMinutes * 60_000,
				),
		};
		this.pendingOrders.set(sentOrder.sampleId, sentOrder);
		await this.emit('order-sent', { order: sentOrder, raw });
	}

	private assertOrder(order: MachineOrder): void {
		if (order.sampleId.trim() === '') {
			throw new Error('Roche cobas c111 order sampleId is required.');
		}

		if (order.tests.length === 0) {
			throw new Error(
				`Roche cobas c111 order "${order.sampleId}" has no tests.`,
			);
		}

		for (const testCode of order.tests) {
			if (toCobasC111HostCode(testCode).trim() === '') {
				throw new Error(
					`Roche cobas c111 order "${order.sampleId}" has an empty test code.`,
				);
			}
		}
	}

	private hostSettings(): CobasC111HostSettings {
		const config = this.requireConfiguration();
		return {
			hostSenderName: config.hostSenderName,
			analyzerName: config.analyzerName,
			defaultComment: config.defaultComment ?? '',
		};
	}

	private isExpiredOrder(order: MachineOrder): boolean {
		return order.expiresAt.getTime() <= Date.now();
	}

	private resultKey(sampleId: string, raw: string): string {
		return `${sampleId}\0${raw}`;
	}

	private requireConfiguration(): RocheCobasC111Config {
		if (!this.configuration) {
			throw new Error(
				'Roche cobas c111 is not configured. Call configure() before connect().',
			);
		}
		return this.configuration;
	}

	private async handleError(error: unknown): Promise<void> {
		const normalized = error instanceof Error
			? error
			: new Error(String(error));
		await this.emit('error', normalized);
	}

	private remoteAddressName(
		addr: Deno.Addr | undefined,
		fallback: string,
	): string {
		const netAddr = addr as Partial<Deno.NetAddr> | undefined;
		if (
			typeof netAddr?.hostname === 'string' && netAddr.hostname.length > 0
		) {
			return netAddr.hostname;
		}

		return fallback;
	}
}
