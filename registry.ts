import { ZodError } from '@zod/zod';
import { BaseMachine } from './abstracts/baseMachine.ts';
import { SqliteMachineDatabase } from './db/sqLite.ts';
import { createLogger, type Logger } from './lib/logger.ts';
import { requiredValue } from './lib/utils.ts';
import type {
	MachineDriverId,
	MachineEventHandler,
	MachineId,
	MachineOrder,
	MachineOrderUpdate,
	MachineProfile,
	MachineProfileInput,
	MachineProfileUpdate,
	MachineResult,
	MachineTestStatistic,
	RegisteredMachine,
	RunningMachine,
	StoredMachineResult,
	DriverConfigField,
	DriverProtocolInfo,
	DriverTransportType
} from './types.ts';
import {
	TOrderQuery,
	TProfileQuery,
	TResultQuery,
	TTestStatisticQuery,
} from './schema.ts';

export interface MachineRegistryOptions {
	dbPath?: string;
	/** Forwarded from MachineManagerOptions - see that interface for full docs. */
	onResultPersisted?: (
		result: StoredMachineResult & { machineId: MachineId },
	) => void | Promise<void>;
}

export interface MachineDriverView {
	readonly id: MachineDriverId;
	readonly brand?: string;
	readonly models: readonly string[];
	readonly protocol: DriverProtocolInfo;
	readonly defaultOrderTests: readonly string[];

	// field descriptor, this tells the UI what input to render for this driver config.
	readonly configFields: readonly DriverConfigField[]
	// this tells the ui what kind of driver it is to show config
	readonly transportType?: DriverTransportType;
}

export interface RunningMachineView {
	readonly profile: MachineProfile;
	readonly machine: {
		readonly id: string;
		readonly brand: string;
		readonly model: string;
		readonly connected: boolean;
		readonly running: boolean;
	};
}

interface MachineEventBindings {
	readonly connected: MachineEventHandler<'connected'>;
	readonly disconnected: MachineEventHandler<'disconnected'>;
	readonly orderQuery: MachineEventHandler<'order-query'>;
	readonly orderSent: MachineEventHandler<'order-sent'>;
	readonly result: MachineEventHandler<'result'>;
	readonly error: MachineEventHandler<'error'>;
}

interface StartingMachine {
	readonly machine: BaseMachine;
	readonly promise: Promise<boolean>;
}

const ACTIVE_ORDER_STATUSES = ['testing', 'pending'] as const;
const DEFAULT_ORDER_EXPIRY_MS = 24 * 60 * 60 * 1_000; // 24 hours
const EXPIRED_ORDER_REASON =
	'Order expired before it was sent to the analyzer.';

/**
 * The registry is the single boundary between HTTP/application code, SQLite,
 * and live machine instances. Routes/machineManager never receive raw database or driver objects.
 */
export class MachineRegistry {
	private readonly registrations = new Map<
		MachineDriverId,
		RegisteredMachine
	>();
	private readonly running = new Map<MachineId, RunningMachine>();
	private readonly starting = new Map<MachineId, StartingMachine>(); // this is to prevent two simultaneous start requests or prevent race conditions
	private readonly eventBindings = new Map<MachineId, MachineEventBindings>();
	private readonly log: Logger = createLogger('Machine-Registry');
	private dbPath: string;
	private db?: SqliteMachineDatabase;
	/** Post-persist hook forwarded from MachineManagerOptions. */
	private onResultPersisted?: MachineRegistryOptions['onResultPersisted'];

	constructor(options: MachineRegistryOptions = {}) {
		this.dbPath = options.dbPath ?? './data/machines.db';
	}

	// configure db (for now)
	configure(options: MachineRegistryOptions): void {
		const dbPath = options.dbPath ?? this.dbPath;
		if (this.db?.connected && dbPath !== this.dbPath) {
			throw new Error(
				'Cannot change registry database while it is connected.',
			);
		}
		this.dbPath = dbPath;
		// Only update the hook if explicitly provided (allows partial re-configure).
		if (options.onResultPersisted !== undefined) {
			this.onResultPersisted = options.onResultPersisted;
		}
	}

