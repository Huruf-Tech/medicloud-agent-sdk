import * as z from '@zod/zod';
import { BaseMachine } from '../../abstracts/baseMachine.ts';
import { MachineCom } from '../../transports/machineCom.ts';
import { DrAccuAfi6100bProtocol } from '../../protocols/hl7/variants/draccuAfi6100b.ts';
import type {
	DriverConfigField,
	DriverTransportType,
	MachineConfig,
	MachineConfigSchema,
	MachineOrder,
} from '../../types.ts';
import { DRACCU_AFI_6100B_MODELS } from './catalog.ts';
import { parseDrAccuResultLine } from './inbound.ts';
import { buildOrm } from './outbound.ts';

export interface DrAccuAfi6100bConfig extends MachineConfig {
	host: string;
	port: number;
	pushOrders: boolean;
	pushIntervalMs: number;
	estimatedMinutes: number;
}

export const drAccuAfi6100bMachineId = 'draccu-afi-6100b';

export class DrAccuAfi6100b extends BaseMachine {
	static readonly id = drAccuAfi6100bMachineId;
	static readonly brand = 'DrAccu Afi 6100b';
	static readonly protocol = {
		name: 'HL7 ORM over MLLP / DrAccu R-line',
		version: '2.3.1',
	} as const;
	static readonly transportType: DriverTransportType = 'tcp';
	static readonly models = DRACCU_AFI_6100B_MODELS;

	// Backend profile validation; defaults match the tested source config.
	static readonly configSchema = z.object({
		host: z.string().trim().min(1, 'Host is required'),
		port: z.number().int().min(1).max(65535),
		pushOrders: z.boolean().default(false),
		pushIntervalMs: z.number().int().positive().default(1000),
		estimatedMinutes: z.number().positive().default(15),
	}).strict() satisfies MachineConfigSchema<DrAccuAfi6100bConfig>;

	// Frontend profile fields use the same metadata contract as other machines.
	static readonly configFields = [
		{
			key: 'host',
			label: 'Host',
			type: 'string',
			required: true,
			default: '0.0.0.0',
			hint: 'IP address the analyzer connects to.',
		},
		{
			key: 'port',
			label: 'Port',
			type: 'number',
			required: true,
			default: 9011,
		},
		{
			key: 'pushOrders',
			label: 'Push orders',
			type: 'boolean',
			required: false,
			default: false,
			hint: 'Send pending orders as HL7 ORM messages.',
		},
		{
			key: 'pushIntervalMs',
			label: 'Order push interval (ms)',
			type: 'number',
			required: false,
			default: 1000,
		},
		{
			key: 'estimatedMinutes',
			label: 'Estimated minutes',
			type: 'number',
			required: false,
			default: 15,
		},
	] as const satisfies DriverConfigField[];

	readonly id = DrAccuAfi6100b.id;
	readonly brand = DrAccuAfi6100b.brand;
	readonly model = 'AFI-6100B';

	private configuration?: DrAccuAfi6100bConfig;
	private protocol?: DrAccuAfi6100bProtocol;
	private readonly pendingOrders = new Map<string, MachineOrder>();
	private pushTimer?: ReturnType<typeof setTimeout>;
	private pushTask?: Promise<void>;

	override configure(config: unknown): void {
		if (this.connected || this.running || this.com || this.protocol) {
			throw new Error(
				'DrAccu AFI-6100B cannot be reconfigured while it is active.',
			);
		}
		this.configuration = DrAccuAfi6100b.configSchema.parse(config);
	}

	override async connect(): Promise<void> {
		if (this.com) return;
		const config = this.requireConfiguration();
		const com = new MachineCom({
			kind: 'tcp-server',
			host: config.host,
			port: config.port,
		});
		this.com = com;
		await com.connect();
		this.watchConnection(com);
		this.protocol = new DrAccuAfi6100bProtocol(com, {
			loggerScope: 'DrAccuAfi6100b:HL7',
			onMessage: (message) => this.handleMessage(message),
			onError: (error) => this.handleError(error),
			onClose: () => {
				this.clearPushTimer();
				this.markStopped();
				if (this.connected) this.markDisconnected();
			},
		});
	}

