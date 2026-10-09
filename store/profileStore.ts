import type {
	DbValue,
	IMachineProfileStore,
	MachineConfig,
	MachineDriverId,
	MachineId,
	MachineProfile,
	MachineProfileInput,
	MachineProfileUpdate,
} from '../types.ts';
import { SQLiteStore } from '../abstracts/baseStore.ts';
import type { DatabaseSync } from 'node:sqlite';
import { normalizeLimit, normalizeOffset } from '../lib/utils.ts';
import { TProfileQuery } from '../schema.ts';

interface MachineProfileRow {
	id: number;
	driver_id: string;
	enabled: number;
	name: string | null;
	config: string;
	created_at: string;
	updated_at: string | null;
}

export class MachineProfileStore extends SQLiteStore
	implements IMachineProfileStore {
	constructor(db: DatabaseSync) {
		super(db);
	}

	insert(
		profile: MachineProfileInput,
	): MachineId {
		const result = this.db.prepare(`
      INSERT INTO machine_profiles (
        driver_id,
        enabled,
        name,
        config,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
			profile.driverId,
			profile.enabled === true ? 1 : 0,
			profile.name ?? null,
			encodeJson(profile.config),
			encodeDate(profile.createdAt ?? new Date()),
			null,
		);

		return Number(result.lastInsertRowid);
	}

	update(
		machineId: MachineId,
		profile: MachineProfileUpdate,
	): void {
		const sets: string[] = [];
		const values: Array<string | number | null> = [];

		if (profile.driverId !== undefined) {
			set(sets, values, 'driver_id', profile.driverId);
		}
		if (profile.enabled !== undefined) {
			set(sets, values, 'enabled', profile.enabled ? 1 : 0);
		}
		if (profile.name !== undefined) {
			set(sets, values, 'name', profile.name ?? null);
		}
		if (profile.config !== undefined) {
			set(sets, values, 'config', encodeJson(profile.config));
		}

		set(
			sets,
			values,
			'updated_at',
			encodeDate(profile.updatedAt ?? new Date()),
		);

		values.push(machineId);
		this.db.prepare(
			`UPDATE machine_profiles SET ${sets.join(', ')} WHERE id = ?`,
		).run(
			...values,
		);
	}

	get(
		machineId: MachineId,
	): MachineProfile | undefined {
		const row = this.db.prepare(`${selectProfilesSql()} WHERE id = ?
    `).get(machineId) as MachineProfileRow | undefined;

		return row ? mapProfileRow(row) : undefined;
	}

	query(query?: TProfileQuery): MachineProfile[] {
		const where: string[] = [];
		const params: DbValue[] = [];

		if (query?.id !== undefined) {
			where.push('id = ?');
			params.push(query.id);
		}
		if (query?.driverId !== undefined) {
			where.push('driver_id = ?');
			params.push(query.driverId);
		}
		if (query?.name !== undefined) {
			where.push('name LIKE ?');
			params.push(`%${query.name}%`);
		}
		if (query?.enabled !== undefined) {
			where.push('enabled = ?');
			params.push(query.enabled ? 1 : 0);
		}

		let sql = selectProfilesSql();
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
		) as unknown as MachineProfileRow[];

		return rows.map(mapProfileRow);
	}

	count(): number {
		const rows = this.db.prepare(
			`SELECT COUNT(*) AS count FROM machine_profiles`,
		).get() as { count: number };
		return rows.count;
	}

	setEnabled(
		machineId: MachineId,
		enabled: boolean,
	): void {
		this.db.prepare(`
      UPDATE machine_profiles
      SET enabled = ?, updated_at = ?
      WHERE id = ?
    `).run(enabled ? 1 : 0, encodeDate(new Date()), machineId);
	}

	delete(
		machineId: MachineId,
	): boolean {
		const result = this.db.prepare(`
      DELETE FROM machine_profiles
      WHERE id = ?
    `).run(machineId);

		return result.changes > 0;
	}
}

function selectProfilesSql(): string {
	return `
    SELECT
      id,
      driver_id,
      enabled,
      name,
      config,
      created_at,
      updated_at
    FROM machine_profiles
  `;
}

function mapProfileRow(row: MachineProfileRow): MachineProfile {
	return {
		id: row.id,
		driverId: row.driver_id,
		enabled: row.enabled === 1,
		name: row.name ?? undefined,
		config: decodeJson<MachineConfig>(row.config, {}),
		createdAt: decodeDate(row.created_at),
		updatedAt: decodeOptionalDate(row.updated_at),
	};
}
function set(
	sets: string[],
	values: Array<string | number | null>,
	column: string,
	value: string | number | null,
): void {
	sets.push(`${column} = ?`);
	values.push(value);
}

function encodeJson(value: unknown): string {
	return JSON.stringify(value ?? {});
}

function decodeJson<T>(value: string, fallback: T): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function encodeDate(value: Date): string {
	return value.toISOString();
}

function decodeDate(value: string): Date {
	return new Date(value);
}

function decodeOptionalDate(value: string | null): Date | undefined {
	return value ? decodeDate(value) : undefined;
}
