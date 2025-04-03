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
import { Transform } from "stream";
import { throttle } from "lodash";

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
		await collection.updateOne({ token }, { $set: { locked: true } });

		const movieFileName = document.fileName || "Heuried.mp4";
		const file = await findMovieFile(movieFileName);
		if (!file) {
			await collection.updateOne({ token }, { $set: { locked: false } });
			logger.error(`IP ${req.ip} tried to use ${token}, but the movie file doesn't exist`);
			return res.status(500).json({ error: "MOVIE_FILE_NOT_FOUND" });
		}

		const stats = statSync(file);
		const fileSize = stats.size;

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
		}

		const contentLength = end - start + 1;
		res.setHeader('Content-Length', contentLength);

		// Throttled logger function to prevent excessive logging
		const throttledLogger = throttle((bytesCount: number) => {
			const percentComplete = Math.round((bytesCount / contentLength) * 100);
			logger.info(`📊 IP ${req.ip} progress: ${bytesCount}/${contentLength} bytes (${percentComplete}%) of ${movieFileName}, token: ${token}`);
		}, 2000);

		// Create a progress tracker with backpressure awareness
		let bytesSent = 0;
		const progressTracker = new Transform({
			highWaterMark: 256 * 1024, // 256KB buffer
			transform(chunk, encoding, callback) {
				bytesSent += chunk.length;

				// Check if high water mark is reached (indicates backpressure)
				const isBackpressure = this.writableLength >= this.writableHighWaterMark / 2;

				// Only log progress when not experiencing backpressure or on specific intervals
				if (!isBackpressure &&
					Math.floor((bytesSent - chunk.length) / (100 * 1024 * 1024)) <
					Math.floor(bytesSent / (100 * 1024 * 1024))) {
					throttledLogger(bytesSent);
				}

				// If experiencing backpressure, slow down a bit
				if (isBackpressure) {
					setTimeout(() => callback(null, chunk), 50);
				} else {
					callback(null, chunk);
				}
			}
		});

		// Handle connection events
		res.on('close', async () => {
			// Clear the throughput monitoring interval
			if (throughputInterval) {
				clearInterval(throughputInterval);
			}

			if (!res.writableFinished) {
				const percentComplete = Math.round((bytesSent / contentLength) * 100);
				logger.info(`😒 IP ${req.ip} closed/canceled the download at ${percentComplete}% (${bytesSent}/${contentLength} bytes) of ${movieFileName}, token: ${token}`);

				// Unlock the token if download was not completed
				await collection.updateOne({ token }, { $set: { locked: false } });
			}
		});

		// Use a more conservative approach for finish event
		res.on('finish', async () => {
			// Clear the throughput monitoring interval
			if (throughputInterval) {
				clearInterval(throughputInterval);
			}

			// Wait a short period to ensure client has actually received the data
			setTimeout(async () => {
				const percentComplete = Math.round((bytesSent / contentLength) * 100);
				logger.info(`✅ IP ${req.ip} finished sending ${bytesSent}/${contentLength} bytes of ${movieFileName}, progress: ${percentComplete}%, token: ${token}`);

				// If the entire file was requested and sent, mark as downloaded
				if (start === 0 && end === fileSize - 1 && percentComplete >= 99) {
					await collection.updateOne({ token }, {
						$set: {
							downloadedAt: new Date(),
							locked: false
						}
					});
					logger.info(`🔓 Token ${token} marked as downloaded and unlocked`);
				} else {
					// Just unlock the token for partial downloads
					await collection.updateOne({ token }, { $set: { locked: false } });
					logger.info(`🔓 Token ${token} unlocked after partial download`);
				}
			}, 2000);
		});

		// Create read stream with specified range and a smaller high water mark
		const readStream = fs.createReadStream(file, {
			start,
			end,
			highWaterMark: 64 * 1024 // 64KB chunks
		});

		// Error handling
		readStream.on('error', async (err) => {
			logger.info(`❌ IP ${req.ip} failed to download ${movieFileName}, token: ${token}, error: ${err.message}`);

			// Clear the throughput monitoring interval
			if (throughputInterval) {
				clearInterval(throughputInterval);
			}

			// Unlock the token on error
			await collection.updateOne({ token }, { $set: { locked: false } });

			if (!res.headersSent) {
				res.status(500).send('Error reading file');
			} else {
				res.end();
			}
		});

		// Setup a periodic check to monitor actual throughput
		let lastBytesSent = 0;
		const throughputInterval = setInterval(() => {
			const bytesDelta = bytesSent - lastBytesSent;
			lastBytesSent = bytesSent;

			if (bytesDelta > 0) {
				const mbPerSecond = (bytesDelta / 1024 / 1024).toFixed(2);
				logger.info(`🔄 IP ${req.ip} throughput: ${mbPerSecond} MB/s, download: ${movieFileName}, token: ${token}`);
			}

			// If the response is finished or closed, clear the interval
			if (res.writableFinished || !res.writable) {
				clearInterval(throughputInterval);
			}
		}, 5000); // Check every 5 seconds

		// Pipe through progress tracker to response
		readStream
			.pipe(progressTracker)
			.pipe(res);
	},
} satisfies RouteHandler;