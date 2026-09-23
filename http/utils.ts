import { DRACCU_AFI_6100B_CATALOG } from '../machines/draccuAfi6100b/catalog.ts';
import { drAccuAfi6100bMachineId } from '../machines/draccuAfi6100b/index.ts';
import * as z from '@zod/zod';
import { IFLASH_3000_TESTS } from '../machines/iflash/catalog.ts';
import { iFlash3000MachineId } from '../machines/iflash/index.ts';
import { MAGLUMI_800_ASSAYS } from '../machines/maglumi800/catalog.ts';
import { maglumi800MachineId } from '../machines/maglumi800/index.ts';
import { COBAS_C111_CATALOG } from '../machines/rocheCobasC111/catalog.ts';
import { rocheCobasC111MachineId } from '../machines/rocheCobasC111/index.ts';
import { SYSMEX_KX21N_ORDER_CATALOG } from '../machines/sysmexKx21n/catalog.ts';
import { SYSMEX_KX21N_RESULT_METADATA } from '../machines/sysmexKx21n/resultMetadata.ts';
import { sysmexKx21nMachineId } from '../machines/sysmexKx21n/index.ts';
import { BIOLABO_KENZA_ORDER_CATALOG } from '../machines/biolaboKenza/catalog.ts';
import { biolaboKenzaMachineId } from '../machines/biolaboKenza/index.ts';
import type { CatalogAnalyteEntry, CatalogTestEntry, CatalogView } from '../types.ts';

// Creates a test that returns only one analyte/result.
function singleAnalyteTest(code: string, name: string, resultCode = code): CatalogTestEntry {
	return { code, name, analytes: [{ code: resultCode, name }] };
}

// Convert iFlash tests to the common catalog format.
const iflashTests: readonly CatalogTestEntry[] = IFLASH_3000_TESTS.map((t) =>
	// Orders use the test code, inbound ASTM results identify the channel.
	singleAnalyteTest(t.testCode, t.testName, String(t.channelNumber)) 
);

// Convert MAGLUMI tests to the common catalog format.
const maglumiTests: readonly CatalogTestEntry[] = MAGLUMI_800_ASSAYS.map((t) =>
	singleAnalyteTest(t.code, t.name)
);

// Convert cobas tests to the common catalog format.
const cobasTests: readonly CatalogTestEntry[] = COBAS_C111_CATALOG.map((t) =>
	singleAnalyteTest(t.hostCode, t.shortName)
);

// Convert Sysmex result metadata to the common analyte format.
// The KX-21N runs a single orderable panel that answers with every hematology
// parameter, so its one test carries the full result-metadata analyte list.
const sysmexAnalytes: readonly CatalogAnalyteEntry[] =
	SYSMEX_KX21N_RESULT_METADATA.map((analyte) => ({
		code: analyte.code,
		name: analyte.name,
		unit: analyte.unit,
	}));

// Sysmex returns multiple analytes/results for a single ordered test.
const sysmexTests: readonly CatalogTestEntry[] = SYSMEX_KX21N_ORDER_CATALOG.map((t) => ({
	code: t.code,
	name: t.name,
	analytes: sysmexAnalytes
}));

// Convert Kenza tests to the common catalog format.
// Each Kenza assay produces one numeric result on the wire, so test and analyte share the same code.
const kenzaTests: readonly CatalogTestEntry[] = BIOLABO_KENZA_ORDER_CATALOG.map(
	(t) => singleAnalyteTest(t.code, t.name),
);

// Convert DrAccu tests to the common catalog format.
// Publish accepted plain names, with the numeric result item ID.
// Batch duplicates stay in the reference catalog, not the order picker.
const drAccuTests: readonly CatalogTestEntry[] = [
	...new Map(DRACCU_AFI_6100B_CATALOG.map((test) => [
		test.item_name, singleAnalyteTest(test.item_name, test.item_name, test.item_id),
	])).values(),
];

// catalog manager
const CATALOGS: readonly CatalogView[] = [
	{
		id: iFlash3000MachineId,
		driverId: iFlash3000MachineId,
		machine: 'YHLO iFlash 3000',
		tests: iflashTests,
	},
	{
		id: maglumi800MachineId,
		driverId: maglumi800MachineId,
		machine: 'SNIBE MAGLUMI 800',
		tests: maglumiTests,
	},
	{
		id: rocheCobasC111MachineId,
		driverId: rocheCobasC111MachineId,
		machine: 'Roche cobas c111',
		tests: cobasTests,
	},
	{
		id: sysmexKx21nMachineId,
		driverId: sysmexKx21nMachineId,
		machine: 'Sysmex KX-21N',
		tests: sysmexTests,
	},
	{
		id: biolaboKenzaMachineId,
		driverId: biolaboKenzaMachineId,
		machine: 'BioLabo Kenza 240TX',
		tests: kenzaTests,
	},
	{
		id: drAccuAfi6100bMachineId,
		driverId: drAccuAfi6100bMachineId,
		machine: 'DrAccu AFI-6100B',
		tests: drAccuTests,
	},
];

// reuseable-helpers
export function findCatalog(value: string): CatalogView | undefined {
	const key = value.toLowerCase();
	return CATALOGS.find((catalog) =>
		catalog.id.toLowerCase() === key ||
		catalog.driverId.toLowerCase() === key ||
		catalog.machine.toLowerCase() === key
	);
}
export function listCatalogs(): Array<Record<string, unknown>> {
	return CATALOGS.map((catalog) => ({
		id: catalog.id,
		driverId: catalog.driverId,
		machine: catalog.machine,
		catalogCount: catalog.tests.length,
		// testCount: catalog.tests.length,
	}));
}

// response-helper
export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: defaultHeaders({
			'content-type': 'application/json; charset=utf-8',
		}),
	});
}

export function empty(status = 204): Response {
	return new Response(null, { status, headers: defaultHeaders() });
}

export class HttpError extends Error {
	constructor(message: string, readonly status = 400) {
		super(message);
		this.name = 'HttpError';
	}
}

export function defaultHeaders(headers: HeadersInit = {}): Headers {
	const result = new Headers(headers);
	result.set('access-control-allow-origin', '*');
	result.set('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
	result.set('access-control-allow-headers', 'content-type');
	return result;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function errorResponse(error: unknown): Response {
	if (error instanceof HttpError) {
		return json({ error: error.message }, error.status);
	}
	if (error instanceof z.ZodError) {
		return json({ error: z.prettifyError(error) }, 400);
	}

	return json({ error: 'internal error', detail: errorMessage(error) }, 500);
}
