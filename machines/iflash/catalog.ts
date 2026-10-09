import { managedCatalogTests } from '../../lib/catalogAccess.ts';

export interface IFlashTestEntry {
	readonly testCode: string;
	readonly testName: string;
	readonly channelNumber: number;
	readonly isActive: boolean;
}

export const YHLO_IFLASH_3000_MODELS = [
	'yhlo-iflash-3000',
] as const;

export type IFlashVariant = '1800' | '3000';

const IFLASH_TESTS: IFlashTestEntry[] = [
	entry('ANA', 1),
	entry('dsDNA IgG', 2),
	entry('Anti-CCP', 12),
	entry('CL IgG', 14),
	entry('CL IgM', 15),
	entry('Anti-CL', 16),
	entry('B2-GP I IgG', 17),
	entry('Anti-B2-GP I', 18),
	entry('25-OH VitD', 29),
	entry('ACTH', 30),
	entry('AMH', 32),
	entry('Anti-Tg', 33),
	entry('Anti-TPO', 34),
	entry('CK-MB', 40),
	entry('Cortisol', 41),
	entry('C-Peptide', 42),
	entry('DHEA-S', 44),
	entry('E2', 45),
	entry('FSH', 47),
	entry('FT3', 48),
	entry('FT4', 49),
	entry('HCG', 50),
	entry('Insulin', 52),
	entry('LH', 53),
	entry('PCT', 57),
	entry('Progesterone', 60),
	entry('Prolactin', 61),
	entry('PTH', 62),
	entry('T3', 63),
	entry('T4', 64),
	entry('Testosterone', 65),
	entry('Tg', 66),
	entry('Troponin-I', 68),
	entry('TSH', 69),
	entry('AFP', 71),
	entry('CA125', 72),
	entry('CA15-3', 73),
	entry('CA19-9', 74),
	entry('CEA', 75),
	entry('Free PSA', 77),
	entry('TPSA', 79),
	entry('HBsAg', 80),
	entry('HBeAg', 81),
	entry('Anti-TP', 85),
	entry('Anti-HCV', 86),
	entry('HIV Combo', 87),
	entry('Toxo IgG', 102),
	entry('Toxo IgM', 103),
	entry('CMV IgG', 104),
	entry('CMV IgM', 105),
	entry('Rubella IgG', 106),
	entry('Rubella IgM', 107),
	entry('HA', 112),
	entry('Folate', 113),
	entry('Ferritin', 115),
	entry('Anti-TSHR', 118),
	entry('CL IgA', 119),
	entry('B2-GP I IgA', 120),
	entry('B2-GP I IgM', 121),
	entry('free BhCG', 122),
	entry('VB12 II', 148),
	entry('FT3_1', 331),
	entry('FSH_1', 332),
	entry('T3_1', 333),
	entry('T4_1', 334),
	entry('AFP_1', 336),
	entry('25-OH VitD_1', 337),
	entry('DHEA-S_1', 338),
	entry('FT4_1', 339),
	entry('PTH_1', 340),
	entry('CA19-9_1', 343),
	entry('CA125_1', 344),
	entry('Testo_1', 346),
	entry('C-Peptide_1', 347),
	entry('Troponin-I_1', 348),
	entry('Anti-CCP_1', 349),
	entry('NSE_1', 350),
	entry('HCG_1', 353),
	entry('Inhibin B_1', 354),
	entry('ACTH_1', 357),
	entry('Prolactin_1', 359),
	entry('Cortisol_1', 360),
	entry('dsDNA IgG_1', 361),
	entry('CL IgM_1', 363),
	entry('CL IgG_1', 364),
	entry('TSH_1', 368),
	entry('Insulin_1', 369),
	entry('PCT_1', 370),
	entry('Anti-TPO_1', 371),
	entry('ANA_1', 377),
	entry('E2_1', 378),
	entry('PROG_1', 379),
	entry('LH_1', 380),
	entry('Ferritin_1', 382),
	entry('VB12_1', 383),
	entry('CMV_M_1', 393),
	entry('Rubella_G_1', 394),
	entry('TPSA_1', 417),
	entry('Free PSA_1', 418),
	entry('CK-MB_1', 489),
	entry('CA15-3_1', 490),
];

export const IFLASH_1800_TESTS: readonly IFlashTestEntry[] = IFLASH_TESTS;
export const IFLASH_3000_TESTS: readonly IFlashTestEntry[] = IFLASH_TESTS.map((
	test,
) => ({
	...test,
}));

export function iFlashVariantFromModel(model: string): IFlashVariant {
	return model.includes('3000') ? '3000' : '1800';
}

export function findIFlashTestEntry(
	testCode: string,
	variant: IFlashVariant = '3000',
): IFlashTestEntry | undefined {
	const test = managedCatalogTests('iflash3000').find((entry) =>
		entry.code === testCode && entry.enabled !== false
	);
	if (!test) return undefined;
	const channelNumber = Number(test.analytes[0]?.code);
	if (!Number.isSafeInteger(channelNumber) || channelNumber <= 0) {
		throw new Error(
			`iFlash ${variant} test "${testCode}" needs a numeric channel analyte.`,
		);
	}
	return {
		testCode: test.code,
		testName: test.name,
		channelNumber,
		isActive: true,
	};
}

/** Return the configured analyzer channel or reject an unsupported test code. */
export function requireIFlashTestEntry(
	testCode: string,
	variant: IFlashVariant = '3000',
): IFlashTestEntry {
	const entry = findIFlashTestEntry(testCode, variant);
	if (!entry) {
		throw new Error(
			`iFlash ${variant} does not support test code "${testCode}".`,
		);
	}
	return entry;
}

function entry(
	testCode: string,
	channelNumber: number,
): IFlashTestEntry {
	return {
		testCode,
		testName: testCode,
		channelNumber,
		isActive: true,
	};
}
