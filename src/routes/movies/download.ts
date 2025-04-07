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

		// Lock the token for download
		await collection.updateOne({ token }, { $set: { locked: false } });

		const movieFileName = document.fileName || "Heuried.mp4";
		const file = await findMovieFile(movieFileName);
		if (!file) {
			await collection.updateOne({ token }, { $set: { locked: false } });
			logger.error(`IP ${req.ip} tried to use ${token}, but the movie file doesn't exist`);
			return res.status(500).json({ error: "MOVIE_FILE_NOT_FOUND" });
		}

		const stats = statSync(file);
		const fileSize = stats.size;
		const etag = `"${stats.mtime.getTime().toString(16)}"`;

		res.setHeader("ETag", etag);
		if (req.headers['if-none-match'] === etag) {
			return res.status(304).end();
		}

		if (fileSize === 0) {
			await collection.updateOne({ token }, { $set: { locked: false } });
			return res.status(500).json({ error: "MOVIE_FILE_EMPTY" });
		}

		logger.info(`⚙️ IP ${req.ip} is downloading ${movieFileName}, token: ${token} now locked`);

		// Set content-type and attachment headers
		res.setHeader('Content-Disposition', `attachment; filename="video.mp4"`);
		res.setHeader('Content-Type', 'application/octet-stream');
		res.setHeader('Accept-Ranges', 'bytes');

		// Parse range headers
		let start = 0;
		let end = fileSize - 1;

		// Handle range request
		const rangeHeader = req.headers.range;
		if (rangeHeader) {
			const ranges = rangeParser(fileSize, rangeHeader);

			if (ranges === -1 || ranges === -2 || ranges.type !== 'bytes') {
				// Invalid range
				await collection.updateOne({ token }, { $set: { locked: false } });
				return res.status(416).send('Range Not Satisfiable');
			}

			// Get the first range only
			const range = ranges[0];
			start = range.start;
			end = range.end;

			// Set 206 Partial Content
			res.status(206);
			res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
			logger.info(`📏 IP ${req.ip} requested bytes ${start}-${end}/${fileSize} of ${movieFileName}, token: ${token}`);
		} else {
			res.status(200);
			res.setHeader('Content-Length', fileSize);
		}

		const contentLength = end - start + 1;
		res.setHeader('Content-Length', contentLength);

		// Handle connection events
		res.on('close', async () => {
			if (!res.writableFinished) {
				logger.info(`IP ${req.ip} closed connection for ${movieFileName}, token: ${token}`);
				await collection.updateOne({ token }, { $set: { locked: false } });
			}
		});

		// Handle download completion
		res.on('finish', async () => {
			logger.info(`IP ${req.ip} finished downloading ${movieFileName}, token: ${token}`);
			await collection.updateOne({ token }, { $set: { locked: false } });
		});

		// Create read stream with specified range
		const readStream = fs.createReadStream(file, {
			start,
			end
		});

		// Error handling
		readStream.on('error', async (err) => {
			logger.error(`Error streaming ${movieFileName} for token ${token}: ${err.message}`);
			await collection.updateOne({ token }, { $set: { locked: false } });

			if (!res.headersSent) {
				res.status(500).send('Error reading file');
			} else {
				res.end();
			}
		});

		// Pipe the file to response
		readStream.pipe(res);
	},
} satisfies RouteHandler;