	// register new driver/machine locally in map
	register(
		registration: RegisteredMachine,
	): void {
		if (this.registrations.has(registration.id)) {
			throw new Error(
				`Machine driver "${registration.id}" is already registered.`,
			);
		}
		this.registrations.set(registration.id, registration);
	}

	// locally remove/unregister the machine from map
	unregister(driverId: MachineDriverId): void {
		for (const { profile } of this.running.values()) {
			if (profile.driverId === driverId) {
				throw new Error(
					`Cannot unregister running machine driver "${driverId}".`,
				);
			}
		}

		for (const { machine } of this.starting.values()) {
			if (machine.id === driverId) {
				throw new Error(
					`Cannot unregister starting machine driver "${driverId}".`,
				);
			}
		}

		this.registrations.delete(driverId);
	}

	// Describe registered driver classes, whether currently running or not.
	listDrivers(): MachineDriverView[] {
		return Array.from(this.registrations.values(), (driver) => ({
			id: driver.id,
			brand: driver.brand,
			models: driver.models ?? [],
			protocol: driver.protocol,
			defaultOrderTests: driver.defaultOrderTests ?? [],
			configFields: driver.configFields ?? [],
			transportType: driver.transportType ?? 'custom',
		}));
	}

	// local running machines list
	listRunning(): RunningMachineView[] {
		return Array.from(this.running.values(), ({ profile, machine }) => ({
			profile,
			machine: {
				id: machine.id,
				brand: machine.brand,
				model: machine.model,
				connected: machine.isConnected,
				running: machine.isRunning,
			},
		}));
	}

	// connect DB (singleton pattern)
	connectDatabase(): Promise<void> {
		if (!this.db) {
			this.db = new SqliteMachineDatabase({ path: this.dbPath });
		}
		this.db.connect();
		return Promise.resolve();
	}

	// restart stored profile
	async startStoredProfile(machineId: MachineId): Promise<boolean> {
		const profile = this.requireProfile(machineId);

		// cleans stale stopped/disconnected running machine entries before restart.
		const running = this.running.get(machineId);
		if (running?.machine.isRunning) return false;
		if (running) {
			try {
				await running.machine.shutdown(); // stale machine before unbind/delete.
			} finally {
				this.unbindMachineEvents(machineId, running.machine); // clean events
				this.running.delete(machineId); // remove machine from running
			}
		}

		if (!profile.enabled) {
			this.database.profiles.setEnabled(machineId, true);
		}
		const enabledProfile = this.requireProfile(machineId);
		try {
			return await this.startProfile(enabledProfile);
		} catch (error) {
			this.database.profiles.setEnabled(machineId, false);
			throw error;
		}
	}

	// stop profile
	async stopStoredProfile(machineId: MachineId): Promise<boolean> {
		this.requireProfile(machineId);
		const stopped = await this.stopProfile(machineId);
		this.database.profiles.setEnabled(machineId, false);
		return stopped;
	}

	// Start each enabled profile independently. A failed machine must not stop
	// or roll back other machines that are already running.
	async startProfiles(profiles: readonly MachineProfile[]): Promise<void> {
		for (const profile of profiles) {
			try {
				await this.startProfile(profile);
			} catch (error) {
				this.log.error(
					`machine startup failed id=${profile.id} driver=${profile.driverId}`,
					error,
				);
			}
		}
	}

