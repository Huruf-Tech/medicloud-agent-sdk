import * as z from '@zod/zod';
import type { MachineRegistry } from '../registry.ts';
import { empty, HttpError, json } from './utils.ts';
import {
	NonEmptyStringSchema,
	NonNegativeIntegerParamSchema,
	parseInput,
	PositiveIntegerParamSchema,
} from './validation.ts';
import { ListTestStatisticsQuerySchema } from '../schema.ts';

/** Expose learned test-duration statistics without leaking store access. */
export async function handleTestStatisticRoutes(
	registry: MachineRegistry,
	url: URL,
	method: string,
	segments: string[],
): Promise<Response> {
	// GET /test-statistics
	if (segments.length === 0 && method === 'GET') {
		const query = parseInput(
			ListTestStatisticsQuerySchema,
			Object.fromEntries(url.searchParams),
		);
		return json({
			statistics: await registry.listTestStatistics(query),
		});
	}

	// GET /test-statistics/count
	if (method === 'GET' && segments.length === 1 && segments[0] === 'count') {
		const testStatisticsCount = await registry.countTestStatistics() ?? 0;
		return json({ count: testStatisticsCount });
	}

	if (segments.length === 0) {
		return json({ error: 'not found' }, 404);
	}
	const statisticId = parseInput(PositiveIntegerParamSchema, segments[0]);

	// GET /test-statistics/:statisticId
	if (segments.length === 1 && method === 'GET') {
		const statistic = await registry.getTestStatistic(statisticId);
		if (!statistic) {
			throw new HttpError(
				`Test statistic ${statisticId} was not found.`,
				404,
			);
		}
		return json({ statistic });
	}

	// DELETE /test-statistics/:statisticId
	if (segments.length === 1 && method === 'DELETE') {
		if (!await registry.deleteTestStatistic(statisticId)) {
			throw new HttpError(
				`Test statistic ${statisticId} was not found.`,
				404,
			);
		}
		return empty();
	}

	return json({ error: 'not found' }, 404);
}
