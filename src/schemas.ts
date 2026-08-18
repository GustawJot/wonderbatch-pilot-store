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
		/**
		 * `hidden` must never appear here — the buyer already put the line in
		 * their cart, so a variant the seller has since unlisted reports
		 * `out_of_stock` instead (same anti-enumeration reason as the catalog,
		 * which drops `hidden` variants outright rather than labelling them).
		 */
		availability: z.string().min(1).refine((v) => v !== 'hidden', {
			message: 'availability must never be "hidden" on the cart wire',
		}),
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

/**
 * `shipping_fee` on an offered method. Net-only like every money field on
 * this wire, and `"0.00"` is a real fee (free delivery), never an absent
 * field. Unlike the catalog's open 3-letter currency, this one is a CLOSED
 * picklist — the engine's offer store accepts exactly PLN and EUR, so any
 * other value reaching the wire is drift, not a new market.
 */
export const shippingFeeSchema = z
	.object({
		net: z.string().regex(/^\d+\.\d{2}$/),
		currency: z.enum(['PLN', 'EUR']),
	})
	.strict();

export const shippingMethodSchema = z
	.object({
		/** Engine bucket id — the exact value 3c-4's order placement will accept. */
		id: z.string().min(1),
		type: z.enum(['locker', 'courier', 'pickup_point']),
		carrier: z.string().min(1),
		requires_pickup_point: z.boolean(),
		/**
		 * The wire name is `shipping_fee`, NOT the contract sketch's `price`
		 * (naming ruling, spec §4) — and the resolver's internal `source`
		 * diagnostic ("configured" vs "default") must never appear, because it
		 * would let anyone tell a hand-configured store from an untouched one.
		 * `.strict()` turns either drift into a parse failure.
		 */
		shipping_fee: shippingFeeSchema,
	})
	.strict();

/**
 * `GET /shipping/methods`. An empty `methods` is valid — a seller who
 * switched every method off offers nothing, and this endpoint says so
 * truthfully rather than inventing a default.
 */
export const shippingMethodsResponseSchema = z
	.object({
		success: z.literal(true),
		data: z.object({ methods: z.array(shippingMethodSchema) }).strict(),
	})
	.strict();

export const pickupPointSchema = z
	.object({
		/** The value 3c-4's `collection_point_code` accepts — the cross-slice contract. */
		code: z.string().min(1),
		name: z.string().min(1),
		address: z.string(),
		city: z.string(),
		postal_code: z.string().min(1),
		location: z.object({ latitude: z.number(), longitude: z.number() }).strict(),
		distance_meters: z.number().nullable(),
		opening_hours: z.string(),
		/** Explicit `null`, never omitted — the wire rule for nullable fields. */
		location_description: z.string().nullable(),
		is_available_247: z.boolean(),
		carrier_id: z.string().min(1),
	})
	.strict();

/**
 * `GET /shipping/pickup-points`. `points: []` is a REAL success — "searched
 * fine, found nothing" is a renderable outcome (ruling 2026-08-17), and this
 * surface reserves 404 for its anti-enumeration meaning.
 */
export const pickupPointsResponseSchema = z
	.object({
		success: z.literal(true),
		data: z.object({ points: z.array(pickupPointSchema) }).strict(),
	})
	.strict();

/**
 * Money on the ORDER wire. Unlike the cart's net-only `unit_price`, an order
 * knows its VAT country, so every money block widens to net + gross +
 * `vat_rate` (a decimal STRING like "0.23" — a JSON number would re-float) +
 * sibling `currency`. Used for order items' `unit_price`, and — same shape —
 * for the order's `shipping_fee`.
 */
export const grossMoneySchema = z
	.object({
		net: z.string().regex(/^\d+\.\d{2}$/),
		gross: z.string().regex(/^\d+\.\d{2}$/),
		vat_rate: z.string().regex(/^\d+(\.\d+)?$/),
		currency: z.string().length(3),
	})
	.strict();

export const orderItemSchema = z
	.object({
		/** The same `variant_id` the catalog and cart speak. */
		variant_id: z.string().min(1),
		name: z.string().min(1),
		net_weight: z.number().positive(),
		/** The cart's per-line cap carries through — an order line mirrors it. */
		quantity: z.number().int().min(1).max(99),
		unit_price: grossMoneySchema,
	})
	.strict();

export const orderTotalsSchema = z
	.object({
		item_count: z.number().int().nonnegative(),
		quantity: z.number().int().nonnegative(),
		net_value: z.string().regex(/^\d+\.\d{2}$/),
		gross_value: z.string().regex(/^\d+\.\d{2}$/),
		/**
		 * The residual `gross − net`, never an independently rounded
		 * `net × rate` — the engine's money-spine rule, re-asserted
		 * arithmetically in the order tests.
		 */
		vat_amount: z.string().regex(/^\d+\.\d{2}$/),
		vat_rate: z.string().regex(/^\d+(\.\d+)?$/),
		/** Destination-principle VAT country (ISO 3166-1 alpha-2). */
		vat_country: z.string().length(2),
		currency: z.string().length(3),
	})
	.strict();

/** Null until the shipment carries a tracking number — never omitted. */
export const orderTrackingSchema = z
	.object({
		carrier: z.string().min(1),
		tracking_number: z.string().min(1),
		tracking_url: z.string().nullable(),
	})
	.strict();

