import * as z from '@zod/zod';
import { BaseMachine } from '../../abstracts/baseMachine.ts';
import { MachineCom } from '../../transports/machineCom.ts';
import { BonaveraCountProtocol } from '../../protocols/hl7/variants/bonaveraCount.ts';
import type {
	DriverConfigField,
	DriverTransportType,
	MachineConfig,
	MachineConfigSchema,
	MachineOrder,
} from '../../types.ts';
import { BONAVERA_COUNT_MODELS } from './catalog.ts';
import { parseBonaveraCountHl7 } from './inbound.ts';
import { buildAck, buildOrm, buildQueryResponse } from './outbound.ts';
import { bonaveraCountMachineId } from '../../lib/constants.ts';

export interface BonaveraCountConfig extends MachineConfig {
	host: string;
	port: number;
	pushOrders: boolean;
	pushIntervalMs: number;
	estimatedMinutes: number;
}

export class BonaveraCount extends BaseMachine {
	static readonly id = bonaveraCountMachineId;
	static readonly brand = 'BIOGENY-BONAVERA-COUNT';
	static readonly protocol = {
		name: 'HL7 over MLLP',
		version: '2.3.1',
	} as const;
	static readonly transportType: DriverTransportType = 'tcp';
	static readonly models = BONAVERA_COUNT_MODELS;
	static readonly defaultOrderTests = ['CBC'] as const;

	// Backend profile validation with defaults from the tested source config.
	static readonly configSchema = z.object({
		host: z.string().trim().min(1, 'Host is required'),
		port: z.number().int().min(1).max(65535),
		pushOrders: z.boolean().default(true),
		pushIntervalMs: z.number().int().positive().default(1000),
		estimatedMinutes: z.number().positive().default(3),
	}).strict() satisfies MachineConfigSchema<BonaveraCountConfig>;

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
			default: 9008,
		},
		{
			key: 'pushOrders',
			label: 'Push orders',
			type: 'boolean',
			required: false,
			default: true,
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
			default: 3,
		},
	] as const satisfies DriverConfigField[];

	readonly id = BonaveraCount.id;
	readonly brand = BonaveraCount.brand;
	readonly model = 'Bonavera Count';

	private configuration?: BonaveraCountConfig;
	private protocol?: BonaveraCountProtocol;
	private readonly pendingOrders = new Map<string, MachineOrder>();
	private readonly deliveredResults = new Set<string>();
	private pushTimer?: ReturnType<typeof setTimeout>;
	private pushTask?: Promise<void>;

	override configure(config: unknown): void {
		if (this.connected || this.running || this.com || this.protocol) {
			throw new Error(
				'Bonavera Count cannot be reconfigured while it is active.',
			);
		}
		this.configuration = BonaveraCount.configSchema.parse(config);
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
		this.protocol = new BonaveraCountProtocol(com, {
			loggerScope: 'BonaveraCount:HL7',
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
				'Bonavera Count protocol is not initialized. Call connect() first.',
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
		this.deliveredResults.clear();
		if (this.connected) this.markDisconnected();
	}

	override sendOrder(order: MachineOrder): Promise<void> {
		if (order.sampleId.trim() === '') {
			throw new Error('Bonavera Count order sampleId is required.');
		}
		if (order.tests.length === 0) {
			throw new Error(
				`Bonavera Count order "${order.sampleId}" has no tests.`,
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
		// Preserve explicit legacy test lists. The wire builder always requests CBC.
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
		const protocol = this.protocol;
		if (!protocol || protocol.isClosed) return;
		const parsed = parseBonaveraCountHl7(message);
		if (parsed.kind === 'ack') return;

		if (parsed.kind === 'results' && parsed.result) {
			const raw = parsed.result.raw ?? message;
			if (!this.deliveredResults.has(raw)) {
				const sampleId = this.resolveCountSampleId(
					parsed.result.sampleId,
				);
				const result = { ...parsed.result, sampleId };
				// Persist before acknowledging so failures leave the message retryable.
				await this.emit('result', result);
				this.deliveredResults.add(raw);
				const order = this.pendingOrders.get(sampleId);
				if (order) {
					this.pendingOrders.set(sampleId, {
						...order,
						status: 'completed',
					});
				}
			}
			await protocol.send(
				buildAck(
					parsed.messageId,
					'AA',
					'Results received successfully',
				),
			);
			return;
		}

		if (parsed.kind === 'query') {
			await this.emit('order-query', {
				sampleId: parsed.querySampleId,
				raw: message,
			});
			const staged = parsed.querySampleId
				? this.pendingOrders.get(parsed.querySampleId)
				: undefined;
			const order = staged && staged.expiresAt.getTime() > Date.now()
				? staged
				: null;
			const response = buildQueryResponse(parsed.messageId, order);
			await protocol.send(response);
			if (order) await this.markOrderSent(order, response);
			return;
		}

		await protocol.send(
			buildAck(parsed.messageId, 'AA', 'Message received'),
		);
	}

	/** Preserve the tested exact-first, unique one-digit-difference fallback. */
	private resolveCountSampleId(
		resultSampleId: string,
	): string {
		const active = [...this.pendingOrders.values()].filter((order) =>
			order.expiresAt.getTime() > Date.now()
		);
		if (active.some((order) => order.sampleId === resultSampleId)) {
			return resultSampleId;
		}
		const nearMatches = active.filter((order) =>
			(order.status === 'pending' || order.status === 'testing') &&
			this.isNearSampleId(order.sampleId, resultSampleId)
		);
		return nearMatches.length === 1
			? nearMatches[0].sampleId
			: resultSampleId;
	}

	private isNearSampleId(
		stagedSampleId: string,
		resultSampleId: string,
	): boolean {
		const staged = stagedSampleId.trim();
		const result = resultSampleId.trim();
		if (staged === result) return true;
		if (!/^\d+$/.test(staged) || !/^\d+$/.test(result)) return false;
		if (staged.length !== result.length) return false;

		let differences = 0;
		for (let i = 0; i < staged.length; i++) {
			if (staged[i] !== result[i]) differences++;
			if (differences > 1) return false;
		}
		return differences === 1;
	}

	private async markOrderSent(
		order: MachineOrder,
		raw: string,
	): Promise<void> {
		// A result, removal or update may arrive while transmission is pending.
		if (
			this.pendingOrders.get(order.sampleId) !== order ||
			order.status === 'completed'
		) return;
		const startedAt = new Date();
		const estimatedDurationMinutes =
			this.requireConfiguration().estimatedMinutes;
		const sentOrder: MachineOrder = {
			...order,
			status: 'testing',
			sentAt: startedAt,
			startedAt,
			estimatedDurationMinutes,
			estimatedCompletionAt: new Date(
				startedAt.getTime() + estimatedDurationMinutes * 60_000,
			),
		};
		this.pendingOrders.set(order.sampleId, sentOrder);
		await this.emit('order-sent', { order: sentOrder, raw });
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
			await this.markOrderSent(order, message);
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

	private requireConfiguration(): BonaveraCountConfig {
		if (!this.configuration) {
			throw new Error(
				'Bonavera Count is not configured. Call configure() before connect().',
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
