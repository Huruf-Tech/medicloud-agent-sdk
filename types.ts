import type { BaseMachine } from './abstracts/baseMachine.ts';
import {
	TOrderQuery,
	TProfileQuery,
	TResultQuery,
	TTestStatisticQuery,
} from './schema.ts';

// machine communication
export interface RawConnection {
	readonly localAddr: Deno.Addr;
	readonly remoteAddr: Deno.Addr;
	read(p: Uint8Array): Promise<number | null>;
	write(p: Uint8Array): Promise<number>;
	close(): void;
}

export type SerialParity = 'n' | 'o' | 'e';
export type SerialFlowControl = 'none' | 'xonxoff' | 'rtscts';
export type DataBits = 5 | 6 | 7 | 8 | 9;
export type StopBits = 1 | 1.5 | 2;

export type TransportSpec =
	| { kind: 'tcp-server'; host: string; port: number }
	| { kind: 'tcp-client'; host: string; port: number }
	| {
		kind: 'serial';
		portName: string;
		baud: number;
		dataBits: DataBits;
		stopBits: StopBits;
		parity: SerialParity;
		flowControl?: SerialFlowControl;
		reconnectDelayMs: number;
	};

export type TransportKind = TransportSpec['kind'];
export type SerialTransportSpec = Extract<TransportSpec, { kind: 'serial' }>;
export type SerialPortTransportOptions = Omit<SerialTransportSpec, 'kind'>;
export type DriverTransportType = 'tcp' | 'serial' | 'custom';

/** Static protocol identity exposed by a registered machine driver. */
export interface DriverProtocolInfo {
	readonly name: string;
	readonly version: string;
}

// driver config field descriptor
export type DriverConfigFieldType =
	| 'string'
	| 'number'
	| 'boolean'
	| 'select';

export interface DriverConfigField {
	/** The key that will appear in the config object sent to the backend. */
	key: string;
	/** readable label shown in the form. */
	label: string;
	type: DriverConfigFieldType;
	/** Whether the field must be provided. */
	required?: boolean;
	/** Default value pre-filled in the form. */
	default?: string | number | boolean;
	/** Allowed values for type === 'select'. */
	options?: ReadonlyArray<{ value: string; label: string }>;
	/** Short hint shown after the input. */
	hint?: string;
}

// store related
// shared
export type DbValue = string | number | bigint | Uint8Array | null;
// 1. profile store
export interface IMachineProfileStore {
	insert(
		profile: MachineProfileInput,
	): MachineId;

	update(
		machineId: MachineId,
		profile: MachineProfileUpdate,
	): void;

	// list(): MachineProfile[];

	get(
		machineId: MachineId,
	): MachineProfile | undefined;

	query(
		query?: TProfileQuery,
	): MachineProfile[];

	count(): number;

	setEnabled(
		machineId: MachineId,
		enabled: boolean,
	): void;

	delete(
		machineId: MachineId,
	): boolean;
}

// 2. order store
export type MachineOrderStatus = 'pending' | 'testing' | 'completed' | 'failed';
export interface MachineOrder {
	id?: number;
	machineId: MachineId;
	sampleId: string;
	patientId?: string;
	patientName?: string;
	dob?: string;
	sex?: string;
	/** Species/type label for analyzers whose protocol contains this field. */
	species?: string;
	sampleType?: string;
	rackPosition?: string;
	tests: string[];
	raw?: unknown;
	status?: MachineOrderStatus;
	createdAt: Date;
	updatedAt?: Date;
	expiresAt: Date;
	sentAt?: Date;
	startedAt?: Date;
	estimatedDurationMinutes?: number;
	estimatedCompletionAt?: Date;
	completedAt?: Date;
	errorReason?: string;
}

export type MachineOrderUpdate =
	& Omit<
		Partial<MachineOrder>,
		'id' | 'estimatedDurationMinutes' | 'estimatedCompletionAt'
	>
	& {
		estimatedDurationMinutes?: number | null;
		estimatedCompletionAt?: Date | null;
	};
export interface IMachineOrderStore {
	insert(
		order: MachineOrder,
	): number;

	update(
		id: number,
		order: MachineOrderUpdate,
	): void;

	/**
	 * Reuse an existing failed/pending order by resetting its processing state.
	 * The order identity, sample details, and tests remain unchanged.
	 */
	prepareForResend(
		id: number,
		expiresAt: Date,
		estimatedDurationMinutes?: number,
	): void;

	get(
		id: number,
	): MachineOrder | undefined;

	findPending(
		machineId: MachineId,
		sampleId?: string,
	): MachineOrder | undefined;

	listPending(
		machineId: MachineId,
	): MachineOrder[];

	query(
		query?: TOrderQuery,
	): MachineOrder[];

	count(): number;

	markCompleted(
		orderId: number,
		completedAt?: Date,
	): void;

	delete(
		id: number,
	): boolean;

	// deleteBySample(
	// 	sampleId: string,
	// 	machineId?: MachineId,
	// ): number;
}

// 3. result store
/** ASTM result type: intermediate, final, or both. */
export type MachineResultType = 'I' | 'F' | 'B';

