import * as z from '@zod/zod';
import { HttpError } from './utils.ts';

export const NonEmptyStringSchema = z.string().trim().min(
	1,
	'must be a non-empty string',
);

export const PositiveIntegerSchema = z.number()
	.int()
	.positive()
	.max(Number.MAX_SAFE_INTEGER, 'must be a safe positive integer');

export const PositiveIntegerParamSchema = z.string()
	.regex(/^[1-9]\d*$/, 'must be a positive integer')
	.transform(Number)
	.refine(Number.isSafeInteger, 'must be a safe positive integer');

export const NonNegativeIntegerParamSchema = z.string()
	.regex(/^(0|[1-9]\d*)$/, 'must be a non-negative integer')
	.transform(Number)
	.refine(Number.isSafeInteger, 'must be a safe non-negative integer');

export const JsonObjectSchema = z.record(z.string(), z.unknown());

export const NonEmptyStringArraySchema = z.array(NonEmptyStringSchema)
	.min(1, 'must contain at least one item')
	.transform((items) => [...new Set(items)]);

export const DateStringSchema = NonEmptyStringSchema
	.refine(
		(value) => !Number.isNaN(new Date(value).getTime()),
		'must be a valid date string',
	)
	.transform((value) => new Date(value));

export function parseInput<TSchema extends z.ZodType>(
	schema: TSchema,
	input: unknown,
): z.output<TSchema> {
	const result = schema.safeParse(input);
	if (!result.success) {
		throw new HttpError(z.prettifyError(result.error));
	}
	return result.data;
}

export async function parseJson<TSchema extends z.ZodType>(
	req: Request,
	schema: TSchema,
): Promise<z.output<TSchema>> {
	let input: unknown;
	try {
		input = await req.json();
	} catch {
		throw new HttpError('Request body must contain valid JSON.');
	}

	return parseInput(schema, input);
}
