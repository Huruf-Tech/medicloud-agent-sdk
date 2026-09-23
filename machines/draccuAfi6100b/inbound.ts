/** Field mapping from the tested AFI-6100B R-line parser. */
import type { MachineResultEvent } from '../../types.ts';

export function parseDrAccuResultLine(raw: string): MachineResultEvent {
	const fields = raw.trim().split('|');
	const sampleId = clean(fields[1]) || `UNKNOWN_${Date.now()}`;
	const assayNo = clean(fields[2]) || clean(fields[3]) || 'UNKNOWN';
	const resultText = clean(fields[10]);
	return {
		sampleId,
		payload: {
			results: [{
				assayNo,
				assayName: clean(fields[3]) || assayNo,
				resultType: 'F',
				value: clean(fields[8]) || undefined,
				unit: clean(fields[9]) || undefined,
				lowReference: clean(fields[6]) || undefined,
				highReference: clean(fields[5]) || undefined,
				abnormalFlag: resultText || undefined,
				qualitative: resultText || undefined,
				status: resultText || 'F',
				completedAt: parseTimestamp(clean(fields[11])),
			}],
		},
		raw,
		receivedAt: new Date(),
	};
}

function clean(value?: string): string {
	return (value ?? '').trim();
}

function parseTimestamp(value: string): string | undefined {
	const digits = value.replace(/\D/g, '');
	if (digits.length < 14) return undefined;
	return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T${
		digits.slice(8, 10)
	}:${digits.slice(10, 12)}:${digits.slice(12, 14)}`;
}
