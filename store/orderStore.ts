import { SQLiteStore } from '../abstracts/baseStore.ts';
import { normalizeLimit, normalizeOffset } from '../lib/utils.ts';
import { TOrderQuery } from '../schema.ts';
import type {
	DbValue,
	IMachineOrderStore,
	MachineId,
	MachineOrder,
	MachineOrderUpdate,
} from '../types.ts';
import type { DatabaseSync } from 'node:sqlite';

interface MachineOrderRow {
	id: number;
	machine_id: number;
	sample_id: string;
	tests: string;
	patient_id: string | null;
	patient_name: string | null;
	dob: string | null;
	sex: string | null;
	species: string | null;
	sample_type: string | null;
	rack_position: string | null;
	raw: string | null;
	status: MachineOrder['status'];
	created_at: string;
	updated_at: string | null;
	expires_at: string;
	sent_at: string | null;
	started_at: string | null;
	estimated_duration_minutes: number | null;
	estimated_completion_at: string | null;
	completed_at: string | null;
	error_reason: string | null;
}

export class MachineOrderStore extends SQLiteStore
	implements IMachineOrderStore {
	constructor(db: DatabaseSync) {
		super(db);
	}

	insert(order: MachineOrder): number {
		const result = this.db.prepare(`
      INSERT INTO machine_orders (
        machine_id,
        sample_id,
        tests,
        patient_id,
        patient_name,
        dob,
        sex,
        species,
        sample_type,
        rack_position,
        raw,
        status,
        created_at,
        updated_at,
        expires_at,
        sent_at,
        started_at,
        estimated_duration_minutes,
        estimated_completion_at,
        completed_at,
        error_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
			order.machineId,
			order.sampleId,
			encodeJson(order.tests),
			order.patientId ?? null,
			order.patientName ?? null,
			order.dob ?? null,
			order.sex ?? null,
			order.species ?? null,
			order.sampleType ?? null,
			order.rackPosition ?? null,
			encodeOptionalJson(order.raw),
			order.status ?? 'pending',
			encodeDate(order.createdAt),
			encodeOptionalDate(order.updatedAt),
			encodeDate(order.expiresAt),
			encodeOptionalDate(order.sentAt),
			encodeOptionalDate(order.startedAt),
			order.estimatedDurationMinutes ?? null,
			encodeOptionalDate(order.estimatedCompletionAt),
			encodeOptionalDate(order.completedAt),
			order.errorReason ?? null,
		);

		return Number(result.lastInsertRowid);
	}

	update(
		id: number,
		order: MachineOrderUpdate,
	): void {
		const sets: string[] = [];
		const values: DbValue[] = [];

		if (order.machineId !== undefined) {
			set(sets, values, 'machine_id', order.machineId);
		}
		if (order.sampleId !== undefined) {
			set(sets, values, 'sample_id', order.sampleId);
		}
		if (order.tests !== undefined) {
			set(sets, values, 'tests', encodeJson(order.tests));
		}
		if (order.patientId !== undefined) {
			set(sets, values, 'patient_id', order.patientId ?? null);
		}
		if (order.patientName !== undefined) {
			set(sets, values, 'patient_name', order.patientName ?? null);
		}
		if (order.dob !== undefined) {
			set(sets, values, 'dob', order.dob ?? null);
		}
		if (order.sex !== undefined) {
			set(sets, values, 'sex', order.sex ?? null);
		}
		if (order.species !== undefined) {
			set(sets, values, 'species', order.species ?? null);
		}
		if (order.sampleType !== undefined) {
			set(sets, values, 'sample_type', order.sampleType ?? null);
		}
		if (order.rackPosition !== undefined) {
			set(sets, values, 'rack_position', order.rackPosition ?? null);
		}
		if (order.raw !== undefined) {
			set(sets, values, 'raw', encodeOptionalJson(order.raw));
		}
		if (order.status !== undefined) {
			set(sets, values, 'status', order.status);
		}
		if (order.createdAt !== undefined) {
			set(sets, values, 'created_at', encodeDate(order.createdAt));
		}
		if (order.expiresAt !== undefined) {
			set(sets, values, 'expires_at', encodeDate(order.expiresAt));
		}
		if (order.sentAt !== undefined) {
			set(sets, values, 'sent_at', encodeOptionalDate(order.sentAt));
		}
		if (order.startedAt !== undefined) {
			set(
				sets,
				values,
				'started_at',
				encodeOptionalDate(order.startedAt),
			);
		}
		if (order.estimatedDurationMinutes !== undefined) {
			set(
				sets,
				values,
				'estimated_duration_minutes',
				order.estimatedDurationMinutes ?? null,
			);
		}
		if (order.estimatedCompletionAt !== undefined) {
			set(
				sets,
				values,
				'estimated_completion_at',
				encodeOptionalDate(order.estimatedCompletionAt),
			);
		}
		if (order.completedAt !== undefined) {
			set(
				sets,
				values,
				'completed_at',
				encodeOptionalDate(order.completedAt),
			);
		}
		if (order.errorReason !== undefined) {
			set(sets, values, 'error_reason', order.errorReason ?? null);
		}

		set(
			sets,
			values,
			'updated_at',
			encodeDate(order.updatedAt ?? new Date()),
		);

		values.push(id);
		this.db.prepare(
			`UPDATE machine_orders SET ${sets.join(', ')} WHERE id = ?`,
		)
			.run(...values);
	}

	/**
	 * Reset only analyzer-processing fields so a stored order can be staged
	 * again without changing its primary key or creating duplicate history.
	 */
	prepareForResend(
		id: number,
		expiresAt: Date,
		estimatedDurationMinutes?: number,
	): void {
		this.db.prepare(`
      UPDATE machine_orders
      SET status = 'pending',
          updated_at = ?,
          expires_at = ?,
          sent_at = NULL,
          started_at = NULL,
          estimated_duration_minutes = ?,
          estimated_completion_at = NULL,
          completed_at = NULL,
          error_reason = NULL
      WHERE id = ?
    `).run(
			encodeDate(new Date()),
			encodeDate(expiresAt),
			estimatedDurationMinutes ?? null,
			id,
		);
	}

	get(
		id: number,
	): MachineOrder | undefined {
		const row = this.db.prepare(`${selectOrdersSql()} WHERE id = ?`).get(
			id,
		) as
			| MachineOrderRow
			| undefined;

		return row ? mapOrderRow(row) : undefined;
	}

	findPending(
		machineId: MachineId,
		sampleId?: string,
	): MachineOrder | undefined {
		const params: DbValue[] = [machineId, 'pending'];
		let sql = `${selectOrdersSql()} WHERE machine_id = ? AND status = ?`;
		if (sampleId !== undefined) {
			sql += ' AND sample_id = ?';
			params.push(sampleId);
		}
		sql += ' ORDER BY created_at ASC LIMIT 1';

		const row = this.db.prepare(sql).get(...params) as
			| MachineOrderRow
			| undefined;
		return row ? mapOrderRow(row) : undefined;
	}

	listPending(
		machineId: MachineId,
	): MachineOrder[] {
		const rows = this.db.prepare(`
      ${selectOrdersSql()}
      WHERE machine_id = ? AND status = ?
      ORDER BY created_at ASC
    `).all(machineId, 'pending') as unknown as MachineOrderRow[];

		return rows.map(mapOrderRow);
	}

	query(
		query?: TOrderQuery,
	): MachineOrder[] {
		const where: string[] = [];
		const params: DbValue[] = [];

		if (query?.machineId !== undefined) {
			where.push('machine_id = ?');
			params.push(query.machineId);
		}
		if (query?.sampleId !== undefined) {
			where.push('sample_id LIKE ?');
			params.push(`%${query.sampleId}%`);
		}
		if (query?.status !== undefined) {
			where.push('status LIKE ?');
			params.push(`%${query.status}%`);
		}

		let sql = selectOrdersSql();
		if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
		sql += ' ORDER BY created_at DESC, id DESC';

		if (query?.limit !== undefined) {
			sql += ' LIMIT ?';
			params.push(normalizeLimit(query.limit));
		}
		if (query?.offset !== undefined) {
			if (query.limit === undefined) {
				sql += ' LIMIT -1';
			}
			sql += ' OFFSET ?';
			params.push(normalizeOffset(query.offset));
		}

		const rows = this.db.prepare(sql).all(
			...params,
		) as unknown as MachineOrderRow[];
		return rows.map(mapOrderRow);
	}

	count(): number {
		const rows = this.db.prepare(
			`SELECT COUNT(*) AS count FROM machine_orders`,
		).get() as { count: number };
		return rows.count;
	}

	markCompleted(orderId: number, completedAt = new Date()): void {
		const completed = encodeDate(completedAt);
		const now = encodeDate(new Date());
		this.db.prepare(`
      UPDATE machine_orders
      SET status = ?,
          completed_at = COALESCE(completed_at, ?),
          updated_at = ?
      WHERE id = ?
    `).run('completed', completed, now, orderId);
	}

	delete(
		id: number,
	): boolean {
		const result = this.db.prepare(`
      DELETE FROM machine_orders
      WHERE id = ?
    `).run(id);

		return result.changes > 0;
	}

	// deleteBySample(
	// 	sampleId: string,
	// 	machineId?: MachineId,
	// ): number {
	// 	const params: DbValue[] = [sampleId];
	// 	let sql = `
	//   DELETE FROM machine_orders
	//   WHERE sample_id = ?
	// `;

	// 	if (machineId !== undefined) {
	// 		sql += ' AND machine_id = ?';
	// 		params.push(machineId);
	// 	}

	// 	const result = this.db.prepare(sql).run(...params);
	// 	return Number(result.changes);
	// }
}

function selectOrdersSql(): string {
	return `
    SELECT
      id,
      machine_id,
      sample_id,
      tests,
      patient_id,
      patient_name,
      dob,
      sex,
      species,
      sample_type,
      rack_position,
      raw,
      status,
      created_at,
      updated_at,
      expires_at,
      sent_at,
      started_at,
      estimated_duration_minutes,
      estimated_completion_at,
      completed_at,
      error_reason
    FROM machine_orders
  `;
}

function mapOrderRow(row: MachineOrderRow): MachineOrder {
	return {
		id: row.id,
		machineId: row.machine_id,
		sampleId: row.sample_id,
		patientId: row.patient_id ?? undefined,
		patientName: row.patient_name ?? undefined,
		dob: row.dob ?? undefined,
		sex: row.sex ?? undefined,
		species: row.species ?? undefined,
		sampleType: row.sample_type ?? undefined,
		rackPosition: row.rack_position ?? undefined,
		tests: decodeJson<string[]>(row.tests, []),
		raw: decodeOptionalJson(row.raw),
		status: row.status,
		createdAt: decodeDate(row.created_at),
		updatedAt: decodeOptionalDate(row.updated_at),
		expiresAt: decodeDate(row.expires_at),
		sentAt: decodeOptionalDate(row.sent_at),
		startedAt: decodeOptionalDate(row.started_at),
		estimatedDurationMinutes: row.estimated_duration_minutes ?? undefined,
		estimatedCompletionAt: decodeOptionalDate(row.estimated_completion_at),
		completedAt: decodeOptionalDate(row.completed_at),
		errorReason: row.error_reason ?? undefined,
	};
}

function set(
	sets: string[],
	values: DbValue[],
	column: string,
	value: DbValue,
): void {
	sets.push(`${column} = ?`);
	values.push(value);
}

function encodeJson(value: unknown): string {
	return JSON.stringify(value ?? null);
}

function encodeOptionalJson(value: unknown): string | null {
	if (value === undefined) return null;
	return typeof value === 'string' ? value : encodeJson(value);
}

function decodeJson<T>(value: string, fallback: T): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function decodeOptionalJson(value: string | null): unknown {
	if (value === null) return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function encodeDate(value: Date): string {
	return value.toISOString();
}

function encodeOptionalDate(value?: Date | null): string | null {
	return value ? encodeDate(value) : null;
}

function decodeDate(value: string): Date {
	return new Date(value);
}

function decodeOptionalDate(value: string | null): Date | undefined {
	return value ? decodeDate(value) : undefined;
}
