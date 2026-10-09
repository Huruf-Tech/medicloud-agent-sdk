import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureDbDirectory } from '../lib/utils.ts';
import { MachineOrderStore } from '../store/orderStore.ts';
import { MachineResultStore } from '../store/resultStore.ts';
import { MachineProfileStore } from '../store/profileStore.ts';
import { MachineTestStatisticStore } from '../store/testStatisticStore.ts';
import { CatalogStore } from '../store/catalogStore.ts';
import { bindCatalogStore } from '../lib/catalogAccess.ts';
import type {
	IMachineCatalogStore,
	IMachineOrderStore,
	IMachineProfileStore,
	IMachineResultStore,
	IMachineSQLiteDB,
	IMachineTestStatisticStore,
} from '../types.ts';

export interface SqliteMachineDatabaseOptions {
	path: string;
}

export class SqliteMachineDatabase implements IMachineSQLiteDB {
	private db?: DatabaseSync;

	private _profiles?: MachineProfileStore;
	private _orders?: MachineOrderStore;
	private _results?: MachineResultStore;
	private _testStatistics?: MachineTestStatisticStore;
	private _catalogs?: CatalogStore;

	constructor(private readonly options: SqliteMachineDatabaseOptions) {}

	get profiles(): IMachineProfileStore {
		if (!this._profiles) {
			throw new Error('Database is not connected');
		}

		return this._profiles;
	}

	get orders(): IMachineOrderStore {
		if (!this._orders) {
			throw new Error('Database is not connected');
		}

		return this._orders;
	}

	get results(): IMachineResultStore {
		if (!this._results) {
			throw new Error('Database is not connected');
		}

		return this._results;
	}

	get testStatistics(): IMachineTestStatisticStore {
		if (!this._testStatistics) {
			throw new Error('Database is not connected');
		}

		return this._testStatistics;
	}

	get catalogs(): IMachineCatalogStore {
		if (!this._catalogs) throw new Error('Database is not connected');
		return this._catalogs;
	}

	get connected(): boolean {
		return this.db !== undefined;
	}

	connect() {
		if (this.db) return; // singleton connection

		const db = this.openSqliteDatabase();
		try {
			const catalogs = new CatalogStore(db);
			catalogs.seedDefaults();
			this.db = db;
			this._profiles = new MachineProfileStore(db);
			this._orders = new MachineOrderStore(db);
			this._results = new MachineResultStore(db);
			this._testStatistics = new MachineTestStatisticStore(db);
			this._catalogs = catalogs;
			bindCatalogStore(catalogs);
		} catch (error) {
			db.close();
			throw error;
		}
	}

	close(): void {
		if (!this.db) return;

		this.db.close();
		this.db = undefined;

		this._profiles = undefined;
		this._orders = undefined;
		this._results = undefined;
		this._testStatistics = undefined;
		this._catalogs = undefined;
		bindCatalogStore(undefined);
	}

	/** DatabaseSync transactions must stay synchronous to prevent interleaving. */
	transaction<T>(callback: () => T): T {
		if (!this.db) throw new Error('Database is not connected');

		this.db.exec('BEGIN IMMEDIATE;');
		try {
			const result = callback();
			this.db.exec('COMMIT;');
			return result;
		} catch (error) {
			this.db.exec('ROLLBACK;');
			throw error;
		}
	}

	private openSqliteDatabase(): DatabaseSync {
		ensureDbDirectory(this.options.path);

		const db = new DatabaseSync(resolve(this.options.path));

		/**
		 * Database journal mode to WAL (Write-Ahead Logging).
		 * Write-Ahead Logging (WAL) means:
		 * 1. Changes are first written to a separate WAL file, not directly to the main database file.
		 * 2. The main database stays untouched until changes are checkpointed.
		 * It gives:
		 * - Better performance (especially for frequent writes).
		 * - Reading and writing can proceed concurrently.
		 * - Concurrent access:
		 * -- Readers can read while a writer is writing
		 * -- Reduces “database is locked” errors
		 * More efficient for multi-threaded apps
		 */
		db.exec('PRAGMA journal_mode = WAL;');
		db.exec('PRAGMA foreign_keys = ON;'); // enables foreign key constraint enforcement
		this.createSchema(db);
		return db;
	}

