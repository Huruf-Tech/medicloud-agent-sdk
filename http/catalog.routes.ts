import * as z from '@zod/zod';
import type { MachineRegistry } from '../registry.ts';
import type { CatalogView } from '../types.ts';
import { HttpError, json } from './utils.ts';
import { NonEmptyStringSchema, parseInput, parseJson } from './validation.ts';

const AnalyteSchema = z.object({
	code: NonEmptyStringSchema,
	name: NonEmptyStringSchema,
	unit: NonEmptyStringSchema.optional(),
	category: NonEmptyStringSchema.optional(),
	decimals: z.number().int().min(0).max(8).optional(),
}).strict();

const CatalogTestSchema = z.object({
	code: NonEmptyStringSchema,
	name: NonEmptyStringSchema,
	analytes: z.array(AnalyteSchema).min(1),
	aliases: z.array(NonEmptyStringSchema).default([]),
	deviceCode: NonEmptyStringSchema.optional(),
	unit: z.string().optional(),
	normalRange: z.string().optional(),
	category: z.string().optional(),
	slot: z.number().int().positive().optional(),
	enabled: z.boolean().default(true),
}).strict().refine(
	(test) =>
		new Set(test.analytes.map((analyte) => analyte.code.toLowerCase()))
			.size === test.analytes.length,
	'analyte codes must be unique within a test',
);

function validateDriverTest(
	driverId: string,
	test: z.infer<typeof CatalogTestSchema>,
): void {
	if (driverId === 'iflash3000') {
		const channel = Number(test.analytes[0]?.code);
		if (
			test.analytes.length !== 1 ||
			!Number.isSafeInteger(channel) ||
			channel <= 0
		) {
			throw new HttpError(
				'iFlash tests require one positive numeric channel analyte.',
			);
		}
	}
	if (driverId === 'biolabo-kenza' && test.slot === undefined) {
		throw new HttpError('Kenza tests require an instrument slot.');
	}
	if (
		driverId === 'draccu-afi-6100b' &&
		(test.analytes.length !== 1 || !/^[0-9]+$/.test(test.analytes[0].code))
	) {
		throw new HttpError('DrAccu tests require one numeric result item ID.');
	}
	if (driverId === 'bonavera-200' && !/^[0-9]+$/.test(test.code)) {
		throw new HttpError('Bonavera 200 order codes must be numeric.');
	}
	if (driverId === 'bonavera-count' && test.code !== 'CBC') {
		throw new HttpError('Bonavera Count supports only the CBC order code.');
	}
}

