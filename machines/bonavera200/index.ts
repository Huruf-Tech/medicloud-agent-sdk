import * as z from '@zod/zod';
import { BaseMachine } from '../../abstracts/baseMachine.ts';
import { MachineCom } from '../../transports/machineCom.ts';
import { Bonavera200Protocol } from '../../protocols/hl7/variants/bonavera200.ts';
import type {
	DriverConfigField,
	DriverTransportType,
	MachineConfig,
	MachineConfigSchema,
	MachineOrder,
	MachineResultEvent,
} from '../../types.ts';
import { managedCatalogTests } from '../../lib/catalogAccess.ts';
import { parseBonavera200Hl7 } from './inbound.ts';
import { buildAck, buildDsrWithOrder, buildQck } from './outbound.ts';
import { bonavera200MachineId } from '../../lib/constants.ts';

export interface Bonavera200Config extends MachineConfig {
	host: string;
	port: number;
	estimatedMinutes: number;
}

const catalogCapturePath = './data/bonavera200-catalog-captures.jsonl';

export class Bonavera200 extends BaseMachine {
	static readonly id = bonavera200MachineId;
	static readonly brand = 'BONAVERA-200';
	static readonly protocol = {
		name: 'HL7 over MLLP',
		version: '2.3.1',
	} as const;
	static readonly transportType: DriverTransportType = 'tcp';
	static readonly models = ['Bonavera 200'] as const;
	static readonly configSchema = z.object({
		host: z.string().trim().min(1, 'Host is required'),
		port: z.number().int().min(1).max(65535),
		estimatedMinutes: z.number().positive().default(15),
	}).strict() satisfies MachineConfigSchema<Bonavera200Config>;
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
			default: 9007,
		},
		{
			key: 'estimatedMinutes',
			label: 'Estimated minutes',
			type: 'number',
			required: false,
			default: 15,
		},
	] as const satisfies DriverConfigField[];

	readonly id = Bonavera200.id;
	readonly brand = Bonavera200.brand;
	readonly model = 'Bonavera 200';

	private configuration?: Bonavera200Config;
	private protocol?: Bonavera200Protocol;
	private readonly orders = new Map<string, MachineOrder>();

	override configure(config: unknown): void {
		if (this.connected || this.running || this.com || this.protocol) {
			throw new Error(
				'Bonavera 200 cannot be reconfigured while it is active.',
			);
		}
		this.configuration = Bonavera200.configSchema.parse(config);
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
		this.protocol = new Bonavera200Protocol(com, {
			loggerScope: 'Bonavera200:HL7',
			onMessage: (message) => this.handleMessage(message),
			onError: (error) => this.handleError(error),
			onClose: () => {
				this.markStopped();
				if (this.connected) this.markDisconnected();
			},
		});
	}

	override async start(): Promise<void> {
		if (!this.protocol || this.protocol.isClosed) {
			throw new Error(
				'Bonavera 200 protocol is not initialized. Call connect() first.',
			);
		}
		if (this.running) return;
		await this.protocol.start();
		this.markStarted();
	}

	override async shutdown(): Promise<void> {
		this.markStopped();
		const protocol = this.protocol;
		const com = this.com;
		this.protocol = undefined;
		this.com = undefined;
		if (protocol) {
			protocol.close();
			await protocol.waitUntilClosed().catch((error) =>
				this.handleError(error)
			);
		} else if (com) {
			com.close();
		}
		this.orders.clear();
		if (this.connected) this.markDisconnected();
	}

	override sendOrder(order: MachineOrder): Promise<void> {
		if (!order.sampleId.trim()) {
			throw new Error('Bonavera 200 order sampleId is required.');
		}
		if (order.tests.length === 0) {
			throw new Error(
				`Bonavera 200 order "${order.sampleId}" has no tests.`,
			);
		}
		const availableTests = new Set(
			managedCatalogTests(bonavera200MachineId).map((test) => test.code),
		);
		for (const test of order.tests) {
			if (!availableTests.has(test)) {
				throw new Error(
					`Bonavera 200 test "${test}" is not enabled in the catalog.`,
				);
			}
		}
		if (order.id !== undefined) {
			for (const [sampleId, staged] of this.orders) {
				if (staged.id === order.id && sampleId !== order.sampleId) {
					this.orders.delete(sampleId);
				}
			}
		}
		this.orders.set(order.sampleId, {
			...order,
			status: order.status ?? 'pending',
		});
		return Promise.resolve();
	}

	override removeOrder(sampleId: string): Promise<void> {
		this.orders.delete(sampleId);
		return Promise.resolve();
	}

	private async handleMessage(raw: string): Promise<void> {
		const protocol = this.protocol;
		if (!protocol || protocol.isClosed) return;
		const parsed = parseBonavera200Hl7(raw);
		const triggerEvent =
			Bonavera200Protocol.getComponent(parsed.messageType, 2) || 'R01';
		const trigger = Bonavera200Protocol.getComponent(parsed.messageType, 1);
		if (trigger === 'ACK') return;

		if (parsed.kind === 'results' && parsed.result) {
			try {
				await this.captureCatalogCandidates(
					parsed.messageId,
					parsed.result,
				);
			} catch (error) {
				void this.handleError(error).catch(() => undefined);
			}
			await this.emit('result', parsed.result);
			const order = this.orders.get(parsed.result.sampleId);
			if (order) {
				this.orders.set(order.sampleId, {
					...order,
					status: 'completed',
				});
			}
			await protocol.send(buildAck(parsed.messageId, 'AA', triggerEvent));
			return;
		}

		if (parsed.kind === 'query') {
			await this.emit('order-query', {
				sampleId: parsed.querySampleId,
				raw,
			});
			const now = Date.now();
			const pending = parsed.querySampleId
				? [this.orders.get(parsed.querySampleId)].filter(
					(order): order is MachineOrder =>
						order !== undefined &&
						order.status !== 'failed' &&
						order.expiresAt.getTime() > now,
				)
				: [...this.orders.values()].filter(
					(order) =>
						order.status === 'pending' &&
						order.expiresAt.getTime() > now,
				);
			await protocol.send(
				buildQck(parsed.messageId, pending.length ? 'OK' : 'NF'),
			);
			for (let i = 0; i < pending.length; i++) {
				const order = pending[i];
				if (this.orders.get(order.sampleId) !== order) continue;
				const continuation = i < pending.length - 1
					? String(i + 1)
					: '';
				const response = buildDsrWithOrder(
					parsed.messageId,
					order,
					parsed.rawQrd,
					parsed.rawQrf,
					continuation,
				);
				await protocol.send(response);
				await this.markOrderSent(order, response);
			}
			return;
		}

		await protocol.send(buildAck(parsed.messageId, 'AA', triggerEvent));
	}

	/**
	 * Record catalog candidates from every ORU before order correlation.
	 * This file contains assay identifiers, names and units, not patient details.
	 */
	private async captureCatalogCandidates(
		messageId: string,
		result: MachineResultEvent,
	): Promise<void> {
		const record = {
			receivedAt: result.receivedAt.toISOString(),
			messageId,
			analytes: result.payload.results.map((analyte) => ({
				assayNo: analyte.assayNo,
				assayName: analyte.assayName,
				unit: analyte.unit,
			})),
			// raw: result.raw ?? null,
		};
		await Deno.mkdir('./data', { recursive: true });
		await Deno.writeTextFile(
			catalogCapturePath,
			JSON.stringify(record) + '\n',
			{ create: true, append: true },
		);
	}
	private async markOrderSent(
		order: MachineOrder,
		raw: string,
	): Promise<void> {
		if (
			this.orders.get(order.sampleId) !== order ||
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
		this.orders.set(order.sampleId, sentOrder);
		await this.emit('order-sent', { order: sentOrder, raw });
	}

	private watchConnection(com: MachineCom): void {
		void com.whenConnected().then(() => {
			if (this.com === com && !this.connected) this.markConnected();
		}).catch((error) => {
			if (this.com === com) void this.handleError(error);
		});
	}

	private requireConfiguration(): Bonavera200Config {
		if (!this.configuration) {
			throw new Error(
				'Bonavera 200 is not configured. Call configure() before connect().',
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
