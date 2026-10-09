import { ASTM_DELIMITER } from './constants.ts';

/** Escape sequences (applied to free-text field content). */
const ESCAPES: ReadonlyArray<[string, string]> = [
	['&', '&E&'], // escape char must be replaced first when encoding
	['|', '&F&'],
	['\\', '&R&'],
	['^', '&S&'],
];

/** A parsed record: the type id plus its raw field strings (field 1 = type id). */
export interface AstmRecord {
	readonly type: string;
	readonly fields:
		string[]; /** fields[0] is the record type id; fields[1] is ASTM field #2, and so on. */
}

export function escapeAstmText(value: string): string {
	let out = value;
	for (const [raw, escaped] of ESCAPES) {
		out = out.split(raw).join(escaped);
	}

	return out;
}

export function unescapeAstmText(value: string): string {
	let out = value;
	// Decode in reverse so the escape char is restored last.
	for (let index = ESCAPES.length - 1; index >= 0; index--) {
		const [raw, escaped] = ESCAPES[index];
		out = out.split(escaped).join(raw);
	}
	return out;
}

/** Split a single record line into its raw fields. */
export function parseAstmRecord(line: string): AstmRecord {
	const fields = line.split(ASTM_DELIMITER.FIELD);
	return { type: fields[0] ?? '', fields };
}

/** Split a full message (CR-separated) into records, ignoring blank lines. */
export function parseAstmMessage(text: string): AstmRecord[] {
	return text
		.split(/\r\n|\r|\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map(parseAstmRecord);
}

/** Read field #n (1-based per manual) from a record; "" if absent. */
export function astmField(record: AstmRecord, fieldNumber: number): string {
	return record.fields[fieldNumber - 1] ?? '';
}

/** Split a field into components on `^`. */
export function astmComponents(value: string): string[] {
	return value.split(ASTM_DELIMITER.COMPONENT);
}

/** Read component #c (1-based) of field #n (1-based). */
export function astmComponent(
	record: AstmRecord,
	fieldNumber: number,
	componentNumber: number,
): string {
	return astmComponents(
		astmField(record, fieldNumber),
	)[componentNumber - 1] ?? '';
}

/** Split a field into repeats on `\`. */
export function repeats(value: string): string[] {
	return value.split(ASTM_DELIMITER.REPEAT);
}

/** Build a record line from raw field strings (field 1 should be the type id). */
export function buildAstmRecord(
	fields: ReadonlyArray<string | number | undefined>,
): string {
	return fields.map((field) => field === undefined ? '' : String(field)).join(
		ASTM_DELIMITER.FIELD,
	);
}

/** Join component values with `^`. */
export function joinAstmComponents(
	...parts: ReadonlyArray<string | number | undefined>
): string {
	return parts.map((part) => part === undefined ? '' : String(part)).join(
		ASTM_DELIMITER.COMPONENT,
	);
}

/** Join repeat values with `\`. */
export function joinAstmRepeats(parts: readonly string[]): string {
	return parts.join(ASTM_DELIMITER.REPEAT);
}
