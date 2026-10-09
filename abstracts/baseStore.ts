import type { DatabaseSync } from 'node:sqlite';

export abstract class SQLiteStore {
	constructor(
		protected readonly db: DatabaseSync,
	) {}

	protected transaction<T>(callback: () => T): T {
		this.db.exec('BEGIN IMMEDIATE');
		try {
			const result = callback();
			this.db.exec('COMMIT');
			return result;
		} catch (error) {
			this.db.exec('ROLLBACK');
			throw error;
		}
	}
}
