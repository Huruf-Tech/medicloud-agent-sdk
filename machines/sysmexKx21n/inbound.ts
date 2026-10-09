/** Parse Sysmex KX-21/KX-21N fixed-width, ASTM-style, and plain uploads. */

import type { MachineAnalyteResult, MachineResultEvent } from '../../types.ts';
import {
	astmField,
	type AstmRecord,
	parseAstmMessage,
	unescapeAstmText,
} from '../../protocols/astm/records.ts';
import { ASTM_CONTROL } from '../../protocols/astm/constants.ts';
import { findSysmexKx21nResultMetadata } from './resultMetadata.ts';

const CONTROL_TEXT = Object.fromEntries(
	Object.entries(ASTM_CONTROL).map(([key, value]) => [
		key,
		String.fromCharCode(value),
	]),
) as Record<keyof typeof ASTM_CONTROL, string>;

export type SysmexKx21nOutputFormat = 'auto' | 'kx-21n' | 'k-1000';
export type SysmexKx21nParsedFormat =
	| SysmexKx21nOutputFormat
	| 'astm'
	| 'plain';
export type SysmexKx21nDateOrder = 'ymd' | 'mdy' | 'dmy';

export interface SysmexKx21nParseOptions {
	readonly outputFormat: SysmexKx21nOutputFormat;
	readonly dateOrder: SysmexKx21nDateOrder;
	readonly stripSampleLeadingZeroes?: boolean;
}

export interface ParsedSysmexKx21nMessage {
	readonly kind: 'analysis' | 'qc' | 'other';
	readonly format: SysmexKx21nParsedFormat;
	readonly sampleCode?: string;
	readonly textCode?: string;
	readonly rawPayload: string;
	readonly result?: MachineResultEvent;
}

interface FieldDefinition {
	readonly code: string;
	readonly decimals: number;
	readonly integer?: boolean;
}

interface FixedLayout {
	readonly format: 'kx-21n' | 'k-1000';
	readonly payloadLength: number;
	readonly dateWidths: readonly [number, number, number];
	readonly sampleIdWidth: number;
	readonly hasReserve: boolean;
	readonly hasRdwSelect: boolean;
	readonly fields: readonly FieldDefinition[];
}

interface FixedHeader {
	readonly textCode: string;
	readonly blockNumber: string;
	readonly sampleCode: string;
	readonly dateParts: readonly [string, string, string];
	readonly sampleId: string;
	readonly dataFields: readonly string[];
}

const COMMON_FIELDS: readonly FieldDefinition[] = [
	{ code: 'WBC', decimals: 1 },
	{ code: 'RBC', decimals: 2 },
	{ code: 'HGB', decimals: 1 },
	{ code: 'HCT', decimals: 1 },
	{ code: 'MCV', decimals: 1 },
	{ code: 'MCH', decimals: 1 },
	{ code: 'MCHC', decimals: 1 },
	{ code: 'PLT', decimals: 0, integer: true },
	{ code: 'LYM%', decimals: 1 },
	{ code: 'MXD%', decimals: 1 },
	{ code: 'NEUT%', decimals: 1 },
	{ code: 'LYM#', decimals: 1 },
	{ code: 'MXD#', decimals: 1 },
	{ code: 'NEUT#', decimals: 1 },
];

const K1000_LAYOUT: FixedLayout = {
	format: 'k-1000',
	payloadLength: 119,
	dateWidths: [2, 2, 2],
	sampleIdWidth: 12,
	hasReserve: false,
	hasRdwSelect: true,
	fields: [
		...COMMON_FIELDS,
		{ code: 'RDW', decimals: 1 },
		{ code: 'PDW', decimals: 1 },
		{ code: 'MPV', decimals: 2 },
		{ code: 'P-LCR', decimals: 1 },
	],
};

const KX21N_LAYOUT: FixedLayout = {
	format: 'kx-21n',
	payloadLength: 129,
	dateWidths: [4, 2, 2],
	sampleIdWidth: 15,
	hasReserve: true,
	hasRdwSelect: false,
	fields: [
		...COMMON_FIELDS,
		{ code: 'RDW-SD', decimals: 1 },
		{ code: 'RDW-CV', decimals: 1 },
		{ code: 'PDW', decimals: 1 },
		{ code: 'MPV', decimals: 1 },
		{ code: 'P-LCR', decimals: 1 },
	],
};

