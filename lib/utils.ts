import { SerialFlowControl } from '../types.ts';
import { dirname, resolve } from 'node:path';

export function helperPath(serialPath: string): string {
	const url = new URL(serialPath ?? './node-serial.mjs', import.meta.url);
	const path = decodeURIComponent(url.pathname);
	return Deno.build.os === 'windows'
		? path.replace(/^\/([A-Za-z]:)/, '$1')
		: path;
}

export function dataBitsValue(dataBits: number): 5 | 6 | 7 | 8 {
	if (dataBits === 5 || dataBits === 6 || dataBits === 7 || dataBits === 8) {
		return dataBits;
	}
	return 8;
}

export function stopBitsValue(stopBits: number): 1 | 1.5 | 2 {
	if (stopBits === 2) return 2;
	if (stopBits === 1.5) return 1.5;
	return 1;
}

export function parityName(parity: 'n' | 'o' | 'e'): 'none' | 'odd' | 'even' {
	if (parity === 'o') return 'odd';
	if (parity === 'e') return 'even';
	return 'none';
}

export function serialFlowValue(
	flowControl: SerialFlowControl,
): string {
	if (flowControl === 'xonxoff' || flowControl === 'rtscts') {
		return flowControl;
	}
	return 'none';
}

export function encodeBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

export function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function formatBytes(bytes: Uint8Array): string {
	return Array.from(
		bytes,
		(byte) => byte.toString(16).padStart(2, '0').toUpperCase(),
	).join(' ');
}

export function visibleBytes(bytes: Uint8Array): string {
	let out = '';
	for (const byte of bytes) {
		if (byte === 0x02) out += '[STX]';
		else if (byte === 0x03) out += '[ETX]';
		else if (byte === 0x04) out += '[EOT]';
		else if (byte === 0x05) out += '[ENQ]';
		else if (byte === 0x06) out += '[ACK]';
		else if (byte === 0x0a) out += '[LF]';
		else if (byte === 0x0d) out += '[CR]';
		else if (byte === 0x11) out += '[XON]';
		else if (byte === 0x13) out += '[XOFF]';
		else if (byte === 0x15) out += '[NAK]';
		else if (byte === 0x17) out += '[ETB]';
		else if (byte >= 0x20 && byte <= 0x7e) out += String.fromCharCode(byte);
		else out += `[0x${byte.toString(16).padStart(2, '0').toUpperCase()}]`;
	}
	return out;
}

// export function normalizePortName(portName: string): string {
//   return portName.trim().replace(/^\\\\\.\\/, "").toUpperCase();
// }

export function delay(ms: number): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function serialTraceEnabled(): boolean {
	return envFlag('SERIAL_TRACE') || envFlag('COBAS_C111_TRACE') ||
		envFlag('SYSMEX_KX21N_TRACE');
}

export function envFlag(name: string): boolean {
	const raw = Deno.env.get(name)?.trim().toLowerCase();
	return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

// db related
export function ensureDbDirectory(dbPath: string): void {
	const dir = dirname(resolve(dbPath));
	Deno.mkdirSync(dir, { recursive: true });
}

// registry related
export function requiredValue<T>(value: T | undefined, message: string): T {
	if (value === undefined) throw new Error(message);
	return value;
}

// env helper
type EnvValue = string | boolean | number;
export function env<T extends EnvValue>(name: string, fallback: T): T {
	const raw = Deno.env.get(name)?.trim();
	if (!raw) {
		return fallback;
	}

	switch (typeof fallback) {
		case 'string':
			return raw as T;

		case 'boolean': {
			const value = raw.toLowerCase();

			if (['1', 'true', 'yes', 'on'].includes(value)) {
				return true as T;
			}

			if (['0', 'false', 'no', 'off'].includes(value)) {
				return false as T;
			}

			throw new Error(
				`${name} must be a boolean ("true", "false", "1", "0", "yes", "no", "on", "off").`,
			);
		}

		case 'number': {
			const number = Number(raw);

			if (!Number.isFinite(number)) {
				throw new Error(`${name} must be a valid number.`);
			}

			// If the fallback is like a port, validate like envPort().
			if (
				Number.isInteger(fallback) &&
				fallback >= 1 &&
				fallback <= 65535 &&
				name.toUpperCase().includes('PORT')
			) {
				if (!Number.isInteger(number) || number < 1 || number > 65535) {
					throw new Error(
						`${name} must be an integer port from 1 to 65535.`,
					);
				}
			}

			return number as T;
		}

		default:
			return fallback;
	}
}

// store related
export function normalizeLimit(limit: number): number {
	return Math.max(0, Math.trunc(limit));
}

export function normalizeOffset(offset: number): number {
	return Math.max(0, Math.trunc(offset));
}
