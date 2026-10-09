/**
 * Builds the ASTM records the LIS sends back to an iFlash analyzer when it
 * host-queries for a sample (manual section 3.3.3 "LIS returns the query
 * result"). Report type is "Q" (query response).
 *
 * Record layout follows the manual's worked examples:
 *   H|\^&|||LabLIS|||||||QA|1394-97|<ts>
 *   P|1||<patient_id>||<name>||<dob>|<sex>
 *   O|1|<sample_id>|<sample_id>|<t1>^^^\<t2>^^^|R|...|<type>|...|Q|...
 *   L|1|N
 */

import type { MachineOrder } from '../../types.ts';
import {
	buildAstmRecord,
	escapeAstmText,
	joinAstmComponents,
	joinAstmRepeats,
} from '../../protocols/astm/records.ts';
import { iFlashVariantFromModel, requireIFlashTestEntry } from './catalog.ts';

function nowStamp(): string {
	const date = new Date();
	const pad = (value: number) => String(value).padStart(2, '0');

	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${
		pad(date.getDate())
	}` +
		`${pad(date.getHours())}${pad(date.getMinutes())}${
			pad(date.getSeconds())
		}`;
}

function header(): string {
	return buildAstmRecord([
		'H',
		'\\^&',
		'',
		'',
		'MediCloudLIS',
		'',
		'',
		'',
		'',
		'',
		'',
		'QA',
		'1394-97',
		nowStamp(),
	]);
}

function patientRecord(order: MachineOrder): string {
	return buildAstmRecord([
		'P',
		'1', // sequence number
		'', // practice assigned id
		escapeAstmText(order.patientId ?? order.sampleId), // #4 patient id / medical record no
		'', // #5
		escapePatientName(order.patientName ?? ''), // #6 name "LAST^FIRST",
		'', // #7
		order.dob ?? '', // #8 birth date YYYYMMDD
		order.sex ?? '', // #9 sex
	]);
}

function orderRecord(order: MachineOrder, model = 'YHLO iFlash 3000'): string {
	// Each test is "channel^name^dilution^flag". The instrument matches on the channel number (component 1) — NOT the test code.
	const variant = iFlashVariantFromModel(model);
	const tests = joinAstmRepeats(
		order.tests.map((code) => {
			const entry = requireIFlashTestEntry(code, variant);
			const channel = entry ? String(entry.channelNumber) : code;
			const name = entry ? entry.testName : code;
			return `${escapeAstmText(channel)}^${escapeAstmText(name)}^^`;
		}),
	);

	const fields: string[] = new Array(26).fill('');
	fields[0] = 'O';
	fields[1] = '1'; // #2 sequence number
	fields[2] = escapeAstmText(order.sampleId); // #3 sample number
	// fields[3] = escapeAstmText(order.sampleId); // #4 instrument specimen id (barcode)
	fields[3] = order.rackPosition
		? `${escapeAstmText(order.sampleId)}^${
			escapeAstmText(order.rackPosition)
		}`
		: escapeAstmText(order.sampleId);

	fields[4] = tests; // #5 ordered tests
	fields[5] = 'R'; // #6 priority (normal)
	fields[6] = nowStamp(); // #7 requested date/time

	fields[14] = order.rackPosition ? escapeAstmText(order.rackPosition) : ''; // ASTM Field #15: Specimen Location

	fields[15] = (order.sampleType ?? '').toLowerCase(); // #16 specimen type
	fields[25] = 'Q';

	return buildAstmRecord(fields);
}

/**
 * ASTM patient names use `^` between name components. Escape the text inside
 * each component while preserving those structural separators.
 */
function escapePatientName(value: string): string {
	return joinAstmComponents(
		...value.split('^').map((component) => escapeAstmText(component)),
	);
}

/** Records for a found order. */
export function buildIFlashOrderResponse(
	order: MachineOrder,
	model = 'YHLO iFlash 3000',
): string[] {
	return [
		header(),
		patientRecord(order),
		orderRecord(order, model),
		buildAstmRecord(['L', '1', 'N']),
	];
}

/** Records when no order exists for the queried sample (L code "I"). */
export function buildIFlashNoOrderResponse(): string[] {
	return [header(), buildAstmRecord(['L', '1', 'I'])];
}