export function parseSysmexKx21nPayload(
	payload: string,
	options: SysmexKx21nParseOptions,
): ParsedSysmexKx21nMessage {
	const astm = parseAstmUpload(payload, options);
	if (astm) return astm;

	const fixedPayload = stripFixedFrame(payload);
	const fixed = parseFixedUpload(fixedPayload, options);
	if (fixed.kind !== 'other' || looksLikeFixedPayload(fixedPayload)) {
		return fixed;
	}

	return parsePlainUpload(payload, options);
}

export function stripAstmFrameNumber(payload: string): string {
	let text = payload.startsWith(CONTROL_TEXT.STX)
		? payload.slice(1)
		: payload;
	const terminator = firstTerminatorIndex(text, 0);
	if (terminator !== -1) text = text.slice(0, terminator);
	return /^\d(?=[HPOQRLMC]\|)/.test(text) ? text.slice(1) : text;
}

export function looksLikeAstmPayload(payload: string): boolean {
	const text = stripAstmFrameNumber(payload).trimStart();
	return /^[HPOQRLMC]\|/.test(text) || /\r[HPOQRLMC]\|/.test(text);
}

function parseAstmUpload(
	raw: string,
	options: SysmexKx21nParseOptions,
): ParsedSysmexKx21nMessage | undefined {
	const text = extractAstmText(raw);
	if (!looksLikeAstmPayload(text)) return undefined;

	const records = parseAstmMessage(text);
	const resultRecords = records.filter((record) => record.type === 'R');
	if (resultRecords.length === 0) return undefined;

	const order = records.find((record) => record.type === 'O');
	const patient = records.find((record) => record.type === 'P');
	const sampleId = cleanSampleId(
		order ? astmField(order, 3) || astmField(order, 4) : '',
		options,
	);
	const patientId = patient
		? cleanText(astmField(patient, 4) || astmField(patient, 3))
		: '';
	const sample = sampleId || patientId || `UNKNOWN_${Date.now()}`;

	return {
		kind: 'analysis',
		format: 'astm',
		rawPayload: raw,
		result: {
			sampleId: sample,
			patientId: patientId || sample,
			payload: {
				results: resultRecords.map((record, index) =>
					parseAstmResult(record, index + 1)
				),
			},
			raw,
			receivedAt: new Date(),
		},
	};
}

function parseAstmResult(
	record: AstmRecord,
	fallbackIndex: number,
): MachineAnalyteResult {
	const code = astmCode(astmField(record, 3), fallbackIndex);
	return analyte({
		code,
		value: cleanText(astmField(record, 4)) || undefined,
		unit: cleanText(astmField(record, 5)) || undefined,
		flag: astmField(record, 7) || astmField(record, 8) || undefined,
	});
}

function parseFixedUpload(
	payload: string,
	options: SysmexKx21nParseOptions,
): ParsedSysmexKx21nMessage {
	const layout = selectLayout(payload, options.outputFormat);
	const base = { format: layout.format, rawPayload: payload } as const;
	if (
		!looksLikeFixedPayload(payload) || payload.length < layout.payloadLength
	) {
		return { ...base, kind: 'other' };
	}

	const header = parseFixedHeader(payload, layout);
	const identified = {
		...base,
		sampleCode: header.sampleCode,
		textCode: `${header.textCode}${header.blockNumber}`,
	};
	if (header.textCode !== 'D') return { ...identified, kind: 'other' };
	if (header.sampleCode === 'C') return { ...identified, kind: 'qc' };
	if (!['S', 'U'].includes(header.sampleCode.trim().toUpperCase())) {
		return { ...identified, kind: 'other' };
	}

	const completedAt = parseDate(header.dateParts, options.dateOrder);
	const sampleId = cleanSampleId(header.sampleId, options) ||
		`UNKNOWN_${Date.now()}`;
	return {
		...identified,
		kind: 'analysis',
		result: {
			sampleId,
			patientId: sampleId,
			payload: {
				results: layout.fields.map((field, index) =>
					parseFixedAnalyte(
						field,
						header.dataFields[index] ?? '',
						completedAt,
					)
				),
			},
			raw: `${CONTROL_TEXT.STX}${payload}${CONTROL_TEXT.ETX}`,
			receivedAt: new Date(),
		},
	};
}