function validateIdentifierConflicts(
	catalog: CatalogView,
	test: z.infer<typeof CatalogTestSchema>,
): void {
	if (
		catalog.driverId !== 'snibe-maglumi-800' &&
		catalog.driverId !== 'roche-cobas-c111' &&
		catalog.driverId !== 'biolabo-kenza'
	) return;
	const normalize = catalog.driverId === 'biolabo-kenza'
		? (value: string) =>
			value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
		: (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
	const identifiers = (entry: {
		code: string;
		name: string;
		deviceCode?: string;
		aliases?: readonly string[];
	}) =>
		[entry.code, entry.name, entry.deviceCode, ...(entry.aliases ?? [])]
			.filter((value): value is string => Boolean(value))
			.map(normalize);
	const requested = new Set(identifiers(test));
	for (const existing of catalog.tests) {
		if (existing.code.toLowerCase() === test.code.toLowerCase()) continue;
		if (identifiers(existing).some((value) => requested.has(value))) {
			throw new HttpError(
				`Identifier or alias conflicts with catalog test "${existing.code}".`,
				409,
			);
		}
	}
}

const CreateCatalogSchema = z.object({
	driverId: NonEmptyStringSchema,
	machine: NonEmptyStringSchema,
}).strict();
const RenameCatalogSchema = z.object({ machine: NonEmptyStringSchema })
	.strict();
const CatalogQuerySchema = z.object({
	machine: NonEmptyStringSchema.optional(),
	driver: NonEmptyStringSchema.optional(),
}).strict();

export async function handleCatalogRoutes(
	registry: MachineRegistry,
	request: Request,
	url: URL,
	method: string,
	segments: string[],
): Promise<Response> {
	// GET /catalogs
	// Returns all catalogs, or a specific catalog using ?machine=... or ?driver=...
	if (segments.length === 0 && method === 'GET') {
		const query = parseInput(
			CatalogQuerySchema,
			Object.fromEntries(url.searchParams),
		);
		const key = query.machine ?? query.driver;
		if (!key) return json({ catalogs: registry.listCatalogs() });

		const catalog = registry.getCatalog(key);
		if (!catalog) throw new HttpError('catalog not found', 404);
		return json(catalog);
	}

	// POST /catalogs
	// Creates a new catalog for an existing machine driver.
	if (segments.length === 0 && method === 'POST') {
		const input = await parseJson(request, CreateCatalogSchema);
		if (registry.getCatalog(input.machine)) {
			throw new HttpError('Catalog name already exists', 409);
		}
		if (registry.getCatalog(input.driverId)) {
			throw new HttpError('Catalog already exists', 409);
		}
		if (
			!registry.listDrivers().some((driver) =>
				driver.id === input.driverId
			)
		) {
			throw new HttpError('Unknown machine driver', 404);
		}
		return json(registry.createCatalog(input.driverId, input.machine), 201);
	}

	// Resolve the catalog identified by the driver ID.
	const driverId = segments[0]
		? parseInput(NonEmptyStringSchema, segments[0])
		: '';
	const catalog = driverId ? registry.getCatalog(driverId) : undefined;
	if (!catalog || catalog.driverId.toLowerCase() !== driverId.toLowerCase()) {
		throw new HttpError('catalog not found', 404);
	}

	// Static catalogs are read-only and cannot be modified.
	if (catalog.source !== 'database' && method !== 'GET') {
		throw new HttpError('This catalog remains static and read-only', 403);
	}

	// GET /catalogs/:driverId
	// Returns the catalog associated with the specified driver.
	if (segments.length === 1 && method === 'GET') return json(catalog);

	// PATCH /catalogs/:driverId
	// Renames the catalog associated with the specified driver.
	if (segments.length === 1 && method === 'PATCH') {
		const input = await parseJson(request, RenameCatalogSchema);
		const named = registry.getCatalog(input.machine);
		if (named && named.driverId.toLowerCase() !== driverId.toLowerCase()) {
			throw new HttpError('Catalog name already exists', 409);
		}
		return json(registry.renameCatalog(driverId, input.machine));
	}

	// POST /catalogs/:driverId/tests
	// Adds a new test to the specified catalog.
	if (segments[1] === 'tests' && segments.length === 2 && method === 'POST') {
		const input = await parseJson(request, CatalogTestSchema);
		validateDriverTest(driverId, input);
		validateIdentifierConflicts(catalog, input);
		if (
			catalog.tests.some((test) =>
				test.code.toLowerCase() === input.code.toLowerCase()
			)
		) {
			throw new HttpError('Test code already exists', 409);
		}
		return json({ test: registry.upsertCatalogTest(driverId, input) }, 201);
	}

	// PUT /catalogs/:driverId/tests/:code
	// Updates an existing test in the specified catalog.
	if (segments[1] === 'tests' && segments.length === 3) {
		const code = parseInput(NonEmptyStringSchema, segments[2]);

		if (method === 'PUT') {
			const input = await parseJson(request, CatalogTestSchema);
			validateDriverTest(driverId, input);
			validateIdentifierConflicts(catalog, input);
			if (input.code.toLowerCase() !== code.toLowerCase()) {
				throw new HttpError(
					'Test code cannot be changed. Create a new test instead.',
				);
			}
			if (
				!catalog.tests.some((test) =>
					test.code.toLowerCase() === code.toLowerCase()
				)
			) {
				throw new HttpError('Test code not found', 404);
			}
			return json({ test: registry.upsertCatalogTest(driverId, input) });
		}

		// DELETE /catalogs/:driverId/tests/:code
		// Deletes the specified test from the catalog.
		if (method === 'DELETE') {
			if (!registry.deleteCatalogTest(driverId, code)) {
				throw new HttpError('Test code not found', 404);
			}
			return json({ success: true, code });
		}
	}

	throw new HttpError('not found', 404);
}