/**
 * Protocol-neutral analyte shape produced by the supported machine drivers.
 *
 * A result can be quantitative (`value`), qualitative (`qualitative`), or
 * both. `lowReference` and `highReference` are the only reference-range
 * properties in the SDK contract.
 */
export interface MachineAnalyteResult {
	assayNo: string;
	assayName?: string;
	resultType: MachineResultType;
	value?: string;
	qualitative?: string;
	unit?: string;
	lowReference?: string;
	highReference?: string;
	abnormalFlag?: string;
	status?: string;
	completedAt?: string;
}
/** One order result containing every analyte reported in its message. */
export interface MachineResultPayload {
	results: MachineAnalyteResult[];
}
export interface MachineResult {
	id?: number;
	orderId: number;
	machineId: MachineId;
	sampleId: string;
	patientId?: string;
	payload: MachineResultPayload;
	raw?: string;
	receivedAt: Date;
}
export interface StoredMachineResult extends MachineResult {
	id: number;
}
// driver dont know db order/profile ids
export type MachineResultEvent = Omit<
	MachineResult,
	'id' | 'orderId' | 'machineId'
>;

export interface IMachineResultStore {
	insert(
		result: MachineResult,
	): number;

	get(
		id: number,
	): StoredMachineResult | undefined;

	query(
		query?: TResultQuery,
	): StoredMachineResult[];

	count(): number;
}

// 4. learned test turnaround statistics
export interface MachineTestStatistic {
	id: number;
	machineId: MachineId;
	testId: string;
	lastOrderId?: number;
	lastStartedAt?: Date;
	lastCompletedAt?: Date;
	lastDurationMs: number;
	averageDurationMs: number;
	orderCount: number;
	createdAt: Date;
	updatedAt?: Date;
}

export interface IMachineTestStatisticStore {
	get(id: number): MachineTestStatistic | undefined;
	find(
		machineId: MachineId,
		testId: string,
	): MachineTestStatistic | undefined;
	query(query?: TTestStatisticQuery): MachineTestStatistic[];
	/**
	 * Return an order-level estimate only when every requested test has history.
	 * Multi-test orders use the slowest learned test duration.
	 */
	estimateOrderDurationMs(
		machineId: MachineId,
		testIds: readonly string[],
	): number | undefined;

	/** Update one running-average row for every unique test in the order. */
	recordCompletedOrder(
		order: MachineOrder,
		completedAt: Date,
	): void;

	delete(id: number): boolean;

	count(): number;
}

// 5. machine catalogs
export interface IMachineCatalogStore {
	list(): CatalogView[];
	get(driverId: MachineDriverId): CatalogView | undefined;
	create(driverId: MachineDriverId, machine: string): CatalogView;
	rename(driverId: MachineDriverId, machine: string): CatalogView | undefined;
	upsertTest(
		driverId: MachineDriverId,
		test: CatalogTestEntry,
	): CatalogTestEntry;
	getTest(
		driverId: MachineDriverId,
		code: string,
	): CatalogTestEntry | undefined;
	deleteTest(driverId: MachineDriverId, code: string): boolean;
}

// SQLite DB
export interface IMachineSQLiteDB {
	readonly profiles: IMachineProfileStore;
	readonly orders: IMachineOrderStore;
	readonly results: IMachineResultStore;
	readonly testStatistics: IMachineTestStatisticStore;
	readonly catalogs: IMachineCatalogStore;
	readonly connected: boolean;

	connect(): void;
	close(): void;
	transaction<T>(callback: () => T): T;
}

// BASE MACHINE
// base machine events
export interface MachineEventPayloads {
	connected: { source?: string };
	disconnected: { source?: string };
	'order-query': { sampleId?: string; raw?: unknown };
	'order-sent': { order: MachineOrder; raw?: unknown };
	result: MachineResultEvent;
	error: Error;
}
export type MachineEventName = keyof MachineEventPayloads;
export type MachineEventHandler<
	TEvent extends MachineEventName = MachineEventName,
> = (
	payload: MachineEventPayloads[TEvent],
) => void | Promise<void>;

// // base machine (drivers) options
// export interface MachineOptions {
//   // tcp required details
//   port: number | string;
//   hostname?: string;

//   // serial required details
//   baud?: number;
//   dataBits?: DataBits;
//   stopBits?: StopBits;
//   parity?: SerialParity;
//   flowControl?: SerialFlowControl;

//   reconnectDelayMs?: number;
// }

// Machine Registry
// A profile ID is the numeric primary/foreign key used by SQLite. A driver ID
// is the stable string identifier registered by driver code.
export type MachineId = number;
export type MachineDriverId = string;
export type MachineConfig = Record<string, unknown>;
// export interface MachineConfig extends Record<string, unknown> { }

export interface MachineConfigSchema<
	TConfig extends MachineConfig = MachineConfig,
> {
	parse(config: unknown): TConfig;
}