	/**
	 * 1. start profile
	 * 2. construct the registered driver and configure it from the stored profile.
	 * 3. bind machine events for this machine (local events + database operations).
	 * 4. connect and synchronize this machine, then start its protocol.
	 * 5. register this machine in the running-machine map.
	 * 6. On failure, shut down partial resources and remove event handlers.
	 * @param profile
	 * @returns
	 */
	async startProfile(profile: MachineProfile): Promise<boolean> {
		if (!profile.enabled || this.running.has(profile.id)) return false;

		const existing = this.starting.get(profile.id);
		if (existing) return await existing.promise;

		const machine = this.createMachine(profile);
		const operation = this.startMachine(profile, machine);
		const starting = { machine, promise: operation };
		this.starting.set(profile.id, starting);

		try {
			return await operation;
		} finally {
			if (this.starting.get(profile.id) === starting) {
				this.starting.delete(profile.id);
			}
		}
	}

	// Stop one running/starting driver without affecting the shared database & unbind events for this machine.
	async stopProfile(machineId: MachineId): Promise<boolean> {
		const running = this.running.get(machineId);
		if (running) {
			try {
				await running.machine.shutdown();
			} finally {
				this.unbindMachineEvents(machineId, running.machine);
				this.running.delete(machineId);
			}
			return true;
		}

		const starting = this.starting.get(machineId);
		if (!starting) return false;
		try {
			await starting.machine.shutdown();
			await starting.promise.catch(() => undefined);
			return true;
		} finally {
			this.unbindMachineEvents(machineId, starting.machine);
		}
	}

	// profile management
	// // list stored profiles
	// listProfiles(): Promise<MachineProfile[]> {
	// 	return Promise.resolve(this.database.profiles.list());
	// }

	// query profiles
	queryProfiles(query?: TProfileQuery): Promise<MachineProfile[]> {
		return Promise.resolve(this.database.profiles.query(query));
	}

	// show list of all enabled profiles from DB
	listEnabledProfiles(): Promise<MachineProfile[]> {
		return this.queryProfiles({ enabled: true });
	}

	// Load & provide one stored machine profile.
	getProfile(machineId: MachineId): Promise<MachineProfile | undefined> {
		return Promise.resolve(this.database.profiles.get(machineId));
	}

	// Load & provide counts of profiles.
	countProfiles(): Promise<number | undefined> {
		return Promise.resolve(this.database.profiles.count());
	}

	// Store a new profile in db and start it only when enabled.
	async createProfile(input: MachineProfileInput): Promise<MachineProfile> {
		this.getRegistration(input.driverId);
		const profile: MachineProfileInput = {
			...input,
			enabled: input.enabled ?? false,
			createdAt: input.createdAt ?? new Date(),
		};
		const id = this.database.profiles.insert(profile);
		const stored = requiredValue(
			this.database.profiles.get(id),
			`Created machine profile ${id} could not be reloaded.`,
		);

		if (stored.enabled) {
			try {
				await this.startProfile(stored);
			} catch (error) {
				this.database.profiles.delete(id);
				throw error;
			}
		}
		return stored;
	}

	// update profile
	async updateProfile(
		machineId: MachineId,
		update: MachineProfileUpdate,
	): Promise<MachineProfile> {
		// get profile from db
		const current = this.requireProfile(machineId);

		// Get live or starting machine, A live or starting driver must be stopped before its driver type or config changes.
		const running = this.running.get(machineId);
		const starting = this.starting.get(machineId);
		const activeMachine = running ?? starting;

		const changesDriver = update.driverId !== undefined &&
			update.driverId !== current.driverId;

		const changesConfig = update.config !== undefined &&
			JSON.stringify(update.config) !== JSON.stringify(current.config);

		if (activeMachine && (changesDriver || changesConfig)) {
			throw new Error(
				`Stop machine profile ${machineId} before changing its driver or config.`,
			);
		}

		// prepare update payload
		const driverId = update.driverId ?? current.driverId;
		this.getRegistration(driverId);
		const normalizedUpdate: MachineProfileUpdate = {
			...update,
			driverId,
			config: update.config ?? current.config,
			updatedAt: update.updatedAt ?? new Date(),
		};
		const shouldRun = update.enabled ?? current.enabled;

		if (activeMachine && !shouldRun) await this.stopProfile(machineId);
		this.database.profiles.update(machineId, normalizedUpdate);
		let stored = this.requireProfile(machineId);

		if (shouldRun) {
			try {
				await this.startProfile(stored);
			} catch (error) {
				this.database.profiles.setEnabled(machineId, false);
				throw error;
			}

			// set running data after start profile
			const runningAfterStart = this.running.get(machineId);
			if (runningAfterStart) {
				this.running.set(machineId, {
					profile: stored,
					machine: runningAfterStart.machine,
				});
			}
		}

		stored = this.requireProfile(machineId);
		return stored;
	}

