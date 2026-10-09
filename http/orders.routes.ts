import * as z from '@zod/zod';
import type { MachineRegistry } from '../registry.ts';
import { empty, HttpError, json } from './utils.ts';
import {
	DateStringSchema,
	NonEmptyStringArraySchema,
	NonEmptyStringSchema,
	NonNegativeIntegerParamSchema,
	parseInput,
	parseJson,
	PositiveIntegerParamSchema,
	PositiveIntegerSchema,
} from './validation.ts';
import { MachineOrder } from '../types.ts';
import {
	CreateOrderSchema,
	ListOrdersQuerySchema,
	UpdateOrderSchema,
} from '../schema.ts';

export const handleOrderRoutes = async (
	registry: MachineRegistry,
	req: Request,
	url: URL,
	method: string,
	segments: string[],
): Promise<Response> => {
	// GET /orders with or without query
	if (segments.length === 0 && method === 'GET') {
		const query = parseInput(
			ListOrdersQuerySchema,
			Object.fromEntries(url.searchParams),
		);
		return json({ orders: await registry.queryOrders(query) });
	}

	// GET /orders/count
	if (method === 'GET' && segments.length === 1 && segments[0] === 'count') {
		const orderCount = await registry.countOrders() ?? 0;
		return json({ count: orderCount });
	}

	// POST /orders
	if (segments.length === 0 && method === 'POST') {
		const input = await parseJson(req, CreateOrderSchema);
		const createdAt = input.createdAt ?? new Date();
		const order: MachineOrder = {
			...input,
			tests: input.tests ?? [],
			status: 'pending',
			createdAt,
			expiresAt: input.expiresAt ??
				new Date(createdAt.getTime() + 24 * 60 * 60 * 1_000),
		};
		const orderId = await registry.submitOrder(order);
		return json({
			order: orderId ? await registry.getOrder(orderId) : null,
		}, 201);
	}

	if (segments.length === 0) {
		return json({ error: 'not found' }, 404);
	}
	const orderId = parseInput(PositiveIntegerParamSchema, segments[0]);

	// GET /orders/:orderId
	if (segments.length === 1 && method === 'GET') {
		const order = await registry.getOrder(orderId);
		if (!order) {
			throw new HttpError(`Machine order ${orderId} was not found.`, 404);
		}
		return json({ order });
	}

	// PATCH /orders/:orderId
	if (segments.length === 1 && method === 'PATCH') {
		if (!await registry.getOrder(orderId)) {
			throw new HttpError(`Machine order ${orderId} was not found.`, 404);
		}

		const update = await parseJson(req, UpdateOrderSchema);
		return json({ order: await registry.updateOrder(orderId, update) });
	}

	// POST /orders/:orderId/resend
	if (
		segments.length === 2 && segments[1] === 'resend' && method === 'POST'
	) {
		const order = await registry.getOrder(orderId);

		if (!order) {
			throw new HttpError(`Machine order ${orderId} was not found.`, 404);
		}
		if (order.status !== 'failed' && order.status !== 'pending') {
			throw new HttpError(
				`Only failed or pending orders can be resent, order ${orderId} is ${
					order.status ?? 'pending'
				}.`,
				409,
			);
		}
		return json({ order: await registry.resendOrder(orderId) });
	}

	// DELETE /orders/:orderId
	if (segments.length === 1 && method === 'DELETE') {
		if (!await registry.deleteOrder(orderId)) {
			throw new HttpError(`Machine order ${orderId} was not found.`, 404);
		}
		return json({ success: true, id: orderId });
	}

	return json({ error: 'not found' }, 404);
};
