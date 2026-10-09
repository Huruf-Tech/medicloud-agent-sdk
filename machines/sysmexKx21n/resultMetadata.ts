import { managedCatalogTests } from '../../lib/catalogAccess.ts';
import { sysmexKx21nMachineId } from './index.ts';

/** Metadata for analytes received in KX-21/KX-21N result records. */

export interface SysmexKx21nResultMetadata {
	readonly code: string;
	readonly name: string;
	readonly unit: string;
	readonly category: string;
	readonly decimals: number;
}

/**
 * Reference intervals are deliberately absent: they are laboratory-,
 * population-, age-, and sex-dependent, not universal analyzer constants.
 * RDW is retained for the legacy K-1000 layout, KX-21N reports RDW-SD/CV.
 */
export const SYSMEX_KX21N_RESULT_METADATA:
	readonly SysmexKx21nResultMetadata[] = [
		analyte('WBC', 'White Blood Cells', '10^3/uL', 'WBC', 1),
		analyte('RBC', 'Red Blood Cells', '10^6/uL', 'RBC', 2),
		analyte('HGB', 'Hemoglobin', 'g/dL', 'RBC', 1),
		analyte('HCT', 'Hematocrit', '%', 'RBC', 1),
		analyte('MCV', 'Mean Corpuscular Volume', 'fL', 'RBC Indices', 1),
		analyte('MCH', 'Mean Corpuscular Hemoglobin', 'pg', 'RBC Indices', 1),
		analyte(
			'MCHC',
			'Mean Corpuscular Hb Concentration',
			'g/dL',
			'RBC Indices',
			1,
		),
		analyte('PLT', 'Platelet Count', '10^3/uL', 'Platelet', 0),
		analyte('LYM%', 'Lymphocyte Percentage', '%', 'WBC Differential', 1),
		analyte('MXD%', 'Mixed Cell Percentage', '%', 'WBC Differential', 1),
		analyte('NEUT%', 'Neutrophil Percentage', '%', 'WBC Differential', 1),
		analyte('LYM#', 'Lymphocyte Count', '10^3/uL', 'WBC Differential', 1),
		analyte('MXD#', 'Mixed Cell Count', '10^3/uL', 'WBC Differential', 1),
		analyte('NEUT#', 'Neutrophil Count', '10^3/uL', 'WBC Differential', 1),
		analyte('RDW', 'Red Cell Distribution Width', '%', 'RBC Indices', 1),
		analyte(
			'RDW-SD',
			'Red Cell Distribution Width SD',
			'fL',
			'RBC Indices',
			1,
		),
		analyte(
			'RDW-CV',
			'Red Cell Distribution Width CV',
			'%',
			'RBC Indices',
			1,
		),
		analyte('PDW', 'Platelet Distribution Width', 'fL', 'Platelet', 1),
		analyte('MPV', 'Mean Platelet Volume', 'fL', 'Platelet', 1),
		analyte('P-LCR', 'Platelet Large Cell Ratio', '%', 'Platelet', 1),
	];

function analyte(
	code: string,
	name: string,
	unit: string,
	category: string,
	decimals: number,
): SysmexKx21nResultMetadata {
	return { code, name, unit, category, decimals };
}

export function findSysmexKx21nResultMetadata(
	code: string,
): SysmexKx21nResultMetadata | undefined {
	const analyte = managedCatalogTests(sysmexKx21nMachineId)
		.flatMap((test) => test.analytes)
		.find((entry) => entry.code === code);
	return analyte && {
		code: analyte.code,
		name: analyte.name,
		unit: analyte.unit ?? '',
		category: analyte.category ?? '',
		decimals: analyte.decimals ?? 0,
	};
}
