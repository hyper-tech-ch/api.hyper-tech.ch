import { RouteHandler } from "exports/route";
import { NextFunction, Request, Response } from "express";
import { GetCollection } from "../../helpers/database";
import { readDirRecursive } from "../../helpers/readDirRecursive";
import path from "path";
import cors from "cors";
import { sendMail } from "../../helpers/sendMail";
import { getLogger } from "../../helpers/logger";
import send from 'send';
import { fstat, fstatSync, statSync } from "fs";

// Simple function to find the movie file
async function findMovieFile(fileName: string): Promise<string | null> {
	const moviesDir = path.resolve(__dirname, "../../../assets/movies");
	const files = await readDirRecursive(moviesDir);
	const matchingFile = files.find(file => path.basename(file) === fileName);
	return matchingFile || null;
}

export default {
	Method: "get",
	Path: "/movies/download",
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

		// Validate token
		if (!req.query.token) {
			return res.status(400).json({ error: "NO_TOKEN" });
		}

		const token = req.query.token as string;
		const collection = await GetCollection("movie_links");

		// Check if document exists
		const document = await collection.findOne({ token });

		if (!document) {
			logger.info(`IP ${req.ip} tried to use ${token}, but it doesn't exist`);
			return res.status(400).json({ error: "TOKEN_INVALID" });
		}

		// If already downloaded, prevent further downloads
		if (document.downloadedAt) {
			logger.info(`IP ${req.ip} tried to use ${token}, but it's already downloaded`);
			return res.status(403).json({ error: "DOWNLOAD_ALREADY_COMPLETED" });
		}

		// If locked by another download process
		if (document.locked) {
			logger.info(`IP ${req.ip} tried to use ${token}, but the download is in progress`);
			return res.status(409).json({ error: "DOWNLOAD_IN_PROGRESS" });
		}

		// Find the movie file - use document.fileName if available, fallback to hardcoded name
		const movieFileName = document.fileName || "Heuried.mp4";
		const file = await findMovieFile(movieFileName);
		if (!file) {
			await collection.updateOne({ token }, { $set: { locked: false } });
			logger.error(`IP ${req.ip} tried to use ${token}, but it doesn't exist`);
			return res.status(500).json({ error: "MOVIE_FILE_NOT_FOUND" });
		}
		let fsstats = statSync(file);
		if (fsstats.size === 0) {
			return res.status(500).json({ error: "MOVIE_FILE_EMPTY" });
		}

		// Lock the document
		//await collection.updateOne({ token }, { $set: { locked: true } });
		logger.info(`⚙️ IP ${req.ip} is downloading ${movieFileName}, token: ${token} now locked`);

		const stream = send(req, file, {
			acceptRanges: true,
			cacheControl: false,
			immutable: true,
			maxAge: 0,
			end: fsstats.size - 1,
		});

		// Track download progress and completion
		stream.on('error', (err) => {
			logger.info(`❌ IP ${req.ip} failed to download ${movieFileName}, token: ${token}, error: ${err.message}`);
		});

		stream.on('progress', (progress) => {
			logger.info(`📦 IP ${req.ip} is downloading ${movieFileName}, token: ${token}, progress: ${progress}`);
		});
		res.on('close', () => {
			// This indicates the connection was closed, potentially prematurely
			if (!res.writableFinished) {
				logger.info(`😒 IP ${req.ip} closed/canceled the download of ${movieFileName}, token: ${token}`);
			}
		});
		res.on('finish', () => {
			logger.info(`✅ IP ${req.ip} finished sending ${movieFileName}, token: ${token}`);
		});

		res.setHeader('Content-Disposition', `attachment; filename="video.mp4"`);
		res.setHeader('Content-Type', 'application/octet-stream');
		stream.pipe(res);
	},
} satisfies RouteHandler;