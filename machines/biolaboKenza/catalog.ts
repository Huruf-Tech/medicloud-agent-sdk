/**
 * BioLabo Kenza 240TX test catalog, transcribed from the lab analyzer sheet.
 *
 * Each entry carries the slot number (1-20), the analyzer's 3-char test code
 * used on the wire (Id8/Id9 TEST_NAME field), the display name, and a list of
 * common aliases that the LIS order layer will accept when mapping inbound test
 * codes to the wire code.
 */

import type { CatalogTestEntry } from '../../types.ts';
import { managedCatalogTests } from '../../lib/catalogAccess.ts';

export interface KenzaCatalogEntry {
	readonly slot: number;
	readonly code: string;
	readonly name: string;
	readonly aliases: readonly string[];
}

export const BIOLABO_KENZA_MODELS = [
	'biolabo-kenza',
	// 'BioLabo Kenza 240TX',
	// 'Kenza 240TX',
] as const;

export const BIOLABO_KENZA_240TX_CATALOG: readonly KenzaCatalogEntry[] = [
	entry(1, 'UA2', 'Uric acid', ['URIC ACID', 'URIC_ACID', 'UA']),
	entry(2, 'CHO', 'Cholesterol', ['CHOL', 'CHOLESTEROL']),
	entry(3, 'TG2', 'Triglyceride', ['TG', 'TRIGLYCERIDE']),
	entry(4, 'UR4', 'Urea', ['UREA']),
	entry(5, 'CR2', 'Creatinine', ['CREAT', 'CREATININE']),
	entry(6, 'GL', 'Sugar', ['GLUCOSE', 'SUGAR', 'GLU']),
	entry(7, 'BT1', 'T.Bilirubine', ['TBIL', 'T BILIRUBIN', 'TOTAL BILIRUBIN']),
	entry(8, 'BD1', 'D.Bilirubine', [
		'DBIL',
		'D BILIRUBIN',
		'DIRECT BILIRUBIN',
	]),
	entry(9, 'AL2', 'GPT', ['ALT', 'GPT', 'ALANINE TRANSAMINASE']),
	entry(10, 'AS2', 'GOT', ['AST', 'GOT', 'ASPARTATE TRANSAMINASE']),
	entry(11, 'PH', 'Phosphorus', ['PHOS', 'PHOSPHORUS', 'PHOSPHATE']),
	entry(12, 'MG2', 'Magnesium', ['MG', 'MAGNESIUM']),
	entry(13, 'ALB', 'Albumin', ['ALBUMIN']),
	entry(14, 'AP2', 'Alk.Phos', ['ALP', 'ALK PHOS', 'ALKALINE PHOSPHATASE']),
	entry(15, 'FE1', 'Iron', ['FE', 'IRON']),
	entry(16, 'CP2', 'CKTotal', ['CK', 'CPK', 'CKTOTAL', 'CK TOTAL']),
	entry(17, 'TP2', 'Protein', ['TP', 'TOTAL PROTEIN', 'PROTEIN']),
	entry(18, 'CKM', 'CKMB', ['CK-MB', 'CKMB']),
	entry(19, 'CAA', 'Calcium', ['CA', 'CALCIUM']),
	entry(20, 'GGT', 'GammaGT', ['GAMMA GT', 'GAMMAGT', 'GGT']),
];

/**
 * HTTP catalog view: one CatalogTestEntry per assay.
 *
 * Each Kenza test produces a single numeric result on the wire, so the test
 * and its single analyte share the same code.
 */
export const BIOLABO_KENZA_ORDER_CATALOG: readonly CatalogTestEntry[] =
	BIOLABO_KENZA_240TX_CATALOG.map((e) => ({
		code: e.code,
		name: e.name,
		analytes: [{ code: e.code, name: e.name }],
	}));

/** Find a catalog entry by slot number, wire code, display name, or alias. */
export function findKenzaAssay(value: string): KenzaCatalogEntry | undefined {
	const normalized = normalizeCode(value);
	const slotNumber = Number(normalized);
	const test = managedCatalogTests('biolabo-kenza').find((entry) =>
		entry.slot === slotNumber ||
		normalizeCode(entry.code) === normalized ||
		normalizeCode(entry.name) === normalized ||
		(entry.aliases ?? []).some((alias) =>
			normalizeCode(alias) === normalized
		)
	);
	return test && {
		slot: test.slot ?? 0,
		code: test.code,
		name: test.name,
		aliases: test.aliases ?? [],
	};
}

/**
 * Resolve any orderable test identifier to the 3-char wire code the analyzer
 * expects in its TEST_NAME field. Falls back to the raw value uppercased and
 * trimmed if it is not found in the catalog.
 */
export function toKenzaTestCode(value: string): string {
	return findKenzaAssay(value)?.code ?? value.trim().toUpperCase();
}

function entry(
	slot: number,
	code: string,
	name: string,
	aliases: string[] = [],
): KenzaCatalogEntry {
	return { slot, code, name, aliases };
}

function normalizeCode(value: string): string {
	return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}
