import * as z from '@zod/zod';
import { BaseMachine } from '../../abstracts/baseMachine.ts';
import { ASTM_CONTROL } from '../../protocols/astm/constants.ts';
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
import {
	SYSMEX_KX21N_ASTM_OPTIONS,
	SysmexKx21nAstmProtocol,
	type SysmexKx21nFrame,
} from './astm.ts';
import { SYSMEX_KX21N_MODELS } from './catalog.ts';
import { managedCatalogTests } from '../../lib/catalogAccess.ts';
import {
	looksLikeAstmPayload,
	parseSysmexKx21nPayload,
	stripAstmFrameNumber,
	type SysmexKx21nDateOrder,
	type SysmexKx21nOutputFormat,
} from './inbound.ts';
import { sysmexKx21nMachineId } from '../../lib/constants.ts';

export interface SysmexKx21nConfig extends MachineConfig {
	portName: string;
	baud: number;
	dataBits: DataBits;
	stopBits: StopBits;
	parity: SerialParity;
	flowControl: SerialFlowControl;
	reconnectDelayMs: number;
	protocol: 'class-a' | 'class-b';
	outputFormat: SysmexKx21nOutputFormat;
	dateOrder: SysmexKx21nDateOrder;
	stripSampleLeadingZeroes: boolean;
	estimatedMinutes: number;
	trace: boolean;
}

