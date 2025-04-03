import { RouteHandler } from "exports/route";
import { NextFunction, Request, Response } from "express";
import { GetCollection } from "../../helpers/database";
import { readDirRecursive } from "../../helpers/readDirRecursive";
import path from "path";
import cors from "cors";
import { getLogger } from "../../helpers/logger";
import { statSync } from "fs";
import rangeParser from "range-parser";
import fs from "fs";
import { clamp } from "lodash";

export default {
	Method: "post",
	Path: "/movies/download_success",
	Priority: 0,

	AuthorizationGroup: null,
	Middleware: [
		cors({
			origin: "*",
			methods: ["GET"],
			exposedHeaders: ["Content-Disposition", "Content-Length", "Content-Range", "Accept-Ranges"],
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
		if(progress === "100") {
			await collection.updateOne({ token }, {
				$set: {
					locked: false,
					downloadedAt: new Date(),
					progress: 100,
				}
			});
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