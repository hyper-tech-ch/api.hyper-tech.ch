import bodyParser from "body-parser";
import { RouteHandler } from "exports/route";
import { NextFunction, Request, Response } from "express";
import { sendMail } from "../../helpers/sendMail";
import Stripe from 'stripe';
import { GetCollection } from "../../helpers/database";
import { getLogger } from "../../helpers/logger";
import { v1 as uuidv1 } from 'uuid';

export default {
	Method: "post",
	Path: "/stripe/webhook",
	Priority: 0,
	
	AuthorizationGroup: null,
	Middleware: bodyParser.raw({ type: 'application/json' }),

	OnRequest: async function (req: Request, res: Response, next: NextFunction) {
		const sig = req.headers['stripe-signature'];
		const endpointSecret = process.env.STRIPE_SIGNING_SECRET;
		let event: Stripe.Event;
		
		const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
		const logger = getLogger();

		try {
			// Verify the webhook signature
			if (!sig) { res.send({ error: "No signature" }); return; };

			event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
		} catch (err: any) {
			logger.warn(`Webhook signature verification failed: ${err.message} for IP: ${req.ip}`);
			return res.status(400).send(`Could not verify webhook signature.`);
		}

		switch (event.type) {
			case "checkout.session.completed":
				const session = event.data.object as Stripe.Checkout.Session;

				logger.info(`Charge succeeded: ${session.customer_details?.email}`);

				const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
				const purchasedProductIds = lineItems.data.map(item => item.price?.product);
				logger.info(`Purchased Product IDs: ${purchasedProductIds}`);

				if (!purchasedProductIds.includes(process.env.STRIPE_MOVIE_PRODUCT_ID)) {
					logger.info("❌ Mot a movie purchase");
					return res.status(200).json({ received: true });
				} else {
					logger.info("✅ This is a movie purchase");
				}

				if(session.customer_details?.email) {
					// Create the link inside the Database
					let collection = await GetCollection("movie_links");
					let token = uuidv1();
					let link = "https://hyper-tech.ch/movie/download?token=" + token;

					await collection.insertOne({
						email: session.customer_details.email,
						token: token,
						purchasedAt: new Date(),

						locked: false,
						downloadedAt: null,
					});

					// Send the link to the customer
					let sendMailSuccess = await sendMail(
						session.customer_details.email,
						"Ihre Bestellung: Download Link",
						"movie_order.html",
						{
							"DOWNLOAD_LINK": link,
						}
					);

					if(sendMailSuccess) {
						return res.status(200).json({ received: true, message: "No code was ran." });
					} else {
						return res.status(500).json({ received: true, message: "Error sending email." });
					}
				}

				return res.status(200).json({ received: true, message: "No code was executed: no customer E-Mail" });
			default:
				return res.status(200).json({ received: true, message: "No code was executed." });
		}
	}
} satisfies RouteHandler