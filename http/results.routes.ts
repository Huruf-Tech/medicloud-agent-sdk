import * as z from '@zod/zod';
import type { MachineRegistry } from '../registry.ts';
import { HttpError, json } from './utils.ts';
import { parseInput, PositiveIntegerParamSchema } from './validation.ts';
import { ListResultsQuerySchema } from '../schema.ts';

/** Results are immutable audit records, HTTP exposes lookup operations only. */
export async function handleResultRoutes(
	registry: MachineRegistry,
	url: URL,
	method: string,
	segments: string[],
): Promise<Response> {
	// GET /results
	if (segments.length === 0 && method === 'GET') {
		const query = parseInput(
			ListResultsQuerySchema,
			Object.fromEntries(url.searchParams),
		);
		return json({ results: await registry.listResults(query) });
	}

	// GET /results/count
	if (method === 'GET' && segments.length === 1 && segments[0] === 'count') {
		const resultsCount = await registry.countResults() ?? 0;
		return json({ count: resultsCount });
	}

	// GET /results/:resultId
	if (segments.length === 1 && method === 'GET') {
		const resultId = parseInput(PositiveIntegerParamSchema, segments[0]);
		const result = await registry.getResult(resultId);
		if (!result) {
			throw new HttpError(
				`Machine result ${resultId} was not found.`,
				404,
			);
		}
		return json({ result });
	}

	return json({ error: 'not found' }, 404);
}
