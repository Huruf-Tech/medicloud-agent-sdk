export const DRACCU_AFI_6100B_MODELS = [
	'DrAccu AFI-6100B',
	'AFI-6100B',
	'DrAccu Fluorescence Immunoassay Analyzer',
] as const;

export interface DrAccuAfi6100bCatalogEntry {
	item_id: string;
	item_name: string;
	order_code: string;
	batch_id?: string;
	batch_code?: string;
	unit?: string;
	reference_low?: string;
	reference_high?: string;
	source: 'client_screen' | 'observed_result';
	notes?: string;
}

function entry(
	itemId: string,
	itemName: string,
	batchId?: string,
	batchCode?: string,
	extra: Partial<DrAccuAfi6100bCatalogEntry> = {},
): DrAccuAfi6100bCatalogEntry {
	return {
		item_id: itemId,
		item_name: itemName,
		order_code: `${itemId}^${itemName}`,
		...(batchId ? { batch_id: batchId } : {}),
		...(batchCode ? { batch_code: batchCode } : {}),
		source: 'client_screen',
		...extra,
	};
}

/**
 * DrAccu AFI-6100B item catalog transcribed from the client's analyzer screens.
 *
 * The current working order flow is intentionally not coupled to this catalog:
 * the analyzer accepted plain item names such as "FRT", so this is exposed for
 * lookup/future mapping only. Batch-specific fields should be verified on the
 * analyzer before they are used for automatic batch selection.
 */
export const DRACCU_AFI_6100B_CATALOG: readonly DrAccuAfi6100bCatalogEntry[] = [
	entry('220', 'TES', '11', 'H2409011'),
	entry('220', 'TES', '13', 'H2504025'),
	entry('217', 'PROG', '12', 'H2409012'),
	entry('254', 'CA15-3', '28'),
	entry('232', 'CEA', '27'),
	entry('223', 'TT3', '3'),
	entry('217', 'PROG', '12', 'H2504012'),
	entry('242', 'HP Ag', '42', 'H25020020'),
	entry('173', 'PTH', '2', 'H2504020'),
	entry('168', 'CPT', '31', 'H24090940'),
	entry('167', 'C-P', '9', 'H25040256'),
	entry('218', 'AMH', '44', 'H25030025'),
	entry('174', 'Anti-CCP', '4', 'H25040114'),
	entry('168', 'CPT', '20'),
	entry('232', 'CEA', '15', 'H2511015'),
	entry('173', 'PTH', '73', 'H2502089'),
	entry('242', 'HP Ag', '21'),
	entry('220', 'TES', '23', 'H2502011'),
	entry('228', 'FRT', '26', 'H2502014'),
];

export function findDrAccuAfi6100bEntry(
	value: string,
): DrAccuAfi6100bCatalogEntry | undefined {
	const wanted = value.trim().toLowerCase();
	return DRACCU_AFI_6100B_CATALOG.find((test) =>
		test.item_id.toLowerCase() === wanted ||
		test.item_name.toLowerCase() === wanted ||
		test.order_code.toLowerCase() === wanted
	);
}
