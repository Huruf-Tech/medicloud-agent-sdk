import type { MachineOrder } from '../../types.ts';
import { toCobasC111HostCode } from './catalog.ts';

export interface CobasC111HostSettings {
	readonly hostSenderName: string;
	readonly analyzerName: string;
	readonly defaultComment: string;
}

const DEFAULT_SETTINGS: CobasC111HostSettings = {
	hostSenderName: 'ASTM-Host',
	analyzerName: 'c111',
	defaultComment: 'Default TS',
};

export function buildCobasC111OrderResponse(
	order: MachineOrder,
	settings: CobasC111HostSettings = DEFAULT_SETTINGS,
): string[] {
	return [
		header('TSDWN^REPLY', settings),
		'P|1',
		orderRecord(order, 'O\\Q'),
		comment(settings),
		'L|1|N',
	];
}

export function buildCobasC111BatchOrder(
	order: MachineOrder,
	settings: CobasC111HostSettings = DEFAULT_SETTINGS,
): string[] {
	return [
		header('TSDWN^BATCH', settings),
		orderRecord(order, 'O'),
		'L|1|N',
	];
}

export function buildCobasC111NoOrderResponse(
	sampleId: string,
	settings: CobasC111HostSettings = DEFAULT_SETTINGS,
): string[] {
	return [
		header('TSDWN^REPLY', settings),
		'P|1',
		noOrderRecord(sampleId),
		'L|1|N',
	];
}

export function buildCobasC111ResultQuery(
	sampleId: string,
	settings: CobasC111HostSettings = DEFAULT_SETTINGS,
): string[] {
	return [
		header('RSREQ^REAL', settings),
		`Q|1|^${cleanAscii(sampleId)}||ALL||||||||F`,
		'L|1|N',
	];
}

export function buildCobasC111InventoryQuery(
	diskId = '0',
	settings: CobasC111HostSettings = DEFAULT_SETTINGS,
): string[] {
	const analyzer = cleanAscii(
		settings.analyzerName || DEFAULT_SETTINGS.analyzerName,
	);
	return [
		header('INR^U06', settings),
		`M|1|EQU|${analyzer}`,
		`M|1|INV|||||${cleanAscii(diskId)}`,
		'L|1|N',
	];
}

function header(
	messageType: 'TSDWN^REPLY' | 'TSDWN^BATCH' | 'RSREQ^REAL' | 'INR^U06',
	settings = DEFAULT_SETTINGS,
): string {
	const sender = cleanAscii(
		settings.hostSenderName || DEFAULT_SETTINGS.hostSenderName,
	);
	const analyzer = cleanAscii(
		settings.analyzerName || DEFAULT_SETTINGS.analyzerName,
	);
	return `H|\\^&|||${sender}|||||${analyzer}|${messageType}|P|1|${nowStamp()}`;
}

function comment(settings = DEFAULT_SETTINGS): string {
	const text = cleanAscii(
		settings.defaultComment || DEFAULT_SETTINGS.defaultComment,
	);
	return `C|1|L|${text}^^^^|G`;
}

function orderRecord(
	order: MachineOrder,
	reportType: 'O' | 'O\\Q',
	actionCode: 'A' | 'C' = 'A',
): string {
	const tests = [
		...new Set(
			order.tests
				.map((test) => cleanAscii(toCobasC111HostCode(test)))
				.filter(Boolean),
		),
	].map((test) => `^^^${test}`).join('\\');
	const sampleId = cleanAscii(order.sampleId);
	return `O|1|${sampleId}||${tests}|R||||||${actionCode}||||||||||||||${reportType}`;
}

function noOrderRecord(sampleId: string): string {
	return `O|1|${cleanAscii(sampleId)}|||||||||||A||||||||||||||Z`;
}

function nowStamp(): string {
	const date = new Date();
	const two = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}${two(date.getMonth() + 1)}${
		two(date.getDate())
	}` +
		`${two(date.getHours())}${two(date.getMinutes())}${
			two(date.getSeconds())
		}`;
}

function cleanAscii(value: string): string {
	return String(value ?? '').trim().replace(/[^\x20-\x7E]/g, '');
}