	// delete profile
	async deleteProfile(machineId: MachineId): Promise<boolean> {
		if (!this.database.profiles.get(machineId)) return false;

		// before deleting profile checking that any order,result,testStatistics exist? if yes fix these then remove
		const hasOrders =
			this.database.orders.query({ machineId, limit: 1 }).length >
			0;
		const hasResults =
			this.database.results.query({ machineId, limit: 1 }).length > 0;
		const hasStatistics =
			this.database.testStatistics.query({ machineId, limit: 1 }).length >
			0;
		if (hasOrders || hasResults || hasStatistics) {
			throw new Error(
				`Cannot delete machine profile ${machineId}: orders, results, or test statistics still reference it.`,
			);
		}

		await this.stopProfile(machineId);
		return this.database.profiles.delete(machineId);
	}

	// order management
	// Load & provide counts of profiles.
	countOrders(): Promise<number | undefined> {
		return Promise.resolve(this.database.orders.count());
	}

	// query orders
	queryOrders(query?: TOrderQuery): Promise<MachineOrder[]> {
		return Promise.resolve(this.database.orders.query(query));
	}

	// get order
	getOrder(orderId: number): Promise<MachineOrder | undefined> {
		return Promise.resolve(this.database.orders.get(orderId));
	}

	/**
	 * 1. get running machine & Store a new pending order and stage it in the running driver
	 * 2. check sendOrder register on that machine/driver? if no (throw error)
	 * 3. insert order with pending status to db
	 * 4. keep this order in pendingOrders list (machine will query for order)
	 * 5. else update order in db to "failed"
	 *
	 * @param order
	 * @returns
	 */
	async submitOrder(order: MachineOrder): Promise<number> {
		const running = this.requireOrderMachine(order.machineId);
		const tests = order.tests?.length > 0
			? order.tests
			: this.getRegistration(running.profile.driverId).defaultOrderTests;
		if (!tests?.length) {
			throw new Error(
				`Machine driver "${running.profile.driverId}" requires at least one test code.`,
			);
		}

		const pendingOrder = this.withLearnedEstimate({
			...order,
			tests: [...tests],
			status: 'pending',
		});

		this.assertOrderNotExpired(pendingOrder); // to allow non-expired order only
		this.assertNoActiveOrderConflict(
			pendingOrder.machineId,
			pendingOrder.sampleId,
		); // keep a unique order to prevent one staged order from replacing another.

		const orderId = this.database.orders.insert(pendingOrder);
		const storedOrder: MachineOrder = { ...pendingOrder, id: orderId };

		// console.log(orderId, storedOrder, pendingOrder, "order dtails")

		try {
			await requiredValue(
				running.machine.sendOrder,
				`Machine driver "${running.profile.driverId}" does not support orders.`,
			).call(running.machine, storedOrder); // pass this machine + order payload as a argument of sendOrder params
			return orderId;
		} catch (error) {
			this.database.orders.update(orderId, {
				status: 'failed',
				errorReason: errorMessage(error),
			});
			throw error;
		}
	}

