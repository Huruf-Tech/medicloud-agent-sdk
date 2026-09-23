/**
 * Builds the Kenza Id8/Id9 order payload (LIS -> Analyzer) from a MachineOrder.
 *
 * The third fixed-width field is Kenza's configured Type label. Some Kenza
 * setups call it gender/species, others call it sample type. The receive screen
 * validates the literal value, so we prefer explicit species values and only
 * fall back to sex labels when no type was supplied.
 */

import type { MachineOrder } from '../../types.ts';
import { encodeKenzaOrder } from '../../protocols/serial/records.ts';
import { toKenzaTestCode } from './catalog.ts';

/**
 * Build the fixed-width wire payload for one order.
 *
 * @param order - the staged MachineOrder
 * @param patientIdWidth - 8 for Id8 variant, 9 for Id9 variant
 */
export function buildKenzaOrder(
	order: MachineOrder,
	patientIdWidth: 8 | 9,
): string {
	return encodeKenzaOrder(
		{
			patient_id: resolvePatientId(order),
			patient_name: order.patientName ?? '',
			species: resolveKenzaType(order),
			tests: order.tests.map(toKenzaTestCode),
		},
		{ patientIdWidth },
	);
}

function resolvePatientId(order: MachineOrder): string {
	return firstNonBlank(order.sampleId, order.patientId) ?? '';
}

function resolveKenzaType(order: MachineOrder): string {
	const explicitType = firstNonBlank(
		(order as unknown as Record<string, unknown>).kenzaType as string | undefined,
		order.species,
		order.sampleType,
	);
	if (explicitType) return normalizeKenzaType(explicitType);
	return normalizeKenzaType(order.sex ?? '');
}

function firstNonBlank(
	...values: Array<string | undefined>
): string | undefined {
	return values.find((v) => v !== undefined && v.trim() !== '')?.trim();
}

function normalizeKenzaType(value: string): string {
	const normalized = value.trim().toUpperCase().replace(/[^A-Z]/g, '');
	if (normalized === 'M' || normalized === 'MALE' || normalized === 'MAN') {
		return 'Man';
	}
	if (
		normalized === 'F' ||
		normalized === 'FEMALE' ||
		normalized === 'WOMAN' ||
		normalized === 'WOMEN'
	) {
		return 'Women';
	}
	if (
		normalized === 'C' ||
		normalized === 'CHILD' ||
		normalized === 'CHILDREN'
	) {
		return 'Children';
	}
	return value.trim();
}
