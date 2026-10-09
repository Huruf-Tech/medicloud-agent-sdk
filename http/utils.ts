import * as z from '@zod/zod';
import { CatalogInUseError } from '../store/catalogStore.ts';
import type { CatalogView } from '../types.ts';

/** Reserved for future drivers that have not yet moved to SQLite. */
export const STATIC_CATALOGS: readonly CatalogView[] = [];

export function findStaticCatalog(value: string): CatalogView | undefined {
	const key = value.toLowerCase();
	return STATIC_CATALOGS.find((catalog) =>
		catalog.driverId.toLowerCase() === key ||
		catalog.machine.toLowerCase() === key
	);
}
// response-helper
export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: defaultHeaders({
			'content-type': 'application/json; charset=utf-8',
		}),
	});
}

export function empty(status = 204): Response {
	return new Response(null, { status, headers: defaultHeaders() });
}

export class HttpError extends Error {
	constructor(message: string, readonly status = 400) {
		super(message);
		this.name = 'HttpError';
	}
}

export function defaultHeaders(headers: HeadersInit = {}): Headers {
	const result = new Headers(headers);
	result.set('access-control-allow-origin', '*');
	result.set('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
	result.set('access-control-allow-headers', 'content-type');
	return result;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function errorResponse(error: unknown): Response {
	if (error instanceof CatalogInUseError) {
		return json({ error: error.message }, 409);
	}
	if (error instanceof HttpError) {
		return json({ error: error.message }, error.status);
	}
	if (error instanceof z.ZodError) {
		return json({ error: z.prettifyError(error) }, 400);
	}

	return json({ error: 'internal error', detail: errorMessage(error) }, 500);
}
