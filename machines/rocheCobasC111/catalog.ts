import { managedCatalogTests } from '../../lib/catalogAccess.ts';

export interface CobasC111CatalogEntry {
	readonly hostCode: string;
	readonly appCode: string;
	readonly shortName: string;
	readonly aliases?: readonly string[];
}

export const COBAS_C111_MODELS = [
	'roche-cobas-c111',
	// 'Roche cobas c111',
	// 'Roche cobas c 111',
	// 'cobas c111',
	// 'cobas c 111',
] as const;

// The analyzer screenshots show HostCode and AppCode currently identical for
// this site setup. We keep both fields so future sites can diverge cleanly.
export const COBAS_C111_CATALOG: readonly CobasC111CatalogEntry[] = [
	assay('158', '158', 'ALP2S'),
	assay('571', '571', 'AMY-P'),
	assay('687', '687', 'ASTL'),
	assay('734', '734', 'BILD2'),
	assay('698', '698', 'CA2'),
	assay('550', '550', 'CK2'),
	assay('690', '690', 'CREJ2'),
	assay('767', '767', 'GLU2', ['GLUC4']),
	assay('454', '454', 'HDLC4', ['HDLC3']),
	assay('552', '552', 'LDLC3'),
	assay('701', '701', 'MG-2'),
	assay('714', '714', 'PHOS2'),
	assay('227', '227', 'TP2M'),
	assay('781', '781', 'TRIGL'),
	assay('433', '433', 'CHO2A', ['CHOZA']),
	assay('418', '418', 'UREL'),
	assay('700', '700', 'UA2'),
	assay('546', '546', 'CKMB2'),
	assay('661', '661', 'IRON2'),
	assay('685', '685', 'ALTL'),
	assay('256', '256', 'CRP4'),
];

export function isCobasC111Model(machine: string): boolean {
	return COBAS_C111_MODELS.includes(
		machine as typeof COBAS_C111_MODELS[number],
	);
}

export function findCobasC111Assay(
	value: string,
): CobasC111CatalogEntry | undefined {
	const wanted = normalize(value);
	const test = managedCatalogTests('roche-cobas-c111').find((entry) =>
		normalize(entry.code) === wanted ||
		normalize(entry.deviceCode ?? entry.code) === wanted ||
		normalize(entry.name) === wanted ||
		(entry.aliases ?? []).some((alias) => normalize(alias) === wanted)
	);
	return test && {
		hostCode: test.code,
		appCode: test.deviceCode ?? test.code,
		shortName: test.name,
		aliases: test.aliases,
	};
}

export function toCobasC111HostCode(value: string): string {
	return findCobasC111Assay(value)?.hostCode ?? value.trim();
}

function assay(
	hostCode: string,
	appCode: string,
	shortName: string,
	aliases: readonly string[] = [],
): CobasC111CatalogEntry {
	return { hostCode, appCode, shortName, aliases };
}

function normalize(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, ' ');
}
