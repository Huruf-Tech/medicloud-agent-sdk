import type { CatalogTestEntry, IMachineCatalogStore } from '../types.ts';

let catalogStore: IMachineCatalogStore | undefined;

/** Bind the SDK's SQLite catalog repository before starting machine profiles. */
export function bindCatalogStore(
	store: IMachineCatalogStore | undefined,
): void {
	catalogStore = store;
}

export function managedCatalogTests(
	driverId: string,
): readonly CatalogTestEntry[] {
	if (!catalogStore) {
		throw new Error('Machine catalog database is not connected.');
	}
	const catalog = catalogStore.get(driverId);
	if (!catalog) {
		throw new Error(`No managed catalog for driver "${driverId}".`);
	}
	return catalog.tests.filter((test) => test.enabled !== false);
}