	private createSchema(db: DatabaseSync): void {
		// relationShips:
		// order.machineId === profile.id
		// profile.driverId === driver.id

		// Machine profile table
		db.exec(`
      CREATE TABLE IF NOT EXISTS machine_profiles (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        driver_id   TEXT NOT NULL , -- if want to enforce one driver profile then apply UNIQUE
        enabled     INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
        name        TEXT,

        -- Driver-specific JSON config.
        config      JSON NOT NULL
                    CHECK(json_valid(config) AND json_type(config) = 'object'),

        -- Timestamps.            
        created_at  TEXT NOT NULL,
        updated_at  TEXT
      );
      `);

		// Machine orders table
		db.exec(`
      CREATE TABLE IF NOT EXISTS machine_orders (
        id                           INTEGER PRIMARY KEY AUTOINCREMENT,

        -- Associated machine profile.
        machine_id                   INTEGER NOT NULL,

        -- Patient and sample identity.
        sample_id                    TEXT NOT NULL,

        -- JSON array of requested test codes.
        tests                        JSON NOT NULL
                                     CHECK(json_valid(tests) AND json_type(tests) = 'array'),

        -- Optional patient/order details.                             
        patient_id                   TEXT,
        patient_name                 TEXT,
        dob                          TEXT,
        sex                          TEXT,
        species                      TEXT,
        sample_type                  TEXT,
        rack_position                TEXT,

        -- Raw order frame.
        raw                          TEXT,

        -- Order lifecycle.
        status                       TEXT NOT NULL DEFAULT 'pending'
                                     CHECK(status IN ('pending', 'testing', 'completed', 'failed')),

        -- Timestamps.                             
        created_at                   TEXT NOT NULL,
        updated_at                   TEXT,
        expires_at                   TEXT NOT NULL,

        -- Processing metadata.
        sent_at                      TEXT,
        started_at                   TEXT,
        estimated_duration_minutes   REAL,
        estimated_completion_at      TEXT,
        completed_at                 TEXT,

        -- Error details.
        error_reason                 TEXT,

        FOREIGN KEY(machine_id) REFERENCES machine_profiles(id)
          ON UPDATE CASCADE ON DELETE RESTRICT -- if you want Delete parent with children "on delete cascade" will Deletes children automatically but "on delete restricted" will 	Rejects the delete
      );
      `);

		// Machine results table
		db.exec(`
      CREATE TABLE IF NOT EXISTS machine_results (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id     INTEGER NOT NULL,
        machine_id   INTEGER NOT NULL,
        sample_id    TEXT NOT NULL,
        patient_id   TEXT,
        results      JSON NOT NULL
                     CHECK(json_valid(results) AND json_type(results) = 'array'),

        -- Raw analyzer response. Stores an empty string only when a driver explicitly has no raw message available.             
        raw          TEXT NOT NULL,
        received_at  TEXT NOT NULL,
        FOREIGN KEY(order_id) REFERENCES machine_orders(id)
          ON UPDATE CASCADE ON DELETE RESTRICT,
        FOREIGN KEY(machine_id) REFERENCES machine_profiles(id)
          ON UPDATE CASCADE ON DELETE RESTRICT
      );
      `);

		// One learned running-average row per machine profile and test code.
		db.exec(`
       CREATE TABLE IF NOT EXISTS machine_test_statistics (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        machine_id            INTEGER NOT NULL,
        test_id               TEXT NOT NULL COLLATE NOCASE,
        last_order_id         INTEGER,
        last_started_at       TEXT,
        last_completed_at     TEXT,
        last_duration_ms      INTEGER NOT NULL CHECK(last_duration_ms >= 0),
        average_duration_ms   REAL NOT NULL CHECK(average_duration_ms >= 0),
        order_count           INTEGER NOT NULL DEFAULT 1 CHECK(order_count > 0),
        created_at            TEXT NOT NULL,
        updated_at            TEXT,
        
        UNIQUE(machine_id, test_id),
        FOREIGN KEY(machine_id) REFERENCES machine_profiles(id)
          ON UPDATE CASCADE ON DELETE RESTRICT,
        FOREIGN KEY(last_order_id) REFERENCES machine_orders(id)
          ON UPDATE CASCADE ON DELETE SET NULL
      );
      `);

		db.exec(`
      CREATE TABLE IF NOT EXISTS machine_catalogs (
        driver_id TEXT PRIMARY KEY COLLATE NOCASE,
        machine TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS machine_catalog_tests (
        driver_id TEXT NOT NULL COLLATE NOCASE,
        code TEXT NOT NULL COLLATE NOCASE,
        name TEXT NOT NULL,
        analytes TEXT NOT NULL CHECK(json_valid(analytes) AND json_type(analytes) = 'array'),
        aliases TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(aliases) AND json_type(aliases) = 'array'),
        device_code TEXT,
        unit TEXT,
        normal_range TEXT,
        category TEXT,
        slot INTEGER CHECK(slot IS NULL OR slot > 0),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(driver_id, code),
        FOREIGN KEY(driver_id) REFERENCES machine_catalogs(driver_id) ON DELETE CASCADE
      );
    `);

		// Indexes
		db.exec(`
      CREATE INDEX IF NOT EXISTS idx_machine_profiles_enabled
        ON machine_profiles(enabled);
      CREATE INDEX IF NOT EXISTS idx_machine_orders_machine
        ON machine_orders(machine_id);
      CREATE INDEX IF NOT EXISTS idx_machine_orders_sample
        ON machine_orders(sample_id);
      CREATE INDEX IF NOT EXISTS idx_machine_orders_status
        ON machine_orders(status);
      CREATE INDEX IF NOT EXISTS idx_machine_orders_machine_status
        ON machine_orders(machine_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_machine_orders_active_sample
        ON machine_orders(machine_id, sample_id)
        WHERE status IN ('pending', 'testing');
      CREATE INDEX IF NOT EXISTS idx_machine_results_machine
        ON machine_results(machine_id);
      CREATE INDEX IF NOT EXISTS idx_machine_results_sample
        ON machine_results(sample_id);
      CREATE INDEX IF NOT EXISTS idx_machine_results_received
        ON machine_results(received_at);

      -- if results send one by one for single order then remove this unique index ok 
      CREATE UNIQUE INDEX IF NOT EXISTS idx_machine_results_order
        ON machine_results(order_id);

      CREATE INDEX IF NOT EXISTS idx_machine_test_statistics_last_order
        ON machine_test_statistics(last_order_id);
      `);
	}
}
