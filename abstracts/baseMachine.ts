import { MachineCom } from '../transports/machineCom.ts';
import type {
	MachineEventHandler,
	MachineEventName,
	MachineEventPayloads,
	MachineOrder,
} from '../types.ts';

export abstract class BaseMachine {
	protected com?: MachineCom;
	protected connected = false;
	protected running = false;
	private readonly handlers = new Map<
		MachineEventName,
		Set<MachineEventHandler>
	>();

	/**
	 * Validate and apply this driver's configuration.
	 *
	 * Configuration is intentionally unknown here because every analyzer owns
	 * a different schema. The registry calls this before connect().
	 */
	abstract configure(config: unknown): void;

	/** Initialize transport and protocol resources. */
	abstract connect(): Promise<void>;

	/**
	 * Start machine operation.
	 *
	 * Example:
	 * - start ASTM reader loop
	 * - start HL7 listener
	 * - begin polling
	 * - etc...
	 */
	abstract start(): Promise<void>;

	/**
	 * Destroy everything.
	 *
	 * Example:
	 * - close socket
	 * - release serial port
	 * - cleanup timers
	 */
	abstract shutdown(): Promise<void>;

	/** Present only on drivers that support order transmission. */
	sendOrder?(order: MachineOrder): Promise<void>;

	/** Present on order-capable drivers that can remove a staged order. */
	removeOrder?(sampleId: string): Promise<void>;

	/**
	 * Register an event handler for machine events.
	 *
	 * Multiple handlers can be registered for the same event.
	 */
	on<TEvent extends MachineEventName>(
		event: TEvent,
		callback: MachineEventHandler<TEvent>,
	): void {
		const handlers = this.handlers.get(event) ??
			new Set<MachineEventHandler>();
		handlers.add(callback as MachineEventHandler);
		this.handlers.set(event, handlers);
	}

	/**
	 * Remove a previously registered event handler.
	 */
	off<TEvent extends MachineEventName>(
		event: TEvent,
		callback: MachineEventHandler<TEvent>,
	): void {
		this.handlers.get(event)?.delete(callback as MachineEventHandler);
	}

	/**
	 * Helpers for child drivers.
	 */
	protected markConnected() {
		this.connected = true;
		this.publish('connected', { source: this.id });
	}

	/**
	 * Mark the machine as disconnected and notify subscribers.
	 */
	protected markDisconnected() {
		this.connected = false;
		this.running = false;
		this.publish('disconnected', { source: this.id });
	}

	/**
	 * Mark the machine as running.
	 */
	protected markStarted() {
		this.running = true;
	}

	/**
	 * Mark the machine as stopped.
	 */
	protected markStopped() {
		this.running = false;
	}

	/**
	 * Indicates whether the machine is currently connected.
	 */
	get isConnected(): boolean {
		return this.connected;
	}

	/**
	 * Indicates whether the machine is currently running.
	 */
	get isRunning(): boolean {
		return this.running;
	}

	/**
	 * Emit an event to all registered handlers.
	 *
	 * All handlers are executed concurrently and awaited before
	 * this method resolves.
	 */
	protected async emit<TEvent extends MachineEventName>(
		event: TEvent,
		payload: MachineEventPayloads[TEvent],
	): Promise<void> {
		const handlers = Array.from(this.handlers.get(event) ?? []);
		await Promise.all(
			handlers.map((callback) =>
				callback(payload as MachineEventPayloads[MachineEventName])
			),
		);
	}

	/**
	 * Publish an event and automatically report any handler errors
	 * through the "error" event.
	 */
	private publish<TEvent extends MachineEventName>(
		event: TEvent,
		payload: MachineEventPayloads[TEvent],
	): void {
		void this.emit(event, payload).catch((error) => {
			const normalized = error instanceof Error
				? error
				: new Error(String(error));
			if (event !== 'error') {
				void this.emit('error', normalized);
			}
		});
	}

	/**
	 * Machine metadata.
	 */
	abstract readonly id: string;
	abstract readonly brand: string;
	abstract readonly model: string;
}