	/**
	 * get order from db
	 * checks order is not completed, or machine ids not matched
	 * prepare payload
	 * get running machine, if that support sendOrder and order is pending or testing then send order
	 * update order in db
	 * @param orderId
	 * @param update
	 * @returns
	 */
	async updateOrder(
		orderId: number,
		update: MachineOrderUpdate,
	): Promise<MachineOrder> {
		const current = this.requireOrder(orderId);
		if (
			update.machineId !== undefined &&
			update.machineId !== current.machineId
		) {
			throw new Error(
				'An existing order cannot be moved to another machine.',
			);
		}
		if (current.status === 'completed') {
			throw new Error(`Completed order ${orderId} cannot be changed.`);
		}

		const merged: MachineOrder = {
			...current,
			...update,
			id: orderId,
			estimatedDurationMinutes: update.estimatedDurationMinutes === null
				? undefined
				: update.estimatedDurationMinutes ??
				current.estimatedDurationMinutes,
			estimatedCompletionAt: update.estimatedCompletionAt === null
				? undefined
				: update.estimatedCompletionAt ?? current.estimatedCompletionAt,
		};

		if (isActiveOrder(merged)) {
			this.assertOrderNotExpired(merged);
			this.assertNoActiveOrderConflict(
				merged.machineId,
				merged.sampleId,
				orderId,
			);
		}

		const running = this.running.get(current.machineId);
		if (
			running?.machine.sendOrder &&
			(current.status === 'pending' || current.status === 'testing')
		) {
			await running.machine.sendOrder(merged);
		}
		this.database.orders.update(orderId, update);
		return this.requireOrder(orderId);
	}

	/**
	 * place the same order again after a failed attempt or when a pending order need to be reloaded
	 * manually. this is not inserting a replacement row.
	 *
	 * Expired order receive a 24-hrs deadline, and previous processing & failure fields will be
	 * cleared, and learned estimate will be recalculated before the driver receive the order.
	 * @param orderId
	 * @returns
	 */
	async resendOrder(orderId: number): Promise<MachineOrder> {
		const current = this.requireOrder(orderId);
		const status = current.status ?? 'pending';
		if (status !== 'failed' && status !== 'pending') {
			throw new Error(
				`Only failed or pending orders can be resent, order ${orderId} is ${status}.`,
			);
		}
		const running = this.requireOrderMachine(current.machineId);
		this.assertNoActiveOrderConflict(
			current.machineId,
			current.sampleId,
			orderId,
		);

		const now = new Date();
		const expiresAt = isExpiredOrder(current, now)
			? new Date(now.getTime() + DEFAULT_ORDER_EXPIRY_MS)
			: current.expiresAt;
		const prepared = this.withLearnedEstimate(current);

		this.database.orders.prepareForResend(
			orderId,
			expiresAt,
			prepared.estimatedDurationMinutes,
		);
		const storedOrder = this.requireOrder(orderId);

		try {
			await requiredValue(
				running.machine.sendOrder,
				`Machine driver "${running.profile.driverId}" does not support orders.`,
			).call(running.machine, storedOrder);
		} catch (error) {
			this.database.orders.update(orderId, {
				status: 'failed',
				errorReason: errorMessage(error),
			});
			throw error;
		}

		return storedOrder;
	}

	// delete order
	async deleteOrder(orderId: number): Promise<boolean> {
		const order = this.database.orders.get(orderId);
		if (!order) return false;

		if (
			order.status === 'completed' ||
			this.database.results.query({ orderId, limit: 1 }).length > 0
		) {
			throw new Error(
				`Cannot delete order ${orderId}: completed result history is immutable.`,
			);
		}

		const running = this.running.get(order.machineId);
		if (
			running &&
			(order.status === 'pending' || order.status === 'testing')
		) {
			const removeOrder = requiredValue(
				running.machine.removeOrder,
				`Machine driver "${running.profile.driverId}" cannot remove staged orders.`,
			);
			await removeOrder.call(running.machine, order.sampleId);
		}
		return this.database.orders.delete(orderId);
	}

	// Result and statistics management.
	listResults(query?: TResultQuery): Promise<StoredMachineResult[]> {
		return Promise.resolve(this.database.results.query(query));
	}

	// Load & provide counts of profiles.
	countResults(): Promise<number | undefined> {
		return Promise.resolve(this.database.results.count());
	}