// db shape will be like this
export interface MachineProfile<TConfig extends MachineConfig = MachineConfig> {
	id: MachineId;
	driverId: MachineDriverId;
	enabled: boolean;
	name?: string;
	config: TConfig;
	createdAt: Date;
	updatedAt?: Date;
}
// used in registry while creating new machine
export interface MachineProfileInput<
	TConfig extends MachineConfig = MachineConfig,
> {
	driverId: MachineDriverId;
	enabled?: boolean;
	name?: string;
	config: TConfig;
	createdAt?: Date;
}
// used in registry while updating profile
export type MachineProfileUpdate =
	& Omit<
		Partial<MachineProfile>,
		'id' | 'createdAt' | 'name'
	>
	& { name?: string | null };

/**
 * Static contract implemented by every registered driver class.
 * The registry stores the class itself, constructs it with no arguments,
 * and passes the selected profile config to the instance configure() method.
 */
export interface RegisteredMachine<
	TConfig extends MachineConfig = MachineConfig,
	TMachine extends BaseMachine = BaseMachine,
> {
	new (): TMachine;
	readonly id: MachineDriverId;
	readonly brand?: string;
	readonly models?: readonly string[];
	readonly configSchema: MachineConfigSchema<TConfig>;

	/**
	 * Canonical tests assigned when this driver accepts an order without an
	 * explicit test selection. Drivers without this metadata still require at
	 * least one test.
	 */
	readonly defaultOrderTests?: readonly string[];
	/** Static protocol family and version shown by registry/API/UI metadata. */
	readonly protocol: DriverProtocolInfo;
	/** UI field definer - drivers set this so the frontend renders the correct form. */
	readonly configFields?: readonly DriverConfigField[];
	/** High-level transport category so the UI knows if it is TCP, Serial, etc. */
	readonly transportType?: DriverTransportType;
}

// running enable/active machines provide this
export interface RunningMachine {
	profile: MachineProfile;
	machine: BaseMachine;
}

// machine manager http options
export interface MachineManagerHttpOptions {
	enabled?: boolean;
	host?: string;
	port?: number;
}

export interface MachineManagerOptions {
	dbPath?: string;
	http?: MachineManagerHttpOptions;
	/**
	 * Optional hook called after each machine result is successfully persisted
	 * to SQLite. Runs fire-and-forget — errors are caught and logged so they
	 * never propagate back into the machine driver pipeline.
	 *
	 * Use this in the agent layer to forward results to MediCloud or a master
	 * without coupling sdk_v3 to any external transport.
	 */
	onResultPersisted?: (
		result: StoredMachineResult & { machineId: MachineId },
	) => void | Promise<void>;
}

/** Framework-neutral HTTP boundary exposed by MachineManager. */
export type MachineManagerHandler = (req: Request) => Promise<Response>;

// machine manager
export interface IMachineManager {
	listen(
		callback?: () => void | Promise<void>,
	): Promise<void>;

	getHandler(): Promise<MachineManagerHandler>;

	shutdown(): Promise<void>;
}

// Http Server
export type ValidationResult<T> = { ok: true; value: T } | {
	ok: false;
	error: string;
};

/**
 * Describes one result/analyte that a machine can return/report back for a test.
 *
 * Example:
 * A CBC test can return WBC, RBC, HGB, PLT, etc.
 *
 * The `code` is used to match this analyte with the `assayNo`
 * returned by the machine driver.
 *
 * Basically, it tells "What individual results can this test produce?"
 */
export interface CatalogAnalyteEntry {
	// Exact assayNo emitted by the result parser (may differ from the order code).
	readonly code: string;

	// Human-readable name of the result.
	readonly name: string;

	// Unit of the result, if applicable, e.g. "g/dL".
	readonly unit?: string;
	readonly category?: string;
	readonly decimals?: number;
}

/**
 * Describes one test available in a machine/driver catalog.
 *
 * It tells us the test's code and name, and which individual
 * results (analytes) the machine can return for that test.
 *
 * Example:
 * "GLU" may have one analyte, while "CBC" may have many.
 *
 * Basically, it tells "What test is available?"
 */
export interface CatalogTestEntry {
	// Code used to identify the test, e.g. "CBC".
	readonly code: string;

	// Human-readable name of the test.
	readonly name: string;

	// Results/analytes that can be returned for this test.
	readonly analytes: readonly CatalogAnalyteEntry[];
	readonly aliases?: readonly string[];
	readonly deviceCode?: string;
	readonly unit?: string;
	readonly normalRange?: string;
	readonly category?: string;
	readonly slot?: number;
	readonly enabled?: boolean;
}

// catalog view
export interface CatalogView {
	readonly id: string;
	readonly driverId: MachineDriverId;
	readonly machine: string;
	readonly tests: readonly CatalogTestEntry[];
	readonly source?: 'database' | 'static';
}

// // Http Server
// type LifecycleMethod = () => void | Promise<void>;
// export interface MachineManagerServer {
//   boot?: LifecycleMethod;
//   start?: LifecycleMethod;
//   listen?: LifecycleMethod;
//   shutdown?: LifecycleMethod;
//   stop?: LifecycleMethod;
//   close?: LifecycleMethod;
// }
