import type {
	MachineAnalyteResult,
	MachineResultEvent,
	MachineResultType,
} from '../../types.ts';
import {
	astmComponent,
	astmComponents,
	astmField,
	type AstmRecord,
	unescapeAstmText,
} from '../../protocols/astm/records.ts';

export interface IFlashMachineRef {
	readonly brand: 'YHLO';
	readonly model: string;
	readonly serial: string;
	readonly address: string;
}

// export type ResultType = MachineResultType;

export interface IFlashResultPayload {
	readonly machine: IFlashMachineRef;
	readonly sampleId: string;
	readonly patientId?: string;
	readonly results: MachineAnalyteResult[];
	readonly raw: string;
	readonly receivedAt: Date;
}

export interface ParsedIFlashMessage {
	readonly kind: 'query' | 'results' | 'other';
	readonly machine: IFlashMachineRef;
	readonly querySampleId?:
		string; /** Sample id the machine is querying for (kind === "query"). */
	readonly result?:
		IFlashResultPayload; /** Parsed results message (kind === "results"). */
}

export function rawIFlashRecords(records: readonly AstmRecord[]): string {
	return records.map((record) => record.fields.join('|')).join('\r\n');
}

export function normalizeIFlashModel(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed === '') return '';

	const compact = trimmed.toLowerCase().replace(/[^a-z0-9]/g, '');
	if (compact.includes('iflash3000')) return 'YHLO iFlash 3000';
	if (compact.includes('iflash1800')) return 'YHLO iFlash 1800';
	if (compact.includes('iflash')) return `YHLO ${trimmed}`;
	return trimmed;
}

export function parseIFlashMessage(
	records: readonly AstmRecord[],
	address: string,
	raw = rawIFlashRecords(records),
): ParsedIFlashMessage {
	const header = records.find((record) => record.type === 'H');
	const machine = machineFromHeader(header, address);

	const queryRecord = records.find((record) => record.type === 'Q');
	if (queryRecord) {
		const specimenId = astmComponent(queryRecord, 3, 2);
		const startNumber = astmComponent(queryRecord, 3, 1);
		return {
			kind: 'query',
			machine,
			querySampleId: unescapeAstmText(specimenId || startNumber),
		};
	}

	const resultRecords = records.filter((record) => record.type === 'R');
	if (resultRecords.length > 0) {
		const orderRecord = records.find((record) => record.type === 'O');
		const patientRecord = records.find((record) => record.type === 'P');
		const sampleId = orderRecord
			? unescapeAstmText(
				astmField(orderRecord, 4) || astmComponent(orderRecord, 3, 1),
			)
			: '';
		const patientId = patientRecord
			? unescapeAstmText(astmField(patientRecord, 4))
			: undefined;

		return {
			kind: 'results',
			machine,
			result: {
				machine,
				sampleId,
				patientId: patientId || undefined,
				results: resultRecords.map(parseResultRecord),
				raw,
				receivedAt: new Date(),
			},
		};
	}

	return { kind: 'other', machine };
}

export function toMachineResult(
	payload: IFlashResultPayload,
): MachineResultEvent {
	return {
		sampleId: payload.sampleId,
		patientId: payload.patientId,
		payload: { results: payload.results },
		raw: payload.raw,
		receivedAt: payload.receivedAt,
	};
}

/**
 * Identity from the H record sender field (manual 3.2.1 documents it as
 * "model^version^serial", but real iFlash units send the vendor first, e.g.
 * "YHLO^iFlash3000^123456"). Rather than trust a fixed position, scan every
 * component.
 */
function machineFromHeader(
	header: AstmRecord | undefined,
	address: string,
): IFlashMachineRef {
	const sender = header ? astmField(header, 5) : '';
	const parts = astmComponents(sender)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);

	let model = '';
	let serial = '';
	for (const part of parts) {
		const normalized = normalizeIFlashModel(part);
		if (normalized.toLowerCase().includes('iflash')) {
			model = normalized;
			continue;
		}
		if (/^yhlo$/i.test(part)) continue;
		if (/^\d+(\.\d+)+$/.test(part)) continue;
		if (serial === '') serial = part;
	}

	return { brand: 'YHLO', model, serial, address };
}

function parseResultRecord(record: AstmRecord): MachineAnalyteResult {
	const [assayNo = '', assayName = '', , resultType = 'F'] = astmComponents(
		astmField(record, 3),
	);
	const [value = '', qualitative = ''] = astmComponents(astmField(record, 4));
	const [low = '', high = ''] = astmComponents(astmField(record, 7));

	return {
		assayNo: unescapeAstmText(assayNo),
		assayName: assayName ? unescapeAstmText(assayName) : undefined,
		resultType: isResultType(resultType) ? resultType : 'F',
		value: value ? unescapeAstmText(value) : undefined,
		qualitative: qualitative ? unescapeAstmText(qualitative) : undefined,
		unit: astmField(record, 5) || undefined,
		lowReference: low || undefined,
		highReference: high || undefined,
		abnormalFlag: astmField(record, 8) || undefined,
		status: astmField(record, 10) || undefined,
		completedAt: astmField(record, 14) || undefined,
	};
}

function isResultType(value: string): value is MachineResultType {
	return value === 'I' || value === 'F' || value === 'B';
}
