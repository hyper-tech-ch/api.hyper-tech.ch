import { RouteHandler } from "exports/route";
import { NextFunction, Request, Response } from "express";
import { GetCollection } from "../../helpers/database";
import cors from "cors";
import { getLogger } from "../../helpers/logger";
import { clamp } from "lodash";
import { sendMail } from "../../helpers/sendMail";

export default {
	Method: "post", // Keep as POST since your client is using POST
	Path: "/movies/progress", // Keep the path as /movies/progress
	Priority: 0,

	AuthorizationGroup: null,
	Middleware: [
		cors({
			origin: "*",
			methods: ["POST"], // Change to POST to match your client request
			credentials: true
		}),
	],

	OnRequest: async function (req: Request, res: Response, next: NextFunction) {
		const logger = getLogger();
		const { token, progress } = req.query;

		if (!token || !progress) {
			return res.status(400).json({ error: "MISSING_PARAMETERS" });
		}

		// Log the client progress
		logger.info(`📱 Client reports progress: ${progress}% for token: ${token}`);

		// Optionally store this in your database
		const collection = await GetCollection("movie_links");
		if (progress === "100") {
			await collection.updateOne({ token }, {
				$set: {
					locked: false,
					downloadedAt: new Date(),
					progress: 100,
				}
			});

			let document = await collection.findOne({ token });
			if (!document) {
				logger.error(`Document with token ${token} not found after download completion.`);
				return res.status(404).json({ error: "DOCUMENT_NOT_FOUND" });
			} else {
				let sendMailSuccess = await sendMail(
					document.email,
					"Ihre Bestellung: Film heruntergeladen",
					"movie_downloaded.html",
				
				);

				if(sendMailSuccess) {
					logger.info(`Client just reported a progress of 100% for token: ${token} (${progress}%)`);
					logger.info(`✅ Download completed and email sent to ${document.email}`);
				} else {
					logger.error(`❌ Failed to send email to ${document.email}`);
				}
			}
		} else if (progress === "-1") {
			// Handle aborted, failed or incomplete downloads
			await collection.updateOne({ token }, {
				$set: {
					locked: false,
					progress: -1,
					downloadedAt: null,
					errorAt: new Date()
				}
			});
			logger.warn(`⚠️ Client reported download failure/cancellation for token: ${token}`);
		} else {
			await collection.updateOne({ token }, {
				$set: {
					locked: true,
					progress: clamp(parseInt(progress as string, 10), 0, 100),
				}
			});
		}

		// Return success
		return res.status(200).json({ success: true });
	}
} satisfies RouteHandler;