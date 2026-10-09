// Owns the serial port. COM3
// Responsibilities:
// open COM port
// configure baud
// parity
// stop bits
// xon/xoff
// rtscts
// receive bytes
// transmit bytes

import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const args = parseArgs(process.argv.slice(2));
const portName = String(args.port ?? 'COM3').toUpperCase();
const baudRate = Number(args.baud ?? 9600);
const dataBits = Number(args['data-bits'] ?? 8);
const stopBits = Number(args['stop-bits'] ?? 1);
const parity = String(args.parity ?? 'none');
const flow = String(args.flow ?? 'xonxoff');
const softwareHandshake = flow === 'xonxoff' || flow === 'sw';
const hardwareHandshake = flow === 'rtscts' || flow === 'hw' ||
	flow === 'hardware';
const { SerialPort } = loadSerialport();

let opened = false;
let closing = false;

const port = new SerialPort({
	path: portName,
	baudRate,
	dataBits,
	stopBits,
	parity,
	rtscts: hardwareHandshake,
	xon: softwareHandshake,
	xoff: softwareHandshake,
	autoOpen: false,
});

port.on('open', () => {
	opened = true;
	send({ type: 'open' });
	send({
		type: 'log',
		level: 'info',
		message:
			`opened ${portName} baud=${baudRate} parity=${parity} dataBits=${dataBits} stopBits=${stopBits} flow=${flow}`,
	});
});

port.on('data', (data) => {
	send({ type: 'data', data: Buffer.from(data).toString('base64') });
});

port.on('close', () => {
	opened = false;
	send({ type: 'close' });
	if (!closing) process.exit(0);
});

port.on('error', (error) => {
	send({ type: 'error', message: error.message });
});

port.open((error) => {
	if (error) {
		send({ type: 'error', message: error.message });
		process.exit(1);
	}
});

const rl = readline.createInterface({
	input: process.stdin,
	crlfDelay: Infinity,
});

rl.on('line', (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		send({
			type: 'log',
			level: 'warn',
			message: `bad stdin json: ${line}`,
		});
		return;
	}

	if (message.type === 'close') {
		closing = true;
		if (opened) port.close(() => process.exit(0));
		else process.exit(0);
		return;
	}

	if (message.type !== 'write') return;
	const id = Number(message.id);
	const bytes = Buffer.from(String(message.data ?? ''), 'base64');
	port.write(bytes, (writeError) => {
		if (writeError) {
			send({ type: 'writeError', id, message: writeError.message });
			return;
		}
		port.drain((drainError) => {
			if (drainError) {
				send({ type: 'writeError', id, message: drainError.message });
			} else send({ type: 'writeDone', id, bytes: bytes.length });
		});
	});
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (error) => {
	send({ type: 'error', message: error?.message ?? String(error) });
	process.exit(1);
});

function shutdown() {
	closing = true;
	if (opened) port.close(() => process.exit(0));
	else process.exit(0);
}

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function loadSerialport() {
	const root = path.join(
		process.env.MEDICLOUD_SERIAL_NODE_DIR ||
			process.env.LOCALAPPDATA ||
			os.tmpdir(),
		'medicloud-machines-serialport',
	);
	const requireFromCache = createRequire(
		pathToFileURL(path.join(root, 'helper.cjs')).href,
	);
	try {
		return requireFromCache('serialport');
	} catch {
		send({
			type: 'log',
			level: 'info',
			message: `installing serialport@12.0.0 into ${root}`,
		});
	}

	mkdirSync(root, { recursive: true });
	const install = spawnSync(
		npmCommand(),
		npmArgs(['install', '--silent', '--prefix', root, 'serialport@12.0.0']),
		{
			encoding: 'utf8',
			windowsHide: true,
		},
	);
	if (install.status !== 0) {
		throw new Error(
			install.error?.message ||
				install.stderr ||
				install.stdout ||
				`npm install failed ${install.status}`,
		);
	}

	return requireFromCache('serialport');
}

function npmCommand() {
	return process.platform === 'win32' ? 'cmd.exe' : 'npm';
}

function npmArgs(args) {
	return process.platform === 'win32'
		? ['/d', '/c', 'npm.cmd', ...args]
		: args;
}

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith('--')) continue;
		const key = arg.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith('--')) out[key] = true;
		else {
			out[key] = next;
			i++;
		}
	}
	return out;
}
