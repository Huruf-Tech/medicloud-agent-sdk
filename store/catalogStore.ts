import type { DatabaseSync } from 'node:sqlite';
import type {
	CatalogTestEntry,
	CatalogView,
	IMachineCatalogStore,
} from '../types.ts';
import { SQLiteStore } from '../abstracts/baseStore.ts';
import { MANAGED_CATALOG_SEEDS } from './catalogSeeds.ts';

export class CatalogInUseError extends Error {
	constructor(code: string) {
		super(`Catalog test "${code}" is used by a pending or running order.`);
		this.name = 'CatalogInUseError';
	}
}

interface CatalogRow {
	driver_id: string;
	machine: string;
}
interface TestRow {
	code: string;
	name: string;
	analytes: string;
	aliases: string;
	device_code: string | null;
	unit: string | null;
	normal_range: string | null;
	category: string | null;
	slot: number | null;
	enabled: number;
}

/** One catalog per driver. Tests and analytes remain separate logical entities. */
export class CatalogStore extends SQLiteStore implements IMachineCatalogStore {
	private readonly cache = new Map<string, CatalogView>();

	constructor(db: DatabaseSync) {
		super(db);
	}

	seedDefaults(): void {
		for (const catalog of MANAGED_CATALOG_SEEDS) {
			this.transaction(() => {
				// prevant duplicate catalog creation setup
				if (this.get(catalog.driverId)) return;

				// setup catalog only one time.
				this.create(catalog.driverId, catalog.machine);
				for (const test of catalog.tests) {
					this.upsertTest(catalog.driverId, test);
				}
			});
		}
	}

	list(): CatalogView[] {
		const rows = this.db.prepare(
			'SELECT driver_id, machine FROM machine_catalogs ORDER BY machine COLLATE NOCASE',
		).all() as unknown as CatalogRow[];
		return rows.map((row) =>
			this.get(row.driver_id) ?? this.mapCatalog(row)
		);
	}

	get(driverId: string): CatalogView | undefined {
		const key = driverId.toLowerCase();
		const cached = this.cache.get(key);
		if (cached) return cached;
		const row = this.db.prepare(
			'SELECT driver_id, machine FROM machine_catalogs WHERE driver_id = ? COLLATE NOCASE',
		).get(driverId) as CatalogRow | undefined;
		if (!row) return undefined;
		const catalog = this.mapCatalog(row);
		this.cache.set(key, catalog);
		return catalog;
	}

	create(driverId: string, machine: string): CatalogView {
		this.db.prepare(
			'INSERT INTO machine_catalogs (driver_id, machine, created_at, updated_at) VALUES (?, ?, ?, ?)',
		).run(
			driverId,
			machine,
			new Date().toISOString(),
			new Date().toISOString(),
		);
		const catalog = this.get(driverId);
		if (!catalog) throw new Error('Catalog insert failed.');
		return catalog;
	}

	rename(driverId: string, machine: string): CatalogView | undefined {
		const result = this.db.prepare(
			'UPDATE machine_catalogs SET machine = ?, updated_at = ? WHERE driver_id = ?',
		).run(machine, new Date().toISOString(), driverId);
		this.cache.delete(driverId.toLowerCase());
		return result.changes ? this.get(driverId) : undefined;
	}

	upsertTest(driverId: string, test: CatalogTestEntry): CatalogTestEntry {
		if (this.getTest(driverId, test.code)) {
			this.assertNotInUse(driverId, test.code);
		}
		this.db.prepare(`
      INSERT INTO machine_catalog_tests
        (driver_id, code, name, analytes, aliases, device_code, unit, normal_range, category, slot, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(driver_id, code) DO UPDATE SET
        name = excluded.name,
        analytes = excluded.analytes,
        aliases = excluded.aliases,
        device_code = excluded.device_code,
        unit = excluded.unit,
        normal_range = excluded.normal_range,
        category = excluded.category,
        slot = excluded.slot,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(
			driverId,
			test.code,
			test.name,
			JSON.stringify(test.analytes),
			JSON.stringify(test.aliases ?? []),
			test.deviceCode ?? null,
			test.unit ?? null,
			test.normalRange ?? null,
			test.category ?? null,
			test.slot ?? null,
			test.enabled === false ? 0 : 1,
			new Date().toISOString(),
		);
		this.cache.delete(driverId.toLowerCase());
		const stored = this.getTest(driverId, test.code);
		if (!stored) throw new Error('Catalog test insert failed.');
		return stored;
	}

	getTest(driverId: string, code: string): CatalogTestEntry | undefined {
		const row = this.db.prepare(
			'SELECT * FROM machine_catalog_tests WHERE driver_id = ? COLLATE NOCASE AND code = ? COLLATE NOCASE',
		).get(driverId, code) as TestRow | undefined;
		return row ? mapTest(row) : undefined;
	}

	deleteTest(driverId: string, code: string): boolean {
		this.assertNotInUse(driverId, code);
		this.cache.delete(driverId.toLowerCase());
		return this.db.prepare(
			'DELETE FROM machine_catalog_tests WHERE driver_id = ? COLLATE NOCASE AND code = ? COLLATE NOCASE',
		).run(driverId, code).changes > 0;
	}

	private assertNotInUse(driverId: string, code: string): void {
		const active = this.db.prepare(`
      SELECT 1 FROM machine_orders AS orders
      JOIN machine_profiles AS profiles ON profiles.id = orders.machine_id
      WHERE profiles.driver_id = ? COLLATE NOCASE
        AND orders.status IN ('pending', 'testing')
        AND EXISTS (
          SELECT 1 FROM json_each(orders.tests)
          WHERE value = ? COLLATE NOCASE
        )
      LIMIT 1
    `).get(driverId, code);
		if (active) throw new CatalogInUseError(code);
	}

	private mapCatalog(row: CatalogRow): CatalogView {
		const tests = this.db.prepare(
			'SELECT * FROM machine_catalog_tests WHERE driver_id = ? ORDER BY rowid',
		).all(row.driver_id) as unknown as TestRow[];
		return {
			id: row.driver_id,
			driverId: row.driver_id,
			machine: row.machine,
			tests: tests.map(mapTest),
			source: 'database',
		};
	}
}

function mapTest(row: TestRow): CatalogTestEntry {
	return {
		code: row.code,
		name: row.name,
		analytes: JSON.parse(row.analytes),
		aliases: JSON.parse(row.aliases),
		...(row.device_code !== null ? { deviceCode: row.device_code } : {}),
		...(row.unit !== null ? { unit: row.unit } : {}),
		...(row.normal_range !== null ? { normalRange: row.normal_range } : {}),
		...(row.category !== null ? { category: row.category } : {}),
		...(row.slot !== null ? { slot: row.slot } : {}),
		enabled: row.enabled === 1,
	};
}
