import type { MachineOrder } from '../../types.ts';
import {
	buildAstmRecord,
	escapeAstmText,
	joinAstmRepeats,
} from '../../protocols/astm/records.ts';
import { toMaglumiDeviceCode } from './catalog.ts';

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
		'PSWD',
		'Lis',
		'',
		'',
		'',
		'',
		'Maglumi User',
		'',
		'P',
		'E1394-97',
		nowStamp(),
	]);
}

function patientRecord(order: MachineOrder): string {
	const patientId = order.patientId ?? order.sampleId;
	return buildAstmRecord([
		'P',
		'1',
		'',
		escapeAstmText(patientId),
		escapeAstmText(patientId),
		escapeAstmText(order.patientName ?? ''),
		'',
		order.dob ?? '',
		order.sex ?? '',
	]);
}

function orderRecord(order: MachineOrder): string {
	const testField = joinAstmRepeats(
		order.tests.map((test) =>
			`^^^${escapeAstmText(toMaglumiDeviceCode(test))}`
		),
	);

	const fields: string[] = new Array(12).fill('');
	fields[0] = 'O';
	fields[1] = '1';
	fields[2] = escapeAstmText(order.sampleId);
	fields[3] = '';
	fields[4] = testField;
	fields[5] = 'R';
	fields[6] = nowStamp();
	fields[11] = 'A';
	return buildAstmRecord(fields);
}

function terminator(code = 'N'): string {
	return buildAstmRecord(['L', '1', code]);
}

export function buildMaglumiWorklistResponse(
	orders: readonly MachineOrder[],
): string[] {
	const records = [header()];
	for (const order of orders) {
		records.push(patientRecord(order), orderRecord(order));
	}
	records.push(terminator('N'));
	return records;
}

export function buildMaglumiNoOrderResponse(): string[] {
	return [header(), terminator('N')];
}
