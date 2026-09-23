/** Build the HL7 ORM order push accepted by the DrAccu AFI-6100B. */

import type { MachineOrder } from '../../types.ts';

let msgSeq = 0;

function nowStamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, '0');
	return (
		`${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
		`${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
	);
}

function nextId(prefix = 'DA'): string {
	msgSeq = (msgSeq + 1) % 1_000_000;
	return `${prefix}${nowStamp()}${String(msgSeq).padStart(6, '0')}`;
}

function clean(value?: string): string {
	return (value ?? '').replace(/[\r\n|]/g, ' ').trim();
}

function dob(value?: string): string {
	const digits = (value ?? '').replace(/\D/g, '');
	return digits.length >= 8 ? digits.slice(0, 8) : clean(value);
}

function sex(value?: string): string {
	const normalized = (value ?? '').trim().toUpperCase();
	if (normalized.startsWith('M')) return 'M';
	if (normalized.startsWith('F')) return 'F';
	if (normalized.startsWith('O')) return 'O';
	return clean(value);
}

function msh(messageType: string): string {
	return [
		'MSH',
		'^~\\&',
		'medicloud',
		'LIS',
		'AFI6100B',
		'DrAccu',
		nowStamp(),
		'',
		messageType,
		nextId(),
		'P',
		'2.3.1',
	].join('|');
}

function pid(order: MachineOrder): string {
	return [
		'PID',
		'1',
		'',
		clean(order.patientId),
		'',
		clean(order.patientName ?? ''),
		'',
		dob(order.dob),
		sex(order.sex),
	].join('|');
}

function orc(order: MachineOrder): string {
	return ['ORC', 'NW', clean(order.sampleId), clean(order.sampleId)].join(
		'|',
	);
}

function obr(order: MachineOrder, test: string, index: number): string {
	const testField = test.includes('^')
		? clean(test)
		: `${clean(test)}^${clean(test)}`;
	return [
		'OBR',
		String(index),
		clean(order.sampleId),
		clean(order.sampleId),
		testField,
		'R',
		'',
		nowStamp(),
		'',
		'',
		'',
		'',
		'',
		'',
		'',
		'',
		'',
		'',
		'',
		'',
		'',
		'',
		'',
		'',
		'O',
	].join('|');
}

export function buildOrm(order: MachineOrder): string {
	const segments = [msh('ORM^O01'), pid(order), orc(order)];
	order.tests.forEach((test, index) =>
		segments.push(obr(order, test, index + 1))
	);
	return segments.join('\r') + '\r';
}
