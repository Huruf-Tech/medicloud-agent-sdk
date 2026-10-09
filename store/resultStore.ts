import { SQLiteStore } from '../abstracts/baseStore.ts';
import { TResultQuery } from '../schema.ts';
import type {
	IMachineResultStore,
	MachineAnalyteResult,
	MachineResult,
	MachineResultPayload,
	MachineResultType,
	StoredMachineResult,
} from '../types.ts';
import type { DatabaseSync } from 'node:sqlite';

type DbValue = string | number | null;

interface MachineResultRow {
	id: number;
	order_id: number;
	machine_id: number;
	sample_id: string;
	patient_id: string | null;
	results: string;
	raw: string | null;
	received_at: string;
}

export class MachineResultStore extends SQLiteStore
	implements IMachineResultStore {
	constructor(db: DatabaseSync) {
		super(db);
	}

	insert(result: MachineResult): number {
		const payload = normalizeMachineResultPayload(result.payload);
		const insert = this.db.prepare(`
      INSERT INTO machine_results (
        order_id,
        machine_id,
        sample_id,
        patient_id,
        results,
        raw,
        received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
			result.orderId,
			result.machineId,
			result.sampleId,
			result.patientId ?? null,
			JSON.stringify(payload.results),
			result.raw ?? '',
			encodeDate(result.receivedAt),
		);

		return Number(insert.lastInsertRowid);
	}

	get(id: number): StoredMachineResult | undefined {
		const row = this.db.prepare(`${selectResultsSql()} WHERE id = ?`).get(
			id,
		) as
			| MachineResultRow
			| undefined;

		return row ? mapResultRow(row) : undefined;
	}

	query(query?: TResultQuery): StoredMachineResult[] {
		const where: string[] = [];
		const params: DbValue[] = [];

		if (query?.orderId !== undefined) {
			where.push('order_id = ?');
			params.push(query.orderId);
		}
		if (query?.machineId !== undefined) {
			where.push('machine_id = ?');
			params.push(query.machineId);
		}
		if (query?.sampleId !== undefined) {
			where.push('sample_id = ?');
			params.push(query.sampleId);
		}

		let sql = selectResultsSql();
		if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
		sql += ' ORDER BY received_at DESC, id DESC';

		if (query?.limit !== undefined) {
			sql += ' LIMIT ?';
			params.push(normalizeLimit(query.limit));
		}
		if (query?.offset !== undefined) {
			if (query.limit === undefined) sql += ' LIMIT -1';
			sql += ' OFFSET ?';
			params.push(normalizeOffset(query.offset));
		}

		const rows = this.db.prepare(sql).all(
			...params,
		) as unknown as MachineResultRow[];
		return rows.map(mapResultRow);
	}

	count(): number {
		const rows = this.db.prepare(
			`SELECT COUNT(*) AS count FROM machine_results`,
		).get() as { count: number };
		return rows.count;
	}
}

function selectResultsSql(): string {
	return `
    SELECT
      id,
      order_id,
      machine_id,
      sample_id,
      patient_id,
      results,
      raw,
      received_at
    FROM machine_results
  `;
}

function mapResultRow(row: MachineResultRow): StoredMachineResult {
	return {
		id: row.id,
		orderId: row.order_id,
		machineId: row.machine_id,
		sampleId: row.sample_id,
		patientId: row.patient_id ?? undefined,
		payload: decodeMachineResultPayload(
			row.results,
			`machine_results.id=${row.id}`,
		),
		raw: row.raw ?? '',
		receivedAt: decodeDate(row.received_at),
	};
}

function decodeMachineResultPayload(
	value: string,
	source: string,
): MachineResultPayload {
	let decoded: unknown;
	try {
		decoded = JSON.parse(value);
	} catch (error) {
		throw new Error(`${source}.results is not valid JSON`, {
			cause: error,
		});
	}

	try {
		return normalizeMachineResultPayload({ results: decoded });
	} catch (error) {
		throw new Error(`${source}.results has an invalid shape`, {
			cause: error,
		});
	}
}

/** Normalize every established driver spelling to the SDK's common shape. */
export function normalizeMachineResultPayload(
	value: unknown,
): MachineResultPayload {
	const payload = record(value, 'payload');
	const rawResults = payload.results ?? payload.analytes;
	if (!Array.isArray(rawResults)) {
		throw new TypeError('payload.results must be an array');
	}

	return {
		results: rawResults.map((result, index) =>
			normalizeAnalyte(record(result, `payload.results[${index}]`), index)
		),
	};
}

function normalizeAnalyte(
	value: Record<string, unknown>,
	index: number,
): MachineAnalyteResult {
	const path = `payload.results[${index}]`;
	const resultType = requiredString(
		value.resultType ?? value.result_type,
		`${path}.resultType`,
	);
	if (!isMachineResultType(resultType)) {
		throw new TypeError(`${path}.resultType must be I, F, or B`);
	}

	const normalized: MachineAnalyteResult = {
		assayNo: requiredString(
			value.assayNo ?? value.assay_no,
			`${path}.assayNo`,
		),
		resultType,
	};

	optionalStringField(
		normalized,
		'assayName',
		value.assayName ?? value.assay_name,
		path,
	);
	optionalStringField(normalized, 'value', value.value, path);
	optionalStringField(normalized, 'qualitative', value.qualitative, path);
	optionalStringField(normalized, 'unit', value.unit, path);

	optionalStringField(
		normalized,
		'lowReference',
		value.lowReference,
		path,
	);
	optionalStringField(
		normalized,
		'highReference',
		value.highReference,
		path,
	);
	optionalStringField(
		normalized,
		'abnormalFlag',
		value.abnormalFlag ?? value.abnormal_flag,
		path,
	);
	optionalStringField(normalized, 'status', value.status, path);
	optionalStringField(
		normalized,
		'completedAt',
		value.completedAt ?? value.completed_at,
		path,
	);

	return normalized;
}

function optionalStringField<
	TObject extends object,
	TKey extends keyof TObject,
>(
	target: TObject,
	key: TKey,
	value: unknown,
	path: string,
): void {
	if (value === undefined) return;
	if (typeof value !== 'string') {
		throw new TypeError(
			`${path}.${String(key)} must be a string when present`,
		);
	}
	target[key] = value as TObject[TKey];
}

function requiredString(value: unknown, path: string): string {
	if (typeof value !== 'string') {
		throw new TypeError(`${path} must be a string`);
	}
	return value;
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new TypeError(`${path} must be an object`);
	}
	return value as Record<string, unknown>;
}

function isMachineResultType(value: string): value is MachineResultType {
	return value === 'I' || value === 'F' || value === 'B';
}

function encodeDate(value: Date): string {
	return value.toISOString();
}

function decodeDate(value: string): Date {
	return new Date(value);
}

function normalizeLimit(limit: number): number {
	return Math.max(0, Math.trunc(limit));
}

function normalizeOffset(offset: number): number {
	return Math.max(0, Math.trunc(offset));
}
