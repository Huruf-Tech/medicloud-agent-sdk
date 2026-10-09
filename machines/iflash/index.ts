import * as z from '@zod/zod';
import { BaseMachine } from '../../abstracts/baseMachine.ts';
import type {
	DriverConfigField,
	DriverTransportType,
	MachineConfig,
	MachineConfigSchema,
	MachineOrder,
	TransportSpec,
} from '../../types.ts';
import { AstmProtocol } from '../../protocols/astm/link.ts';
import { MachineCom } from '../../transports/machineCom.ts';
import {
	parseIFlashMessage,
	rawIFlashRecords,
	toMachineResult,
} from './inbound.ts';
import {
	buildIFlashNoOrderResponse,
	buildIFlashOrderResponse,
} from './outbound.ts';
import { delay } from '../../lib/utils.ts';
import {
	iFlashVariantFromModel,
	requireIFlashTestEntry,
	YHLO_IFLASH_3000_MODELS,
} from './catalog.ts';
import { IFLASH_ASTM_OPTIONS } from './astm.ts';
import { iFlash3000MachineId } from '../../lib/constants.ts';

export interface IFlash3000Config extends MachineConfig {
	host: string;
	port: number;
	queryReplyDelayMs?: number;
}

const DEFAULT_QUERY_REPLY_DELAY_MS = 0;

export class IFlash3000 extends BaseMachine {
	static readonly id = iFlash3000MachineId;
	static readonly brand = 'YHLO IFLASH 3000';
	static readonly protocol = { name: 'ASTM', version: 'E1394-97' } as const;
	static readonly transportType: DriverTransportType = 'tcp';
	static readonly models = YHLO_IFLASH_3000_MODELS;

	// for backend profile config before save
	static readonly configSchema = z.object({
		host: z.string().trim().min(1, 'Host is required'),
		port: z.number().int().min(1).max(65535),
		queryReplyDelayMs: z.number().int().min(0).optional(),
	}).strict() satisfies MachineConfigSchema<IFlash3000Config>;

	// for frontend fields generation
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
			default: 7001,
			hint: 'TCP port (1-65535).',
		},
		{
			key: 'queryReplyDelayMs',
			label: 'Query reply delay (ms)',
			type: 'number',
			required: false,
			default: 0,
			hint: 'Milliseconds to wait before replying to a query.',
		},
	] as const satisfies DriverConfigField[];

	readonly id = IFlash3000.id;
	readonly brand = IFlash3000.brand;
	readonly model = 'iFlash 3000';

	private configuration?: IFlash3000Config;
	private readonly pendingOrders = new Map<string, MachineOrder>();
	private protocol?: AstmProtocol;

	constructor() {
		super();
	}

	/**
	 * Parse profile data inside the driver. No transport is created until this
	 * succeeds, so an invalid profile fails cleanly during machine startup.
	 */
	override configure(config: unknown): void {
		if (this.connected || this.running || this.com || this.protocol) {
			throw new Error(
				'iFlash 3000 cannot be reconfigured while it is active.',
			);
		}

		this.configuration = IFlash3000.configSchema.parse(config);
	}

	override async connect(): Promise<void> {
		if (this.connected) return;
		const config = this.requireConfiguration();

		const com = new MachineCom(this.transportSpec(config));
		this.com = com;
		await com.connect(); // start listening/open transport
		this.watchConnection(com);

		// initialize astm protocol
		this.protocol = new AstmProtocol(com, {
			...IFLASH_ASTM_OPTIONS,
			loggerScope: 'IFlash3000:ASTM',
			onMessage: (records, protocol, context) =>
				this.handleAstmMessage(
					records,
					protocol as unknown as AstmProtocol,
					context.remoteAddr,
				),
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
				'iFlash 3000 protocol is not initialized. Call connect() first.',
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

	// private helpers
	private async handleAstmMessage(
		records: Parameters<typeof rawIFlashRecords>[0],
		protocol: AstmProtocol,
		remoteAddr?: Deno.Addr,
	): Promise<void> {
		const raw = rawIFlashRecords(records);
		const address = this.remoteAddressName(remoteAddr, protocol.remoteName);
		const parsed = parseIFlashMessage(records, address, raw);

		if (parsed.kind === 'query') {
			const sampleId = parsed.querySampleId ?? '';
			await this.emit('order-query', { sampleId, raw });
			if (!this.requireConfiguration()) return; // extra check to verify that config exist or not

			const order = sampleId
				? this.pendingOrders.get(sampleId)
				: undefined;
			if (!order) {
				await this.delayBeforeQueryReply();
				await protocol.send(buildIFlashNoOrderResponse());
				return;
			}

			const response = buildIFlashOrderResponse(
				order,
				parsed.machine.model || 'YHLO iFlash 3000',
			);
			console.log(`iflash3000 machine qurying:`, response, order);
			await this.delayBeforeQueryReply();
			await protocol.send(response);

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
			this.pendingOrders.set(order.sampleId, sentOrder);
			await this.emit('order-sent', { order: sentOrder, raw: response });
			return;
		}

		if (parsed.kind === 'results' && parsed.result) {
			const result = toMachineResult(parsed.result);
			await this.emit('result', result);
			this.pendingOrders.delete(result.sampleId);
		}
	}

	private transportSpec(config: IFlash3000Config): TransportSpec {
		return {
			kind: 'tcp-server',
			host: config.host,
			port: config.port,
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

	private requireConfiguration(): IFlash3000Config {
		if (!this.configuration) {
			throw new Error(
				'iFlash 3000 is not configured. Call configure() before connect().',
			);
		}
		return this.configuration;
	}

	private assertOrder(order: MachineOrder): void {
		if (order.sampleId.trim() === '') {
			throw new Error('iFlash 3000 order sampleId is required.');
		}

		if (order.tests.length === 0) {
			throw new Error(
				`iFlash 3000 order "${order.sampleId}" has no tests.`,
			);
		}

		const variant = iFlashVariantFromModel(this.model);
		for (const testCode of order.tests) {
			requireIFlashTestEntry(testCode, variant);
		}
	}

	private async handleError(error: unknown): Promise<void> {
		const normalized = error instanceof Error
			? error
			: new Error(String(error));
		await this.emit('error', normalized);
	}

	private delayBeforeQueryReply(): Promise<void> {
		const delayMs = this.requireConfiguration().queryReplyDelayMs ??
			DEFAULT_QUERY_REPLY_DELAY_MS;
		return delay(delayMs);
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
