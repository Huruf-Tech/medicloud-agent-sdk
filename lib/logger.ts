type Level = 'info' | 'warn' | 'error' | 'debug';

function emit(level: Level, scope: string, msg: string, extra?: unknown): void {
	const ts = new Date().toISOString();
	const base = `${ts} [${level.toUpperCase()}] (${scope}) ${msg}`;
	if (extra === undefined) {
		console[level === 'debug' ? 'log' : level](base);
	} else {
		console[level === 'debug' ? 'log' : level](base, extra);
	}
}

export function createLogger(scope: string) {
	return {
		info: (msg: string, extra?: unknown) => emit('info', scope, msg, extra),
		warn: (msg: string, extra?: unknown) => emit('warn', scope, msg, extra),
		error: (msg: string, extra?: unknown) =>
			emit('error', scope, msg, extra),
		debug: (msg: string, extra?: unknown) =>
			emit('debug', scope, msg, extra),
	};
}

export type Logger = ReturnType<typeof createLogger>;
