import { managedCatalogTests } from '../../lib/catalogAccess.ts';

export interface MaglumiAssay {
	readonly code: string;
	readonly name: string;
	readonly deviceCode: string;
	readonly unit: string;
	readonly normalRange: string;
	readonly category: string;
	readonly aliases?: readonly string[];
}

export const MAGLUMI_800_MODELS = [
	'snibe-maglumi-800',
	// 'SNIBE MAGLUMI 800',
	// 'MAGLUMI 800',
	// 'Maglumi 800',
] as const;

export const MAGLUMI_800_ASSAYS: readonly MaglumiAssay[] = [
	assay('T-B HCG II', 'T-B HCG II', 'mIU/mL', '0 - 7.105', 'Fertility', [
		'T-B HCG',
		'HCG/B-HCG',
		'HCG/B-HCG II',
	]),
	assay('Vit B12', 'Vit B12', 'pg/mL', '', 'Vitamins'),
	assay('Vit B12 II', 'Vit B12 II', 'pg/mL', '192 to 827', 'Vitamins', [
		'VB12 II',
	]),
	assay('25-OH VD II', '25-OH VD II', 'ng/mL', '30 to 100', 'Vitamins', [
		'25-OH VD',
		'25-OH Vitamin D II',
	]),
	assay('AMH II', 'AMH II', '', '', 'Fertility'),
	assay('BGW', 'BGW', '', '', 'Other'),
	assay('D-dimer', 'D-dimer', '', '', 'Coagulation', ['D-Dimer']),
	assay('D-Dimer II', 'D-Dimer II', '', '', 'Coagulation', [
		'D-dimer II',
	]),
	assay('E2', 'E2', '', '', 'Hormone'),
	assay('E2 II', 'E2 II', '', '', 'Hormone'),
	assay('Ferritin', 'Ferritin', 'ng/mL', '', 'Anemia'),
	assay('Ferritin II', 'Ferritin II', 'ng/mL', '7 to 425', 'Anemia'),
	assay('fPSA II', 'fPSA II', '', '', 'Tumor Marker', [
		'F-PSA',
		'Free PSA II',
	]),
	assay('FSH', 'FSH', '', '', 'Hormone'),
	assay('FSH II', 'FSH II', '', '', 'Hormone'),
	assay('FT3', 'FT3', '', '', 'Thyroid'),
	assay('FT3 II', 'FT3 II', '', '', 'Thyroid'),
	assay('FT4 II', 'FT4 II', '', '', 'Thyroid'),
	assay('H. pylori IgG II', 'H. pylori IgG II', '', '', 'Infectious'),
	assay('H. pylori IgM I', 'H. pylori IgM I', '', '', 'Infectious'),
	assay('IgA(S)', 'IgA(S)', '', '', 'Immunology'),
	assay('IgA(U)', 'IgA(U)', '', '', 'Immunology'),
	assay('IgE II', 'IgE II', '', '', 'Immunology'),
	assay('IgG(S)', 'IgG(S)', '', '', 'Immunology'),
	assay('IgG(U)', 'IgG(U)', '', '', 'Immunology'),
	assay('INS II', 'INS II', '', '', 'Diabetes', ['Insulin II']),
	assay('LC-k', 'LC-k', '', '', 'Immunology', ['LC k', 'LC-kappa']),
	assay('LC-l', 'LC-l', '', '', 'Immunology', [
		'LC lambda',
		'LC-lambda',
	]),
	assay('LH', 'LH', '', '', 'Hormone'),
	assay('LH II', 'LH II', '', '', 'Hormone'),
	assay('PRL', 'PRL', '', '', 'Hormone'),
	assay('PRL II', 'PRL II', '', '', 'Hormone'),
	assay('PROG', 'PROG', '', '', 'Hormone'),
	assay('PROG II', 'PROG II', '', '', 'Hormone'),
	assay('PSA', 'PSA', '', '', 'Tumor Marker'),
	assay('PTH II', 'PTH II', '', '', 'Bone'),
	assay('T3', 'T3', '', '', 'Thyroid'),
	assay('T4', 'T4', '', '', 'Thyroid'),
	assay('TEST', 'TEST', '', '', 'Hormone'),
	assay('TEST II', 'TEST II', '', '', 'Hormone'),
	assay('Troponin I', 'Troponin I', '', '', 'Cardiac'),
	assay('TSH', 'TSH', '', '', 'Thyroid'),
	assay('TSH II', 'TSH II', '', '', 'Thyroid'),
	assay('TT3 II', 'TT3 II', '', '', 'Thyroid'),
	assay('TT4 II', 'TT4 II', '', '', 'Thyroid'),
	assay('tPSA II', 'tPSA II', '', '', 'Tumor Marker', ['TPSA II']),
];

export function findMaglumiAssay(code: string): MaglumiAssay | undefined {
	const wanted = normalize(code);
	const test = managedCatalogTests('snibe-maglumi-800').find((entry) =>
		normalize(entry.code) === wanted ||
		normalize(entry.name) === wanted ||
		normalize(entry.deviceCode ?? entry.name) === wanted ||
		(entry.aliases ?? []).some((alias) => normalize(alias) === wanted)
	);
	return test && {
		code: test.code,
		name: test.name,
		deviceCode: test.deviceCode ?? test.name,
		unit: test.unit ?? '',
		normalRange: test.normalRange ?? '',
		category: test.category ?? '',
		aliases: test.aliases,
	};
}

export function toMaglumiDeviceCode(code: string): string {
	return findMaglumiAssay(code)?.deviceCode ?? code.trim();
}

function assay(
	code: string,
	name: string,
	unit: string,
	normalRange: string,
	category: string,
	aliases: readonly string[] = [],
): MaglumiAssay {
	return {
		code,
		name,
		deviceCode: name,
		unit,
		normalRange,
		category,
		aliases,
	};
}

function normalize(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, ' ');
}
