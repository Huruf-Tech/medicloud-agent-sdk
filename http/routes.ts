import * as z from '@zod/zod';
import { handleCatalogRoutes } from './catalog.routes.ts';
import type { MachineRegistry } from '../registry.ts';
import { handleProfileRoutes } from './profile.routes.ts';
import { handleOrderRoutes } from './orders.routes.ts';
import { handleResultRoutes } from './results.routes.ts';
import { handleTestStatisticRoutes } from './testStatistics.routes.ts';
import { empty, errorResponse, json } from './utils.ts';
import { NonEmptyStringSchema, parseInput } from './validation.ts';

export interface MachineManagerApiContext {
	readonly registry: MachineRegistry;
}
const DriverQuerySchema = z.object({
	id: NonEmptyStringSchema.optional(),
	brand: NonEmptyStringSchema.optional(),
}).strict();

// Http dispatcher. routes can access only registry methods
export function createMachineManagerHandler(
	ctx: MachineManagerApiContext,
): (req: Request) => Promise<Response> {
	return async (req: Request): Promise<Response> => {
		const url = new URL(req.url);
		const segments = url.pathname.split('/').filter(Boolean);
		const method = req.method.toUpperCase();

		// OPTIONS
		if (method === 'OPTIONS') {
			return empty(204);
		}

		try {
			// GET /health
			if (
				method === 'GET' && segments.length === 1 &&
				segments[0] === 'health'
			) {
				return json({
					status: 'ok',
					registered_drivers: ctx.registry.listDrivers(),
					running_machines: ctx.registry.listRunning(),
				});
			}

			// GET /drivers, optionally filtered with ?id=... or ?brand=...
			if (
				method === 'GET' && segments.length === 1 &&
				segments[0] === 'drivers'
			) {
				const drivers = ctx.registry.listDrivers();
				const query = parseInput(
					DriverQuerySchema,
					Object.fromEntries(url.searchParams),
				);
				const value = query.id ?? query.brand;

				if (!value) return json({ drivers });
				const key = value?.toLowerCase();

				// filtered drivers
				const filtered_drivers = drivers.filter((d) =>
					d.id.toLowerCase() === key ||
					d.brand?.toLowerCase() === key
				);

				return filtered_drivers?.length
					? json({ drivers: filtered_drivers })
					: json({ error: 'driver not found' }, 404);
			}

			// catalog management
			if (segments[0] === 'catalogs') {
				return await handleCatalogRoutes(
					ctx.registry,
					req,
					url,
					method,
					segments.slice(1),
				);
			}

			// profiles managemet
			if (segments[0] === 'profiles') {
				return await handleProfileRoutes(
					ctx.registry,
					req,
					url,
					method,
					segments.slice(1),
				);
			}

			// orders management
			if (segments[0] === 'orders') {
				return await handleOrderRoutes(
					ctx.registry,
					req,
					url,
					method,
					segments.slice(1),
				);
			}

			// results management
			if (segments[0] === 'results') {
				return await handleResultRoutes(
					ctx.registry,
					url,
					method,
					segments.slice(1),
				);
			}

			// test statistics management
			if (segments[0] === 'test-statistics') {
				return await handleTestStatisticRoutes(
					ctx.registry,
					url,
					method,
					segments.slice(1),
				);
			}

			return json({ error: 'not found' }, 404);
		} catch (error) {
			return errorResponse(error);
		}
	};
}