	getResult(resultId: number): Promise<StoredMachineResult | undefined> {
		return Promise.resolve(this.database.results.get(resultId));
	}

	listTestStatistics(
		query?: TTestStatisticQuery,
	): Promise<MachineTestStatistic[]> {
		return Promise.resolve(this.database.testStatistics.query(query));
	}

	// Load & provide counts of profiles.
	countTestStatistics(): Promise<number | undefined> {
		return Promise.resolve(this.database.testStatistics.count());
	}

	getTestStatistic(
		statisticId: number,
	): Promise<MachineTestStatistic | undefined> {
		return Promise.resolve(this.database.testStatistics.get(statisticId));
	}

	deleteTestStatistic(statisticId: number): Promise<boolean> {
		return Promise.resolve(
			this.database.testStatistics.delete(statisticId),
		);
	}

	// stop every running machine/driver & close shared db
	async shutdown(): Promise<void> {
		const errors: unknown[] = [];
		const machineIds = new Set([
			...this.running.keys(),
			...this.starting.keys(),
		]);
		for (const machineId of machineIds) {
			try {
				await this.stopProfile(machineId);
			} catch (error) {
				errors.push(error);
			}
		}

		this.db?.close();
		this.db = undefined;

		if (errors.length > 0) {
			throw new AggregateError(
				errors,
				'One or more machines failed to shut down.',
			);
		}
	}

	private get database(): SqliteMachineDatabase {
		if (!this.db?.connected) {
			throw new Error('Machine registry database is not connected.');
		}
		return this.db;
	}

	private getRegistration(driverId: MachineDriverId): RegisteredMachine {
		const registration = this.registrations.get(driverId);
		if (!registration) {
			throw new Error(`Machine driver "${driverId}" is not registered.`);
		}
		return registration;
	}

	private requireProfile(machineId: MachineId): MachineProfile {
		return requiredValue(
			this.database.profiles.get(machineId),
			`Machine profile ${machineId} was not found.`,
		);
	}

	private requireOrder(orderId: number): MachineOrder {
		return requiredValue(
			this.database.orders.get(orderId),
			`Machine order ${orderId} was not found.`,
		);
	}

	private requireOrderMachine(machineId: MachineId): RunningMachine {
		const running = this.running.get(machineId);
		if (!running) {
			throw new Error(`Machine profile ${machineId} is not running.`);
		}
		if (!running.machine.sendOrder) {
			throw new Error(
				`Machine driver "${running.profile.driverId}" does not support orders.`,
			);
		}
		return running;
	}

	private createMachine(profile: MachineProfile): BaseMachine {
		const Driver = this.getRegistration(profile.driverId);
		const machine = new Driver();

		if (machine.id !== Driver.id) {
			throw new Error(
				`Machine driver "${profile.driverId}" created "${machine.id}"; expected "${Driver.id}".`,
			);
		}
		return machine;
	}

	private async startMachine(
		profile: MachineProfile,
		machine: BaseMachine,
	): Promise<boolean> {
		try {
			machine.configure(profile.config);
			this.bindMachineEvents(profile.id, machine);
			await machine.connect();
			await this.synchronizeOrders(profile.id, machine);
			await machine.start();
			if (!machine.isRunning) {
				throw new Error(
					`Machine profile ${profile.id} stopped during startup.`,
				);
			}

			this.running.set(profile.id, { profile, machine });
			return true;
		} catch (error) {
			await machine.shutdown().catch((shutdownError) => {
				this.log.error(
					`machine cleanup failed id=${profile.id}`,
					shutdownError,
				);
			});
			this.unbindMachineEvents(profile.id, machine);
			throw error;
		}
	}

