import * as z from '@zod/zod';
import type { MachineRegistry } from '../registry.ts';
import { HttpError, json } from './utils.ts';
import {
	JsonObjectSchema,
	NonEmptyStringSchema,
	parseInput,
	parseJson,
	PositiveIntegerParamSchema,
} from './validation.ts';
import {
	CreateProfileSchema,
	ProfilesQuerySchema,
	UpdateProfileSchema,
} from '../schema.ts';
import { count } from 'node:console';

export const handleProfileRoutes = async (
	registry: MachineRegistry,
	req: Request,
	url: URL,
	method: string,
	segments: string[],
): Promise<Response> => {
	// GET /profiles with or without query
	if (method === 'GET' && segments.length === 0) {
		// return json({ profiles: await registry.listProfiles() });
		const query = parseInput(
			ProfilesQuerySchema,
			Object.fromEntries(url.searchParams),
		);

		return json({ profiles: await registry.queryProfiles(query) });
	}

	// GET /profiles/count
	if (method === 'GET' && segments.length === 1 && segments[0] === 'count') {
		const profileCount = await registry.countProfiles() ?? 0;
		return json({ count: profileCount });
	}

	// POST /profiles
	if (segments.length === 0 && method === 'POST') {
		const input = await parseJson(req, CreateProfileSchema);
		const profile = await registry.createProfile(input);
		return json({ profile }, 201);
	}

	if (segments.length === 0) {
		return json({ error: 'not found' }, 404);
	}

	const machineId = parseInput(PositiveIntegerParamSchema, segments[0]);

	// GET /profiles/:machineId
	if (segments.length === 1 && method === 'GET') {
		const profile = await registry.getProfile(machineId);
		if (!profile) {
			throw new HttpError(
				`Machine profile ${machineId} was not found.`,
				404,
			);
		}
		return json({ profile });
	}

	// PATCH /profiles/:machineId
	if (segments.length === 1 && method === 'PATCH') {
		if (!await registry.getProfile(machineId)) {
			throw new HttpError(
				`Machine profile ${machineId} was not found.`,
				404,
			);
		}

		// the driverId is not allow to be patched & runtime you cannot change config as well, rest info is configurable
		const update = await parseJson(req, UpdateProfileSchema);
		return json({
			profile: await registry.updateProfile(machineId, update),
		});
	}

	// DELETE /profiles/:machineId
	if (segments.length === 1 && method === 'DELETE') {
		if (!await registry.deleteProfile(machineId)) {
			throw new HttpError(
				`Machine profile ${machineId} was not found.`,
				404,
			);
		}
		return json({ success: true, id: machineId });
	}

	// POST /profiles/:machineId/start
	if (segments.length === 2 && segments[1] === 'start' && method === 'POST') {
		const registerMachine = await registry.getProfile(machineId);
		if (!registerMachine) {
			throw new HttpError(
				`Machine profile ${machineId} was not found.`,
				404,
			);
		}
		const started = await registry.startStoredProfile(machineId);
		return json({ started, profile: await registry.getProfile(machineId) });
	}

	// POST /profiles/:machineId/stop
	if (segments.length === 2 && segments[1] === 'stop' && method === 'POST') {
		if (!await registry.getProfile(machineId)) {
			throw new HttpError(
				`Machine profile ${machineId} was not found.`,
				404,
			);
		}
		const stopped = await registry.stopStoredProfile(machineId);
		return json({ stopped, profile: await registry.getProfile(machineId) });
	}

	return json({ error: 'not found' }, 404);
};
