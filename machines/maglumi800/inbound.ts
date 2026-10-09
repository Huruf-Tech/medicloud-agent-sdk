import type {
	MachineAnalyteResult,
	MachineResultEvent,
	MachineResultType,
} from '../../types.ts';
import {
	astmComponents,
	astmField,
	type AstmRecord,
	unescapeAstmText,
} from '../../protocols/astm/records.ts';
import { findMaglumiAssay } from './catalog.ts';

export interface MaglumiMachineRef {
	readonly brand: 'SNIBE';
	readonly model: 'MAGLUMI 800';
	readonly serial: string;
	readonly address: string;
}

export interface MaglumiResultPayload {
	readonly machine: MaglumiMachineRef;
	readonly sampleId: string;
	readonly patientId?: string;
	readonly results: MachineAnalyteResult[];
	readonly raw: string;
	readonly receivedAt: Date;
}

export interface ParsedMaglumiMessage {
	readonly kind: 'query' | 'results' | 'other';
	readonly machine: MaglumiMachineRef;
	readonly querySampleId?: string;
	readonly queryAll?: boolean;
	readonly result?: MaglumiResultPayload;
}

export function rawMaglumiRecords(records: readonly AstmRecord[]): string {
	return records.map((record) => record.fields.join('|')).join('\r');
}

export function parseMaglumiMessage(
	records: readonly AstmRecord[],
	address: string,
	raw = rawMaglumiRecords(records),
): ParsedMaglumiMessage {
	const machine = machineRef(address);
	const query = records.find((record) => record.type === 'Q');
	if (query) {
		const filter = astmField(query, 3);
		return {
			kind: 'query',
			machine,
			querySampleId: normalizeQuerySample(filter),
			queryAll: isAllQuery(filter, astmField(query, 5)),
		};
	}

	const resultRecords = records.filter((record) => record.type === 'R');
	if (resultRecords.length > 0) {
		return {
			kind: 'results',
			machine,
			result: parseResults(records, machine, raw),
		};
	}

	return { kind: 'other', machine };
}

export function toMachineResult(
	payload: MaglumiResultPayload,
): MachineResultEvent {
	return {
		sampleId: payload.sampleId,
		patientId: payload.patientId,
		payload: { results: payload.results },
		raw: payload.raw,
		receivedAt: payload.receivedAt,
	};
}

function machineRef(address: string): MaglumiMachineRef {
	return { brand: 'SNIBE', model: 'MAGLUMI 800', serial: '', address };
}

function parseResults(
	records: readonly AstmRecord[],
	machine: MaglumiMachineRef,
	raw: string,
): MaglumiResultPayload {
	const order = records.find((record) => record.type === 'O');
	const patient = records.find((record) => record.type === 'P');
	const sampleId = order
		? unescapeAstmText(astmField(order, 3) || astmField(order, 4))
		: '';
	const patientId = patient
		? unescapeAstmText(astmField(patient, 4) || astmField(patient, 3))
		: '';

	return {
		machine,
		sampleId: sampleId || patientId || `UNKNOWN_${Date.now()}`,
		patientId: patientId || undefined,
		results: records.filter((record) => record.type === 'R').map(
			parseResultRecord,
		),
		raw,
		receivedAt: new Date(),
	};
}

function parseResultRecord(record: AstmRecord): MachineAnalyteResult {
	const assayToken = astmField(record, 3);
	const assayName = extractAssayName(assayToken);
	const catalog = findMaglumiAssay(assayName);
	const range = parseReferenceRange(
		astmField(record, 6) || catalog?.normalRange || '',
	);
	const status = astmField(record, 9) || 'F';

	return {
		assayNo: catalog?.code ?? assayName,
		assayName: catalog?.name ?? assayName,
		resultType: resultTypeFromStatus(status),
		value: astmField(record, 4) || undefined,
		unit: astmField(record, 5) || catalog?.unit || undefined,
		lowReference: range?.low,
		highReference: range?.high,
		abnormalFlag: astmField(record, 7) || undefined,
		status,
		completedAt: astmField(record, 13) || undefined,
	};
}

function extractAssayName(value: string): string {
	const parts = astmComponents(value).map((part) =>
		unescapeAstmText(part.trim())
	);
	for (let index = parts.length - 1; index >= 0; index--) {
		const part = parts[index];
		if (part && !/^\d+$/.test(part)) return part;
	}
	return unescapeAstmText(value.replace(/\^/g, '').trim()) || 'UNKNOWN';
}

function normalizeQuerySample(value: string): string | undefined {
	const cleaned = astmComponents(value)
		.map((part) => part.replace(/\$lc\$/ig, '').trim())
		.find((part) => part.length > 0 && !/^all$/i.test(part));
	return cleaned ? unescapeAstmText(cleaned) : undefined;
}

function isAllQuery(sampleFilter: string, requestedTests: string): boolean {
	const joined = `${sampleFilter}|${requestedTests}`.toUpperCase();
	return joined.includes('$LC$') || joined.includes('ALL');
}

function parseReferenceRange(
	value: string,
): { low?: string; high?: string } | undefined {
	const range = value.trim();
	if (range === '') return undefined;

	const toMatch = /^(.+?)\s+to\s+(.+)$/i.exec(range);
	if (toMatch) return rangeObject(toMatch[1], toMatch[2]);

	const dashIndex = range.indexOf('-', range.startsWith('-') ? 1 : 0);
	if (dashIndex > 0) {
		return rangeObject(
			range.slice(0, dashIndex),
			range.slice(dashIndex + 1),
		);
	}

	return undefined;
}

function rangeObject(
	lowRaw: string,
	highRaw: string,
): { low?: string; high?: string } | undefined {
	const low = lowRaw.trim();
	const high = highRaw.trim();
	return low || high
		? { low: low || undefined, high: high || undefined }
		: undefined;
}

function resultTypeFromStatus(status: string): MachineResultType {
	return status === 'I' ? 'I' : 'F';
}