/**
 * The order as BOTH order endpoints serve it — `POST /orders` (201) and
 * `GET /orders/:id` (200) share one serializer by contract, so one schema
 * covers both and any drift between the two doors fails a parse.
 *
 * The three `*_at` milestones and `tracking` are ALWAYS present, explicit
 * `null` until each exists — the wire rule for nullable fields.
 */
export const orderSchema = z
	.object({
		/** Mongo ObjectId hex — opaque to us, but its shape never drifts. */
		id: z.string().regex(/^[0-9a-f]{24}$/),
		/**
		 * The non-marketplace channel family: `YYMMDD/NNNN-{TOKEN}`. The
		 * marketplace's reserved `WONDER-…-BATCH` shape must NEVER appear on
		 * this surface — a storefront token can only read its own channel's
		 * orders. The pilot channel's exact token is asserted in the tests
		 * (registry data, not schema).
		 */
		order_number: z.string().regex(/^\d{6}\/\d{4}-[A-Z0-9][A-Z0-9-]*$/),
		/** The per-order secret — shown once here, required by every order read. */
		order_token: z.string().min(1),
		payment_status: z.string().min(1),
		fulfilment_status: z.string().min(1),
		delivery_status: z.string().min(1),
		/** An order cannot be empty — placement refuses an empty cart. */
		items: z.array(orderItemSchema).min(1),
		totals: orderTotalsSchema,
		shipping_fee: grossMoneySchema,
		delivery: z
			.object({
				method_id: z.string().min(1),
				collection_point_code: z.string().nullable(),
			})
			.strict(),
		tracking: orderTrackingSchema.nullable(),
		buyer_reference: z.string().nullable(),
		created_at: z.string().datetime(),
		paid_at: z.string().datetime().nullable(),
		dispatched_at: z.string().datetime().nullable(),
		delivered_at: z.string().datetime().nullable(),
	})
	.strict();

export const orderResponseSchema = z
	.object({
		success: z.literal(true),
		data: z.object({ order: orderSchema }).strict(),
	})
	.strict();

/**
 * `POST /orders/:id/payment-session` — one shape, three states, discriminated
 * by `state`. The per-state differences are contract, not accident:
 *
 *   - `created` — a fresh processor session: the store initialises the
 *     processor's SDK with `client_token`, so both `processor` and
 *     `client_token` must be present (a created session with no token is
 *     unusable, and the schema says so).
 *   - `replayed` — the stored session verbatim; `client_token`/`processor`
 *     may be null (a method that never stored one / a session predating the
 *     field).
 *   - `already_paid` — `client_token` is REQUIRED null. This is the
 *     wallet-guard pin: money is in flight or moved, and a finalised
 *     processor token handed back here makes the SDK mint a duplicate,
 *     untracked charge. A non-null token in this state is the regression
 *     this schema exists to catch.
 *
 * `processor` is a CLOSED picklist — the engine speaks Revolut and PayU; any
 * other value reaching the wire is drift, not a new processor.
 */
const paymentProcessorSchema = z.enum(['revolut', 'payu']);

export const paymentSessionSchema = z.discriminatedUnion('state', [
	z
		.object({
			state: z.literal('created'),
			processor: paymentProcessorSchema,
			processor_order_id: z.string().min(1),
			client_token: z.string().min(1),
		})
		.strict(),
	z
		.object({
			state: z.literal('replayed'),
			processor: paymentProcessorSchema.nullable(),
			processor_order_id: z.string().min(1),
			client_token: z.string().min(1).nullable(),
		})
		.strict(),
	z
		.object({
			state: z.literal('already_paid'),
			processor: paymentProcessorSchema.nullable(),
			processor_order_id: z.string().min(1),
			client_token: z.null(),
		})
		.strict(),
]);

export const paymentSessionResponseSchema = z
	.object({
		success: z.literal(true),
		data: z.object({ payment_session: paymentSessionSchema }).strict(),
	})
	.strict();

/**
 * `POST /orders/:id/verify-payment`. `status` is the order's payment status
 * AFTER the call — a CLOSED picklist restating API.md's list verbatim.
 * `reconciled` says whether THIS call flipped it; the contract tells stores
 * to poll on `status`, never on `reconciled`.
 */
export const verifyPaymentResponseSchema = z
	.object({
		success: z.literal(true),
		data: z
			.object({
				status: z.enum([
					'pending',
					'processing',
					'authorised',
					'paid',
					'declined',
					'failed',
					'cancelled',
					'refunded',
					'partially_refunded',
				]),
				reconciled: z.boolean(),
			})
			.strict(),
	})
	.strict();

/**
 * The one error whose `details` is CONTRACT, not diagnostics: 409
 * `INSUFFICIENT_STOCK` promises `details.lines[]` naming each variant that
 * could not be reserved, so a store can render exactly which lines to trim.
 * Strict throughout — the generic `errorSchema` would accept any `details`
 * blob, which is precisely the drift this schema exists to catch.
 */
export const insufficientStockErrorSchema = z
	.object({
		success: z.literal(false),
		error: z
			.object({
				category: z.literal('conflict'),
				message: z.string().min(1),
				code: z.literal('INSUFFICIENT_STOCK'),
				details: z
					.object({
						lines: z
							.array(
								z
									.object({
										variant_id: z.string().min(1),
										name: z.string().min(1),
										requested_quantity: z.number().int().positive(),
										available_stock: z.number().int().nonnegative(),
									})
									.strict(),
							)
							.min(1),
					})
					.strict(),
			})
			.strict(),
	})
	.strict();