	override async start(): Promise<void> {
		if (!this.protocol || this.protocol.isClosed) {
			throw new Error(
				'DrAccu AFI-6100B protocol is not initialized. Call connect() first.',
			);
		}
		if (this.running) return;
		await this.protocol.start();
		this.markStarted();
		this.startPush();
	}

	override async shutdown(): Promise<void> {
		this.markStopped();
		this.clearPushTimer();
		const protocol = this.protocol;
		const com = this.com;
		this.com = undefined;
		this.protocol = undefined;
		if (protocol) {
			protocol.close();
			await protocol.waitUntilClosed().catch((error) =>
				this.handleError(error)
			);
		} else if (com) {
			com.close();
		}
		await this.pushTask;
		this.com = undefined;
		this.pendingOrders.clear();
		if (this.connected) this.markDisconnected();
	}

	override sendOrder(order: MachineOrder): Promise<void> {
		if (order.sampleId.trim() === '') {
			throw new Error('DrAccu AFI-6100B order sampleId is required.');
		}
		if (order.tests.length === 0) {
			throw new Error(
				`DrAccu AFI-6100B order "${order.sampleId}" has no tests.`,
			);
		}
		// HTTP updates can rename a sample while retaining the same order ID.
		// Replace the staged order instead of sending both sample IDs.
		if (order.id !== undefined) {
			for (const [sampleId, staged] of this.pendingOrders) {
				if (staged.id === order.id && sampleId !== order.sampleId) {
					this.pendingOrders.delete(sampleId);
				}
			}
		}
		// Keep the tested free-form test names/codes; the catalog is lookup only.
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

	private async handleMessage(message: string): Promise<void> {
		const line = message.trim();
		if (!line.startsWith('R|')) return;
		const result = parseDrAccuResultLine(line);
		// The registry owns persistence, duplicate detection and order completion.
		await this.emit('result', result);
		this.pendingOrders.delete(result.sampleId);
	}

	private startPush(): void {
		if (
			!this.running || !this.connected || this.pushTask ||
			this.pushTimer !== undefined ||
			!this.requireConfiguration().pushOrders
		) return;
		let failed = false;
		this.pushTask = this.pushPendingOrders()
			.catch((error) => {
				failed = true;
				return this.handleError(error);
			})
			.finally(() => {
				this.pushTask = undefined;
				if (failed || !this.running || !this.connected) return;
				this.pushTimer = setTimeout(() => {
					this.pushTimer = undefined;
					this.startPush();
				}, this.requireConfiguration().pushIntervalMs);
			});
	}

	private async pushPendingOrders(): Promise<void> {
		const protocol = this.protocol;
		if (!protocol || protocol.isClosed) return;
		const config = this.requireConfiguration();
		for (const order of [...this.pendingOrders.values()]) {
			if (
				!this.running || protocol.isClosed || this.protocol !== protocol
			) return;
			if (
				order.status !== 'pending' ||
				order.expiresAt.getTime() <= Date.now() ||
				this.pendingOrders.get(order.sampleId) !== order
			) continue;
			const message = buildOrm(order);
			await protocol.send(message);
			// A result/removal can arrive while a write is in progress.
			if (this.pendingOrders.get(order.sampleId) !== order) continue;
			const startedAt = new Date();
			const sentOrder: MachineOrder = {
				...order,
				status: 'testing',
				sentAt: startedAt,
				startedAt,
				estimatedDurationMinutes: config.estimatedMinutes,
				estimatedCompletionAt: new Date(
					startedAt.getTime() + config.estimatedMinutes * 60_000,
				),
			};
			this.pendingOrders.set(order.sampleId, sentOrder);
			await this.emit('order-sent', { order: sentOrder, raw: message });
		}
	}

	private clearPushTimer(): void {
		if (this.pushTimer !== undefined) {
			clearTimeout(this.pushTimer);
			this.pushTimer = undefined;
		}
	}

	private watchConnection(com: MachineCom): void {
		void com.whenConnected().then(() => {
			if (this.com !== com) return;
			if (!this.connected) this.markConnected();
			this.startPush();
		}).catch((error) => {
			if (this.com === com) void this.handleError(error);
		});
	}

	private requireConfiguration(): DrAccuAfi6100bConfig {
		if (!this.configuration) {
			throw new Error(
				'DrAccu AFI-6100B is not configured. Call configure() before connect().',
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