function parsePlainUpload(
	raw: string,
	options: SysmexKx21nParseOptions,
): ParsedSysmexKx21nMessage {
	const results: MachineAnalyteResult[] = [];
	let sampleId = '';
	for (
		const line of raw.split(/\r?\n|\r/).map((value) => value.trim()).filter(
			Boolean,
		)
	) {
		const sample = line.match(
			/(?:SAMPLE|ID|NO)\s*[:=]\s*([A-Za-z0-9_-]+)/i,
		);
		if (sample) sampleId = cleanSampleId(sample[1], options);

		const match = line.match(
			/^([A-Za-z0-9#%.\-]+)\s*[:=,\t ]+\s*([-+]?\d+(?:\.\d+)?)\s*([A-Za-z0-9\/%^.\-]*)\s*([HLN]?)$/,
		);
		if (!match) continue;
		results.push(analyte({
			code: match[1],
			value: match[2],
			unit: match[3] || undefined,
			flag: match[4] || undefined,
		}));
	}

	if (results.length === 0) {
		return { kind: 'other', format: 'plain', rawPayload: raw };
	}
	const sample = sampleId || `UNKNOWN_${Date.now()}`;
	return {
		kind: 'analysis',
		format: 'plain',
		rawPayload: raw,
		result: {
			sampleId: sample,
			patientId: sample,
			payload: { results },
			raw,
			receivedAt: new Date(),
		},
	};
}

function parseFixedHeader(payload: string, layout: FixedLayout): FixedHeader {
	let offset = 0;
	const take = (length: number): string => {
		const value = payload.slice(offset, offset + length);
		offset += length;
		return value;
	};
	const textCode = take(1);
	const blockNumber = take(1);
	const sampleCode = take(1);
	const dateParts = layout.dateWidths.map((width) => take(width)) as [
		string,
		string,
		string,
	];
	take(1); // analysis information
	const sampleId = take(layout.sampleIdWidth);
	take(6); // PDA information
	if (layout.hasReserve) take(1);
	if (layout.hasRdwSelect) take(1);
	const dataFields = Array.from(
		{ length: layout.fields.length },
		() => take(5),
	);
	return {
		textCode,
		blockNumber,
		sampleCode,
		dateParts,
		sampleId,
		dataFields,
	};
}

function parseFixedAnalyte(
	field: FieldDefinition,
	raw: string,
	completedAt?: string,
): MachineAnalyteResult {
	const parsed = parseNumericField(raw, field.decimals, field.integer);
	return analyte({
		code: field.code,
		value: parsed.value,
		qualitative: parsed.qualitative,
		flag: parsed.flag,
		completedAt,
	});
}

function analyte(options: {
	code: string;
	value?: string;
	qualitative?: string;
	unit?: string;
	flag?: string;
	completedAt?: string;
}): MachineAnalyteResult {
	const catalog = findSysmexKx21nResultMetadata(options.code);
	return {
		assayNo: options.code,
		assayName: catalog?.name ?? options.code,
		resultType: 'F',
		value: options.value,
		qualitative: options.qualitative,
		unit: options.unit ?? catalog?.unit,
		abnormalFlag: normalizeFlag(options.flag),
		status: 'F',
		completedAt: options.completedAt,
	};
}

function parseNumericField(
	raw: string,
	decimals: number,
	integer = false,
): { value?: string; qualitative?: string; flag?: string } {
	const field = raw.padEnd(5, ' ');
	if (field.startsWith('*')) {
		return field.startsWith('*003')
			? { qualitative: 'OVR', flag: '>' }
			: { qualitative: 'ERR', flag: 'E' };
	}
	const digits = field.slice(0, 4).replace(/\s/g, '');
	const flag = field.slice(4, 5);
	if (!/^\d+$/.test(digits)) return { flag };
	const numeric = Number.parseInt(digits, 10);
	if (integer) return { value: String(numeric), flag };
	return {
		value: (numeric / Math.pow(10, decimals)).toFixed(decimals),
		flag,
	};
}

function selectLayout(
	payload: string,
	configured: SysmexKx21nOutputFormat,
): FixedLayout {
	if (configured === 'kx-21n') return KX21N_LAYOUT;
	if (configured === 'k-1000') return K1000_LAYOUT;
	return payload.length >= KX21N_LAYOUT.payloadLength
		? KX21N_LAYOUT
		: K1000_LAYOUT;
}

function stripFixedFrame(payload: string): string {
	const stx = payload.indexOf(CONTROL_TEXT.STX);
	const etx = payload.indexOf(CONTROL_TEXT.ETX, stx + 1);
	if (stx >= 0 && etx > stx) return payload.slice(stx + 1, etx);
	let text = payload;
	if (text.startsWith(CONTROL_TEXT.STX)) text = text.slice(1);
	if (text.endsWith(CONTROL_TEXT.ETX)) text = text.slice(0, -1);
	return text;
}

function looksLikeFixedPayload(payload: string): boolean {
	return payload.length >= 3 && payload[0] === 'D';
}

function cleanSampleId(
	value: string,
	options: SysmexKx21nParseOptions,
): string {
	let sample = cleanText(value).replace(/\s/g, '');
	if (options.stripSampleLeadingZeroes !== false) {
		sample = sample.replace(/^0+/, '');
	}
	return sample;
}

function cleanText(value: string): string {
	return unescapeAstmText(value.replace(/\0/g, '').trim());
}

function parseDate(
	parts: readonly [string, string, string],
	order: SysmexKx21nDateOrder,
): string | undefined {
	const values = parts.map((part) => part.trim());
	if (!values.every((part) => /^\d+$/.test(part))) return undefined;
	let year: string;
	let month: string;
	let day: string;
	if (order === 'ymd') [year, month, day] = values;
	else if (order === 'mdy') [month, day, year] = values;
	else [day, month, year] = values;
	if (year.length === 2) year = `${Number(year) >= 80 ? 19 : 20}${year}`;
	month = month.padStart(2, '0');
	day = day.padStart(2, '0');
	const monthNumber = Number(month);
	const dayNumber = Number(day);
	if (
		year.length !== 4 || monthNumber < 1 || monthNumber > 12 ||
		dayNumber < 1 || dayNumber > 31
	) {
		return undefined;
	}
	return `${year}-${month}-${day}T00:00:00.000Z`;
}

function astmCode(value: string, fallbackIndex: number): string {
	const code = value.split('^').map((part) => part.trim()).filter(Boolean).at(
		-1,
	);
	return code || value.trim() || `R${fallbackIndex}`;
}

function normalizeFlag(flag?: string): string {
	switch ((flag ?? '').trim().toUpperCase()) {
		case '':
		case '0':
		case 'N':
			return 'N';
		case '1':
		case 'H':
			return 'H';
		case '2':
		case 'L':
			return 'L';
		case '3':
			return '>';
		case '4':
			return '?';
		default:
			return flag?.trim() || 'N';
	}
}

function extractAstmText(raw: string): string {
	const frames: string[] = [];
	let offset = 0;
	while (offset < raw.length) {
		const stx = raw.indexOf(CONTROL_TEXT.STX, offset);
		if (stx === -1) break;
		const terminator = firstTerminatorIndex(raw, stx + 1);
		if (terminator === -1) break;
		frames.push(stripAstmFrameNumber(raw.slice(stx + 1, terminator)));
		offset = terminator + 1;
		if (/^[0-9A-Fa-f]{2}/.test(raw.slice(offset, offset + 2))) offset += 2;
		if (raw[offset] === '\r') offset++;
		if (raw[offset] === '\n') offset++;
	}
	if (frames.length > 0) return frames.join('');
	return [
		CONTROL_TEXT.ENQ,
		CONTROL_TEXT.EOT,
		CONTROL_TEXT.ACK,
		CONTROL_TEXT.NAK,
		CONTROL_TEXT.STX,
		CONTROL_TEXT.ETX,
		CONTROL_TEXT.ETB,
	].reduce(
		(text, control) => text.split(control).join(''),
		stripAstmFrameNumber(raw),
	);
}

function firstTerminatorIndex(value: string, from: number): number {
	const etx = value.indexOf(CONTROL_TEXT.ETX, from);
	const etb = value.indexOf(CONTROL_TEXT.ETB, from);
	if (etx === -1) return etb;
	if (etb === -1) return etx;
	return Math.min(etx, etb);
}
