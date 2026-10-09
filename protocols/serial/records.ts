/**
 * Kenza Id8/Id9 fixed-width string encoding/decoding (manual: String format).
 *
 * All fields are left-justified and space-padded to a fixed width with NO
 * separators between them. The payload is the part between STX and the BCC.
 *
 *   LIS -> Analyzer (order):  PatID(8/9) Name(30) Species(32) Test(3) x n
 *   Analyzer -> LIS (result): PatID(8/9) Name(30) Species(32) [Test(3) Result(9)] x n
 */

import { KENZA_ID8, KENZA_ID9 } from './constants.ts';

/** Truncate then right-pad with spaces to an exact fixed width. */
export function kenzaFixed(value: string, width: number): string {
	return value.slice(0, width).padEnd(width, ' ');
}

export interface KenzaIdFormat {
	patientIdWidth?: 8 | 9;
}

export interface KenzaId9Order {
	patient_id: string;
	patient_name: string;
	species: string;
	tests: string[];
}

export interface KenzaId9TestResult {
	name: string;
	result: string;
}

export interface KenzaId9Result {
	patient_id: string;
	patient_name: string;
	species: string;
	results: KenzaId9TestResult[];
}

/** Build the Id8/Id9 order payload (everything between STX and BCC). */
export function encodeKenzaOrder(
	order: KenzaId9Order,
	format: KenzaIdFormat = {},
): string {
	const widths = resolveFieldWidths(format);
	const head = kenzaFixed(order.patient_id, widths.PATIENT_ID) +
		kenzaFixed(order.patient_name, KENZA_ID9.PATIENT_NAME) +
		kenzaFixed(order.species, KENZA_ID9.SPECIES);
	const tests = order.tests
		.map((t) => kenzaFixed(t, KENZA_ID9.TEST_NAME))
		.join('');
	return head + tests;
}

/** Parse an Id8/Id9 result payload (everything between STX and BCC). */
export function decodeKenzaResult(
	payload: string,
	format: KenzaIdFormat = {},
): KenzaId9Result {
	const widths = resolveFieldWidths(format);
	let cursor = 0;

	const take = (n: number): string => {
		const s = payload.slice(cursor, cursor + n);
		cursor += n;
		return s;
	};

	const patient_id = take(widths.PATIENT_ID).trim();
	const patient_name = take(KENZA_ID9.PATIENT_NAME).trim();
	const species = take(KENZA_ID9.SPECIES).trim();

	const results: KenzaId9TestResult[] = [];
	const groupSize = KENZA_ID9.TEST_NAME + KENZA_ID9.TEST_RESULT;

	while (cursor + groupSize <= payload.length) {
		const name = take(KENZA_ID9.TEST_NAME).trim();
		const result = take(KENZA_ID9.TEST_RESULT).trim();
		if (name === '') continue;
		results.push({ name, result });
	}

	return { patient_id, patient_name, species, results };
}

function resolveFieldWidths(
	format: KenzaIdFormat,
): typeof KENZA_ID8 | typeof KENZA_ID9 {
	return format.patientIdWidth === 8 ? KENZA_ID8 : KENZA_ID9;
}