	private bindMachineEvents(
		machineId: MachineId,
		machine: BaseMachine,
	): void {
		const bindings: MachineEventBindings = {
			connected: ({ source }) => {
				this.log.info(
					`machine connected id=${machineId} source=${source ?? machine.id
					}`,
				);
			},
			disconnected: ({ source }) => {
				this.log.info(
					`machine disconnected id=${machineId} source=${source ?? machine.id
					}`,
				);

				// removes disconnected machines from running, so one dead analyzer doesn’t affect others.
				const running = this.running.get(machineId);
				if (running?.machine === machine) {
					this.running.delete(machineId);
					this.unbindMachineEvents(machineId, machine);
				}
			},
			orderQuery: async ({ sampleId, raw }) => {
				// A query alone does not mean an order reached the analyzer. The
				// driver emits order-sent after its protocol response succeeds.
				this.log.info(
					`machine order query id=${machineId} sample="${sampleId ?? ''
					}"`,
				);

				// get pending orders
				// remove order from machine
				// update order with failed in db
				await this.failExpiredPendingOrders(
					machineId,
					machine,
					sampleId,
				);
			},

			orderSent: ({ order }) => {
				if (order.id === undefined) {
					throw new Error(
						`Cannot mark order testing: missing order id for sample=${order.sampleId}`,
					);
				}
				this.database.orders.update(order.id, {
					status: 'testing',
					sentAt: order.sentAt,
					startedAt: order.startedAt,
					estimatedDurationMinutes: order.estimatedDurationMinutes ??
						null,
					estimatedCompletionAt: order.estimatedCompletionAt ?? null,
				});
			},
			result: (result) => this.persistResult(machineId, result),
			error: (error) => {
				this.log.error(`machine error id=${machineId}`, error);
			},
		};

		machine.on('connected', bindings.connected);
		machine.on('disconnected', bindings.disconnected);
		machine.on('order-query', bindings.orderQuery);
		machine.on('order-sent', bindings.orderSent);
		machine.on('result', bindings.result);
		machine.on('error', bindings.error);
		this.eventBindings.set(machineId, bindings);
	}

	private unbindMachineEvents(
		machineId: MachineId,
		machine: BaseMachine,
	): void {
		const bindings = this.eventBindings.get(machineId);
		if (!bindings) return;

		machine.off('connected', bindings.connected);
		machine.off('disconnected', bindings.disconnected);
		machine.off('order-query', bindings.orderQuery);
		machine.off('order-sent', bindings.orderSent);
		machine.off('result', bindings.result);
		machine.off('error', bindings.error);
		this.eventBindings.delete(machineId);
	}

	private persistResult(
		machineId: MachineId,
		result: Parameters<MachineEventHandler<'result'>>[0],
	): Promise<void> {
		const order = this.findResultOrder(machineId, result.sampleId);
		if (order?.id === undefined) {
			// prevent duplicate result save for same order
			const [existingResult] = this.database.results.query({
				machineId,
				sampleId: result.sampleId,
				limit: 1,
			});
			if (existingResult) return Promise.resolve();

			throw new Error(
				`Cannot store result: no order found for machine=${machineId} sample=${result.sampleId}`,
			);
		}

		const orderId = order.id;
		const [existingResult] = this.database.results.query({
			orderId,
			limit: 1,
		});
		// prevent duplicate result save for same order
		if (existingResult) {
			this.database.orders.markCompleted(orderId, result.receivedAt);
			return Promise.resolve();
		}

		const storedResult: MachineResult = {
			...result,
			orderId,
			machineId,
		};

		// Capture the auto-incremented SQLite row id from inside the transaction.
		let insertedId!: number;
		this.database.transaction(() => {
			insertedId = this.database.results.insert(storedResult);
			this.database.orders.markCompleted(orderId, result.receivedAt);
			this.database.testStatistics.recordCompletedOrder(
				order,
				result.receivedAt,
			);
		});

		// Fire hook after the transaction commits - fire-and-forget so errors
		// in the hook never surface back into the driver pipeline.
		if (this.onResultPersisted) {
			const hook = this.onResultPersisted;
			const persisted: StoredMachineResult = {
				...storedResult,
				id: insertedId,
			};
			void Promise.resolve(
				hook({ ...persisted, machineId }),
			).catch((err) =>
				this.log.error('onResultPersisted hook error:', err)
			);
		}

		return Promise.resolve();
	}

