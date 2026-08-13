/**
 * The declared contract of the storefront API v1.
 *
 * STRICT IN BOTH DIRECTIONS. Unknown fields fail as well as missing ones,
 * because an additive change is still a consumer-visible contract change and a
 * real store's parser may not tolerate it. Forcing every change through this
 * file makes it conscious.
 *
 * Shapes mirror `WireProduct` / `WireVariant` in the Wonderbatch repo at
 * `web/src/routes/api/external/storefront/v1/_serialize.ts`. They are restated
 * rather than imported, deliberately: importing would weld this client to the
 * monolith and destroy the only property that makes it worth having.
 */

import { z } from 'zod';

export const wireVariantSchema = z
	.object({
		variant_id: z.string().min(1),
		net_weight: z.number().positive(),
		/** Net, fixed 2 decimals, as a string — never a float. */
		net_price: z.string().regex(/^\d+\.\d{2}$/),
		currency: z.string().length(3),
		sku: z.string().nullable(),
		ean: z.string().nullable(),
		availability: z.string().min(1),
		is_purchasable: z.boolean(),
	})
	.strict();

export const wireProductSchema = z
	.object({
		product_group_id: z.string().min(1),
		name: z.string().min(1),
		product_type: z.string().nullable(),
		description: z.string().nullable(),
		image_url: z.string().nullable(),
		attributes: z.record(z.unknown()).nullable(),
		/**
		 * At least one. The list never fetches unlisted rows and the detail
		 * endpoint 404s when every variant is hidden, so an empty array should be
		 * unreachable on the wire.
		 */
		variants: z.array(wireVariantSchema).min(1),
	})
	.strict();

export const paginationSchema = z
	.object({
		total: z.number().int().nonnegative(),
		limit: z.number().int().positive(),
		offset: z.number().int().nonnegative(),
		has_more: z.boolean(),
	})
	.strict();

export const productListSchema = z
	.object({
		success: z.literal(true),
		data: z
			.object({
				products: z.array(wireProductSchema),
				pagination: paginationSchema,
				currency: z.string().length(3),
				locale: z.string().min(2),
			})
			.strict(),
	})
	.strict();

export const productDetailSchema = z
	.object({
		success: z.literal(true),
		data: z
			.object({
				product: wireProductSchema,
				currency: z.string().length(3),
				locale: z.string().min(2),
			})
			.strict(),
	})
	.strict();

export const errorSchema = z
	.object({
		success: z.literal(false),
		error: z
			.object({
				category: z.string().min(1),
				message: z.string().min(1),
				code: z.string().optional(),
				field: z.string().optional(),
				details: z.record(z.unknown()).optional(),
			})
			.strict(),
	})
	.strict();

/**
 * `unit_price` on a cart line. Net only, same reasoning as the catalog's
 * `net_price`: gross needs the buyer's delivery destination, which isn't
 * known until checkout.
 */
export const netMoneySchema = z
	.object({
		net: z.string().regex(/^\d+\.\d{2}$/),
		currency: z.string().length(3),
	})
	.strict();

export const cartItemSchema = z
	.object({
		variant_id: z.string().min(1),
		product_group_id: z.string().min(1),
		name: z.string().min(1),
		net_weight: z.number().positive(),
		quantity: z.number().int().min(1).max(99),
		unit_price: netMoneySchema,
		availability: z.string().min(1),
		is_purchasable: z.boolean(),
		/** Same 2a gap as the catalog — always null in v1. */
		image_url: z.string().nullable(),
		added_at: z.string().datetime(),
	})
	.strict();

export const cartTotalsSchema = z
	.object({
		item_count: z.number().int().nonnegative(),
		quantity: z.number().int().nonnegative(),
		net_value: z.string().regex(/^\d+\.\d{2}$/),
		currency: z.string().length(3),
	})
	.strict();

export const cartSchema = z
	.object({
		/** `crt_` + 43 random base64url characters — this token IS the credential. */
		id: z.string().regex(/^crt_/),
		items: z.array(cartItemSchema),
		totals: cartTotalsSchema,
		created_at: z.string().datetime(),
	})
	.strict();

/**
 * The shape returned by every cart endpoint — `POST /carts`, `GET
 * /carts/:cart_id`, and both item mutations all return this same envelope
 * around the current cart.
 */
export const cartResponseSchema = z
	.object({
		success: z.literal(true),
		data: z.object({ cart: cartSchema }).strict(),
	})
	.strict();
