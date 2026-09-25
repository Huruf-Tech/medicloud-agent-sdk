import type { MachineResultEvent } from '../../types.ts';
import { decodeKenzaResult } from '../../protocols/serial/records.ts';
import { findKenzaAssay } from './catalog.ts';

/**
 * Normalize a Kenza fixed-width numeric result string.
 *
 * The Kenza 240 TX transmits results in a 9-character field with a display mask
 * like `000.000`, so a value of 0.5 arrives as `"000.500"` and zero as
 * `"000.000"`. This strips unnecessary leading/trailing zeros to produce a
 * clean numeric string:
 *   "000.500" → "0.5"
 *   "012.340" → "12.34"
 *   "000.000" → "0"
 *   "100.000" → "100"
 *   ""        → ""
 *   "NEG"     → "NEG"  (non-numeric values passed through untouched)
 */
function normalizeNumericResult(raw: string): string {
	if (!raw) return raw;

	// Only normalize strings that look like a number (digits, optional dot, optional leading sign)
	if (!/^[+-]?\d+(\.\d+)?$/.test(raw)) return raw;

	const num = parseFloat(raw);
	if (Number.isNaN(num)) return raw;

	return String(num);
}

/**
 * Parse a raw Kenza wire payload into a normalized MachineResultEvent.
 *
 * @param payload - raw string received between STX and BCC
 * @param patientIdWidth - 8 for Id8 variant, 9 for Id9 variant
 */
export function parseKenzaPayload(
	payload: string,
	patientIdWidth: 8 | 9,
): MachineResultEvent {
	const parsed = decodeKenzaResult(payload, { patientIdWidth });

	return {
		sampleId: parsed.patient_id,
		patientId: parsed.patient_id,
		payload: {
			results: parsed.results.map((r) => {
				const entry = findKenzaAssay(r.name);
				return {
					assayNo: entry?.code ?? r.name,
					assayName: entry?.name ?? r.name,
					resultType: 'F' as const,
					value: normalizeNumericResult(r.result),
				};
			}),
		},
		raw: payload,
		receivedAt: new Date(),
	};
}
