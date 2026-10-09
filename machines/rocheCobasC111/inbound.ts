import type { MachineAnalyteResult, MachineResultEvent } from '../../types.ts';
import {
	astmComponents,
	astmField,
	type AstmRecord,
	unescapeAstmText,
} from '../../protocols/astm/records.ts';
import { findCobasC111Assay } from './catalog.ts';

export interface CobasC111MachineRef {
	readonly brand: 'Roche';
	readonly model: 'cobas c111';
	readonly serial: string;
	readonly address: string;
}

export interface CobasC111ResultPayload {
	readonly machine: CobasC111MachineRef;
	readonly sampleId: string;
	readonly patientId?: string;
	readonly results: MachineAnalyteResult[];
	readonly raw: string;
	readonly receivedAt: Date;
}

export interface ParsedCobasC111Message {
	readonly kind: 'query' | 'results' | 'other';
	readonly machine: CobasC111MachineRef;
	readonly querySampleId?:
		string; /** Sample id the machine is querying for (kind === "query"). */
	readonly result?:
		CobasC111ResultPayload; /** Parsed results message (kind === "results"). */
}

export function rawCobasC111Records(records: readonly AstmRecord[]): string {
	return records.map((record) => record.fields.join('|')).join('\r');
}

export function parseCobasC111Message(
	records: readonly AstmRecord[],
	address: string,
	raw = rawCobasC111Records(records),
): ParsedCobasC111Message {
	const header = records.find((record) => record.type === 'H');
	const machine = machineFromHeader(header, address);
	const messageType = header ? astmField(header, 11) : '';
	const query = records.find((record) => record.type === 'Q');

	if (query && messageType.startsWith('TSREQ')) {
		return {
			kind: 'query',
			machine,
			querySampleId: extractSampleId(astmField(query, 3)),
		};
	}

	const resultRecords = records.filter((record) =>
		record.type === 'R' && hasResultValue(record)
	);
	if (resultRecords.length === 0) return { kind: 'other', machine };

	const order = records.find((record) => record.type === 'O');
	const patient = records.find((record) => record.type === 'P');
	const sampleId = order ? orderSampleId(order) : '';
	const patientId = patient
		? firstNonEmpty(astmField(patient, 4), astmField(patient, 3))
		: '';

	return {
		kind: 'results',
		machine,
		result: {
			machine,
			sampleId: unescapeAstmText(sampleId) || patientId ||
				`UNKNOWN_${Date.now()}`,
			patientId: patientId ? unescapeAstmText(patientId) : undefined,
			results: resultRecords.map(parseResultRecord),
			raw,
			receivedAt: new Date(),
		},
	};
}

export function toMachineResult(
	payload: CobasC111ResultPayload,
): MachineResultEvent {
	return {
		sampleId: payload.sampleId,
		patientId: payload.patientId,
		payload: { results: payload.results },
		raw: payload.raw,
		receivedAt: payload.receivedAt,
	};
}

function machineFromHeader(
	header: AstmRecord | undefined,
	address: string,
): CobasC111MachineRef {
	const sender = header ? astmField(header, 5) : '';
	const parts = astmComponents(sender).map((part) => part.trim()).filter(
		Boolean,
	);
	const serial = parts.find((part) => !/cobas|roche|c\s*111/i.test(part)) ??
		'';
	return { brand: 'Roche', model: 'cobas c111', serial, address };
}

function parseResultRecord(record: AstmRecord): MachineAnalyteResult {
	const testParts = astmComponents(astmField(record, 3)).map((part) =>
		unescapeAstmText(part.trim())
	);
	const assayToken = [...testParts].reverse().find(Boolean) || 'UNKNOWN';
	const catalog = findCobasC111Assay(assayToken);
	const resultParts = astmComponents(astmField(record, 4));
	const range = parseRange(
		firstNonEmpty(astmField(record, 6), astmField(record, 7)),
	);
	const status = firstNonEmpty(
		astmField(record, 9),
		astmField(record, 10),
		'F',
	);

	return {
		assayNo: catalog?.hostCode ?? assayToken,
		assayName: catalog?.shortName ?? assayToken,
		resultType: status === 'I' ? 'I' : 'F',
		value: resultParts[0] ? unescapeAstmText(resultParts[0]) : undefined,
		qualitative: resultParts[1]
			? unescapeAstmText(resultParts[1])
			: undefined,
		unit: astmField(record, 5) || undefined,
		lowReference: range?.low,
		highReference: range?.high,
		abnormalFlag:
			firstNonEmpty(astmField(record, 7), astmField(record, 8)) ||
			undefined,
		status,
		completedAt:
			firstNonEmpty(astmField(record, 13), astmField(record, 14)) ||
			undefined,
	} satisfies MachineAnalyteResult;
}

function hasResultValue(record: AstmRecord): boolean {
	const resultParts = astmComponents(astmField(record, 4)).map((part) =>
		unescapeAstmText(part.trim())
	);
	return resultParts.some((part) => part !== '');
}

function extractSampleId(value: string): string {
	const parts = astmComponents(value).map((part) =>
		unescapeAstmText(part.trim())
	).filter(Boolean);
	return parts.at(-1) ?? '';
}

function orderSampleId(order: AstmRecord): string {
	return firstNonEmpty(
		firstComponent(astmField(order, 4)),
		firstComponent(astmField(order, 3)),
		extractSampleId(astmField(order, 4)),
		extractSampleId(astmField(order, 3)),
	);
}

function firstComponent(value: string): string {
	return unescapeAstmText(astmComponents(value)[0]?.trim() ?? '');
}

function parseRange(
	value: string,
): { low?: string; high?: string } | undefined {
	const clean = value.trim();
	if (!clean) return undefined;

	const match = /^\s*([^\s]+)\s*(?:-|to)\s*([^\s]+)\s*$/i.exec(clean);
	if (!match) return undefined;

	return { low: match[1], high: match[2] };
}

function firstNonEmpty(...values: string[]): string {
	return values.find((value) => value.trim() !== '')?.trim() ?? '';
}