	private async synchronizeOrders(
		machineId: MachineId,
		machine: BaseMachine,
	): Promise<void> {
		if (!machine.sendOrder) return;

		const pendingOrders = this.database.orders.listPending(machineId);

		for (const order of pendingOrders) {
			if (isExpiredOrder(order)) {
				if (order.id !== undefined) {
					this.database.orders.update(order.id, {
						status: 'failed',
						errorReason: EXPIRED_ORDER_REASON,
					});
				}
				continue;
			}

			const preparedOrder = this.withLearnedEstimate(order);
			if (preparedOrder.id !== undefined) {
				this.database.orders.update(preparedOrder.id, {
					estimatedDurationMinutes:
						preparedOrder.estimatedDurationMinutes ??
						null,
					estimatedCompletionAt: null,
				});
			}
			await machine.sendOrder(preparedOrder);
		}

		const testingOrders = this.database.orders.query({
			machineId,
			status: 'testing',
		});
		for (const order of testingOrders) {
			await machine.sendOrder(order);
		}
	}

	private async failExpiredPendingOrders(
		machineId: MachineId,
		machine: BaseMachine,
		sampleId?: string,
	): Promise<void> {
		const orders = sampleId
			? [this.database.orders.findPending(machineId, sampleId)].filter(
				(order): order is MachineOrder => order !== undefined,
			)
			: this.database.orders.listPending(machineId);

		for (const order of orders) {
			if (!isExpiredOrder(order)) continue;

			await machine.removeOrder?.(order.sampleId);
			if (order.id !== undefined) {
				this.database.orders.update(order.id, {
					status: 'failed',
					errorReason: EXPIRED_ORDER_REASON,
				});
			}
		}
	}

	private withLearnedEstimate(order: MachineOrder): MachineOrder {
		const preparedOrder = { ...order };
		delete preparedOrder.estimatedDurationMinutes;
		delete preparedOrder.estimatedCompletionAt;

		const durationMs = this.database.testStatistics.estimateOrderDurationMs(
			order.machineId,
			order.tests,
		);
		if (durationMs !== undefined) {
			preparedOrder.estimatedDurationMinutes = durationMs / 60_000;
		}

		return preparedOrder;
	}

	private findResultOrder(
		machineId: MachineId,
		sampleId: string,
	): MachineOrder | undefined {
		for (const status of ACTIVE_ORDER_STATUSES) {
			const [order] = this.database.orders.query({
				machineId,
				sampleId,
				status,
				limit: 1,
			});
			if (order && (status !== 'pending' || !isExpiredOrder(order))) {
				return order;
			}
		}

		return undefined;
	}

	/**
	 * The analyzer addresses an order by machine profile and sample ID. Keeping
	 * this identity unique prevents one staged order from replacing another.
	 */
	private assertNoActiveOrderConflict(
		machineId: MachineId,
		sampleId: string,
		excludedOrderId?: number,
	): void {
		for (const status of ACTIVE_ORDER_STATUSES) {
			const conflict = this.database.orders.query({
				machineId,
				sampleId,
				status,
			}).find((order) => order.id !== excludedOrderId);
			if (conflict) {
				throw new Error(
					`Machine profile ${machineId} already has an active order for sample "${sampleId}".`,
				);
			}
		}
	}

	private assertOrderNotExpired(order: MachineOrder): void {
		if (isExpiredOrder(order)) {
			throw new Error(
				`Order for sample "${order.sampleId}" has already expired.`,
			);
		}
	}
}

function isActiveOrder(order: MachineOrder): boolean {
	return order.status === 'pending' || order.status === 'testing';
}

function isExpiredOrder(order: MachineOrder, now = new Date()): boolean {
	return order.expiresAt.getTime() <= now.getTime();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const machineRegistry = new MachineRegistry();
