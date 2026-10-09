import type { DatabaseSync } from 'node:sqlite';
import { SQLiteStore } from '../abstracts/baseStore.ts';
import type {
	IMachineTestStatisticStore,
	MachineId,
	MachineOrder,
	MachineTestStatistic,
} from '../types.ts';
import { TTestStatisticQuery } from '../schema.ts';

type DbValue = string | number | null;
interface MachineTestStatisticRow {
	id: number;
	machine_id: number;
	test_id: string;
	last_order_id: number | null;
	last_started_at: string | null;
	last_completed_at: string | null;
	last_duration_ms: number;
	average_duration_ms: number;
	order_count: number;
	created_at: string;
	updated_at: string | null;
}

export class MachineTestStatisticStore extends SQLiteStore
	implements IMachineTestStatisticStore {
	constructor(db: DatabaseSync) {
		super(db);
	}

	// get test stats including (avrg_duration) required for estimated time
	get(id: number): MachineTestStatistic | undefined {
		const row = this.db.prepare(`${selectStatisticsSql()} WHERE id = ?`)
			.get(
				id,
			) as MachineTestStatisticRow | undefined;
		return row ? mapStatisticRow(row) : undefined;
	}

	find(
		machineId: MachineId,
		testId: string,
	): MachineTestStatistic | undefined {
		const normalizedTestId = normalizeTestId(testId);
		if (normalizedTestId === '') return undefined;

		const row = this.db.prepare(`
      ${selectStatisticsSql()}
      WHERE machine_id = ? AND test_id = ? COLLATE NOCASE
    `).get(machineId, normalizedTestId) as
			| MachineTestStatisticRow
			| undefined;
		return row ? mapStatisticRow(row) : undefined;
	}

	query(query?: TTestStatisticQuery): MachineTestStatistic[] {
		const where: string[] = [];
		const params: DbValue[] = [];

		if (query?.machineId !== undefined) {
			where.push('machine_id = ?');
			params.push(query.machineId);
		}
		if (query?.testId !== undefined) {
			where.push('test_id = ? COLLATE NOCASE');
			params.push(normalizeTestId(query.testId));
		}

		let sql = selectStatisticsSql();
		if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
		sql += ' ORDER BY machine_id, test_id COLLATE NOCASE';

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
		) as unknown as MachineTestStatisticRow[];
		return rows.map(mapStatisticRow);
	}

	count(): number {
		const rows = this.db.prepare(
			`SELECT COUNT(*) AS count FROM machine_test_statistics`,
		).get() as { count: number };
		return rows.count;
	}

	// estimated durationMs
	estimateOrderDurationMs(
		machineId: MachineId,
		testIds: readonly string[],
	): number | undefined {
		const uniqueTestIds = uniqueNormalizedTestIds(testIds);
		if (uniqueTestIds.length === 0) return undefined;

		// store max average
		let maximumDurationMs = 0;
		for (const testId of uniqueTestIds) {
			const statistic = this.find(machineId, testId);
			if (!statistic) return undefined;
			maximumDurationMs = Math.max(
				maximumDurationMs,
				statistic.averageDurationMs,
			);
		}
		return maximumDurationMs > 0 ? maximumDurationMs : undefined;
	}

	//
	recordCompletedOrder(order: MachineOrder, completedAt: Date): void {
		if (order.id === undefined) {
			throw new Error(
				'Cannot record test statistics for an unstored order.',
			);
		}

		const startedAt = order.startedAt ?? order.sentAt ?? order.createdAt;
		const durationMs = completedAt.getTime() - startedAt.getTime();
		if (!Number.isFinite(durationMs) || durationMs < 0) return;

		const now = new Date();
		for (const testId of uniqueNormalizedTestIds(order.tests)) {
			// This query is performing an upsert (insert if new, otherwise update if receiving same test orde from same machine)
			//   Avrg Formula: ((oldAverage * orderCount) + newDuration) / (orderCount + 1)

			this.db.prepare(`
        INSERT INTO machine_test_statistics (
          machine_id,
          test_id,
          last_order_id,
          last_started_at,
          last_completed_at,
          last_duration_ms,
          average_duration_ms,
          order_count,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NULL)
        ON CONFLICT(machine_id, test_id) DO UPDATE SET
          last_order_id = excluded.last_order_id,
          last_started_at = excluded.last_started_at,
          last_completed_at = excluded.last_completed_at,
          last_duration_ms = excluded.last_duration_ms,
          average_duration_ms = (
            (machine_test_statistics.average_duration_ms *
              machine_test_statistics.order_count) +
            excluded.last_duration_ms
          ) / (machine_test_statistics.order_count + 1),
          order_count = machine_test_statistics.order_count + 1,
          updated_at = excluded.created_at
      `).run(
				order.machineId,
				testId,
				order.id,
				encodeDate(startedAt),
				encodeDate(completedAt),
				durationMs,
				durationMs,
				encodeDate(now),
			);
		}
	}

	delete(id: number): boolean {
		const result = this.db.prepare(
			'DELETE FROM machine_test_statistics WHERE id = ?',
		).run(id);
		return result.changes > 0;
	}
}

function selectStatisticsSql(): string {
	return `
    SELECT
      id,
      machine_id,
      test_id,
      last_order_id,
      last_started_at,
      last_completed_at,
      last_duration_ms,
      average_duration_ms,
      order_count,
      created_at,
      updated_at
    FROM machine_test_statistics
  `;
}

function uniqueNormalizedTestIds(testIds: readonly string[]): string[] {
	const unique = new Map<string, string>();
	for (const testId of testIds) {
		const normalized = normalizeTestId(testId);
		if (normalized !== '') unique.set(normalized.toLowerCase(), normalized);
	}
	return [...unique.values()];
}

function normalizeTestId(testId: string): string {
	return testId.trim();
}

function mapStatisticRow(row: MachineTestStatisticRow): MachineTestStatistic {
	return {
		id: row.id,
		machineId: row.machine_id,
		testId: row.test_id,
		lastOrderId: row.last_order_id ?? undefined,
		lastStartedAt: decodeOptionalDate(row.last_started_at),
		lastCompletedAt: decodeOptionalDate(row.last_completed_at),
		lastDurationMs: row.last_duration_ms,
		averageDurationMs: row.average_duration_ms,
		orderCount: row.order_count,
		createdAt: new Date(row.created_at),
		updatedAt: decodeOptionalDate(row.updated_at),
	};
}

function encodeDate(value: Date): string {
	return value.toISOString();
}

function decodeOptionalDate(value: string | null): Date | undefined {
	return value ? new Date(value) : undefined;
}

function normalizeLimit(limit: number): number {
	return Math.max(0, Math.trunc(limit));
}

function normalizeOffset(offset: number): number {
	return Math.max(0, Math.trunc(offset));
}
