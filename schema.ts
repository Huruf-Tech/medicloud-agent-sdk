import z from '@zod/zod';
import {
	DateStringSchema,
	JsonObjectSchema,
	NonEmptyStringArraySchema,
	NonEmptyStringSchema,
	NonNegativeIntegerParamSchema,
	PositiveIntegerParamSchema,
	PositiveIntegerSchema,
} from './http/validation.ts';

// profile related schemas
export const CreateProfileSchema = z.object({
	driverId: NonEmptyStringSchema,
	name: NonEmptyStringSchema.optional(),
	enabled: z.boolean().default(false),
	config: JsonObjectSchema,
}).strict();

export const UpdateProfileSchema = z.object({
	driverId: NonEmptyStringSchema.optional(),
	name: NonEmptyStringSchema.nullable().optional(),
	enabled: z.boolean().optional(),
	config: JsonObjectSchema.optional(),
}).strict().refine(
	(update) => Object.keys(update).length > 0,
	'at least one profile field must be supplied',
);

export const ProfilesQuerySchema = z.object({
	id: PositiveIntegerParamSchema.optional(),
	driverId: NonEmptyStringSchema.optional(),
	name: NonEmptyStringSchema.optional(),
	// enabled: z.boolean().optional(),
	enabled: z.preprocess(
		(value) => value === 'true' ? true : value === 'false' ? false : value,
		z.boolean().optional(),
	),
	limit: PositiveIntegerParamSchema.optional(),
	offset: NonNegativeIntegerParamSchema.optional(),
}).strict();

export type TProfileQuery = z.infer<typeof ProfilesQuerySchema>;
export type TProfileCreate = z.infer<typeof CreateProfileSchema>;
export type TProfileUpdate = z.infer<typeof UpdateProfileSchema>;

// orders related schemas
export const OrderStatusSchema = z.enum([
	'pending',
	'testing',
	'completed',
	'failed',
]);

export const ListOrdersQuerySchema = z.object({
	machineId: PositiveIntegerParamSchema.optional(),
	sampleId: NonEmptyStringSchema.optional(),
	status: OrderStatusSchema.optional(),
	limit: PositiveIntegerParamSchema.optional(),
	offset: NonNegativeIntegerParamSchema.optional(),
}).strict();

export const OptionalOrderTextFields = {
	patientId: NonEmptyStringSchema.optional(),
	patientName: NonEmptyStringSchema.optional(),
	dob: NonEmptyStringSchema.optional(),
	sex: NonEmptyStringSchema.optional(),
	species: NonEmptyStringSchema.optional(),
	sampleType: NonEmptyStringSchema.optional(),
	rackPosition: NonEmptyStringSchema.optional(),
};

export const CreateOrderSchema = z.object({
	machineId: PositiveIntegerSchema,
	sampleId: NonEmptyStringSchema,
	tests: NonEmptyStringArraySchema.optional(),
	...OptionalOrderTextFields,
	raw: z.unknown().optional(),
	createdAt: DateStringSchema.optional(),
	expiresAt: DateStringSchema.optional(),
}).strict();

export const UpdateOrderSchema = z.object({
	sampleId: NonEmptyStringSchema.optional(),
	tests: NonEmptyStringArraySchema.optional(),
	...OptionalOrderTextFields,
	raw: z.unknown().optional(),
	expiresAt: DateStringSchema.optional(),
}).strict().refine(
	(update) => Object.keys(update).length > 0,
	'at least one editable order field must be supplied',
);

export type TOrderQuery = z.infer<typeof ListOrdersQuerySchema>;
export type TOrderCreate = z.infer<typeof CreateOrderSchema>;
export type TOrderUpdate = z.infer<typeof UpdateOrderSchema>;

// result related schemas
export const ListResultsQuerySchema = z.object({
	orderId: PositiveIntegerParamSchema.optional(),
	machineId: PositiveIntegerParamSchema.optional(),
	sampleId: NonEmptyStringSchema.optional(),
	limit: PositiveIntegerParamSchema.optional(),
	offset: NonNegativeIntegerParamSchema.optional(),
}).strict();

export type TResultQuery = z.infer<typeof ListResultsQuerySchema>;

// test statistics schemas
export const ListTestStatisticsQuerySchema = z.object({
	machineId: PositiveIntegerParamSchema.optional(),
	testId: NonEmptyStringSchema.optional(),
	limit: PositiveIntegerParamSchema.optional(),
	offset: NonNegativeIntegerParamSchema.optional(),
}).strict();

export type TTestStatisticQuery = z.infer<typeof ListTestStatisticsQuerySchema>;