export class SysmexKx21n extends BaseMachine {
	static readonly id = sysmexKx21nMachineId;
	static readonly brand = 'SYSMEX KX21N';
	static readonly protocol = {
		name: 'Sysmex KX fixed-width host output',
		version: 'Class A/Class B',
	} as const;
	static readonly transportType: DriverTransportType = 'serial';
	static readonly models = SYSMEX_KX21N_MODELS;
	static readonly defaultOrderTests = ['CBC'] as const;

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
			z.union([z.literal(1), z.literal(1.5), z.literal(2)]),
		),
		parity: z.enum(['n', 'o', 'e']),
		flowControl: z.enum(['none', 'xonxoff', 'rtscts']),
		reconnectDelayMs: z.number().int().min(0),
		protocol: z.enum(['class-a', 'class-b']),
		outputFormat: z.enum(['auto', 'kx-21n', 'k-1000']),
		dateOrder: z.enum(['ymd', 'mdy', 'dmy']),
		stripSampleLeadingZeroes: z.boolean(),
		estimatedMinutes: z.number().positive(),
		trace: z.boolean(),
	}).strict().transform(({ serialPort, ...config }) => ({
		...config,
		portName: serialPort,
	})) satisfies MachineConfigSchema<SysmexKx21nConfig>;

	// for frontend fields generation
	static readonly configFields = [
		{
			key: 'serialPort',
			label: 'Serial port',
			type: 'string',
			required: true,
			default: 'COM3',
			hint: 'COM port name (for example COM3 on Windows).',
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
			default: 'none',
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
			hint:
				'Retained for serial transport compatibility; automatic reconnect is not yet supervised by the SDK.',
		},
		{
			key: 'protocol',
			label: 'Host protocol class',
			type: 'select',
			required: true,
			default: 'class-b',
			options: [{ value: 'class-b', label: 'Class B (ACK)' }, {
				value: 'class-a',
				label: 'Class A (one-way)',
			}],
			hint: 'Class B acknowledges ENQ and every received frame.',
		},
		{
			key: 'outputFormat',
			label: 'Output format',
			type: 'select',
			required: true,
			default: 'auto',
			options: [{ value: 'auto', label: 'Auto detect' }, {
				value: 'kx-21n',
				label: 'KX-21N fixed width',
			}, { value: 'k-1000', label: 'K-1000 fixed width' }],
		},
		{
			key: 'dateOrder',
			label: 'Date order',
			type: 'select',
			required: true,
			default: 'ymd',
			options: [{ value: 'ymd', label: 'Year / month / day' }, {
				value: 'mdy',
				label: 'Month / day / year',
			}, { value: 'dmy', label: 'Day / month / year' }],
		},
		{
			key: 'stripSampleLeadingZeroes',
			label: 'Strip sample leading zeroes',
			type: 'boolean',
			required: true,
			default: true,
		},
		{
			key: 'estimatedMinutes',
			label: 'Estimated minutes',
			type: 'number',
			required: true,
			default: 3,
			hint:
				'Initial display estimate retained from the legacy Sysmex configuration.',
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

	readonly id = SysmexKx21n.id;
	readonly brand = SysmexKx21n.brand;
	readonly model = 'KX-21N';

	private configuration?: SysmexKx21nConfig;
	private protocol?: SysmexKx21nAstmProtocol;
	private readonly pendingOrders = new Map<string, MachineOrder>();
	private readonly deliveredResults = new Set<string>();
	private astmChunks: string[] = [];

	constructor() {
		super();
	}

	override configure(config: unknown): void {
		if (this.connected || this.running || this.com || this.protocol) {
			throw new Error(
				'Sysmex KX-21N cannot be reconfigured while it is active.',
			);
		}
		this.configuration = SysmexKx21n.configSchema.parse(config);
	}

	override async connect(): Promise<void> {
		if (this.connected) return;
		const config = this.requireConfiguration();
		const com = new MachineCom(this.transportSpec(config));
		this.com = com;
		await com.connect();
		this.watchConnection(com);
		this.protocol = new SysmexKx21nAstmProtocol(com, {
			...SYSMEX_KX21N_ASTM_OPTIONS,
			classB: config.protocol === 'class-b',
			trace: config.trace,
			loggerScope: 'SysmexKx21n:HostOutput',
			onMessage: (frame) => this.handleFrame(frame),
			onError: (error) => this.handleError(error),
			onClose: () => {
				this.markStopped();
				if (this.connected) this.markDisconnected();
			},
		});
	}

	override async start(): Promise<void> {
		if (!this.protocol) {
			throw new Error(
				'Sysmex KX-21N protocol is not initialized. Call connect() first.',
			);
		}
		await this.protocol.start();
		this.markStarted();
	}

	override async shutdown(): Promise<void> {
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
		this.astmChunks = [];
		this.markStopped();
		if (this.connected) this.markDisconnected();
	}

	/**
	 * The published KX host interface is upload-only. This stages an LIS order
	 * solely so the registry can correlate the later result, no bytes are sent.
	 */
	override sendOrder(order: MachineOrder): Promise<void> {
		if (order.sampleId.trim() === '') {
			throw new Error('Sysmex KX-21N order sampleId is required.');
		}
		for (const test of order.tests) {
			if (
				!managedCatalogTests(sysmexKx21nMachineId).some((entry) =>
					entry.code === test?.trim()?.toUpperCase()
				)
			) {
				throw new Error(
					`Sysmex KX-21N does not support test code "${test}".`,
				);
			}
		}
		this.pendingOrders.set(order.sampleId, order);
		return Promise.resolve();
	}

	override removeOrder(sampleId: string): Promise<void> {
		this.pendingOrders.delete(sampleId);
		return Promise.resolve();
	}

	private async handleFrame(frame: SysmexKx21nFrame): Promise<void> {
		const normalized = this.normalizeFrame(frame);
		if (!normalized) return;
		const parsed = parseSysmexKx21nPayload(
			normalized,
			this.requireConfiguration(),
		);
		if (parsed.kind !== 'analysis' || !parsed.result) return;

		const result = parsed.result;
		const key = `${result.sampleId}\0${result.raw ?? ''}`;
		if (this.deliveredResults.has(key)) return;
		this.deliveredResults.add(key);
		try {
			await this.emit('result', result);
			this.pendingOrders.delete(result.sampleId);
		} catch (error) {
			this.deliveredResults.delete(key);
			throw error;
		}
	}

	private normalizeFrame(frame: SysmexKx21nFrame): string | undefined {
		if (this.astmChunks.length > 0 || looksLikeAstmPayload(frame.payload)) {
			this.astmChunks.push(stripAstmFrameNumber(frame.payload));
			if (frame.terminator === ASTM_CONTROL.ETB) return undefined;
			const payload = this.astmChunks.join('');
			this.astmChunks = [];
			return payload;
		}
		return frame.payload;
	}

	private transportSpec(config: SysmexKx21nConfig): TransportSpec {
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
		void com.whenConnected().then(() => {
			if (this.com === com && !this.connected) this.markConnected();
		}).catch((error) => {
			if (this.com === com) void this.handleError(error);
		});
	}

	private requireConfiguration(): SysmexKx21nConfig {
		if (!this.configuration) {
			throw new Error(
				'Sysmex KX-21N is not configured. Call configure() before connect().',
			);
		}
		return this.configuration;
	}

	private async handleError(error: unknown): Promise<void> {
		await this.emit(
			'error',
			error instanceof Error ? error : new Error(String(error)),
		);
	}
}
