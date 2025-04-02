import { RouteHandler } from "exports/route";
import { NextFunction, Request, Response } from "express";
import { GetCollection } from "../../helpers/database";
import { readDirRecursive } from "../../helpers/readDirRecursive";
import path from "path";
import { createReadStream, statSync } from "fs";
import cors from "cors";
import { sendMail } from "../../helpers/sendMail";
import { getLogger } from "../../helpers/logger";

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
		let downloadCompleted = false;

		// Validate token
		if (!req.query.token) {
			return res.status(400).json({ error: "NO_TOKEN" });
		}

		const token = req.query.token as string;
		const collection = await GetCollection("movie_links");

		// Check if document exists
		const document = await collection.findOne({ token });

		if (!document) {
			return res.status(400).json({ error: "TOKEN_INVALID" });
		}

		// If already downloaded, prevent further downloads
		if (document.downloadedAt) {
			return res.status(403).json({ error: "DOWNLOAD_ALREADY_COMPLETED" });
		}

		// If locked by another download process
		if (document.locked) {
			return res.status(409).json({ error: "DOWNLOAD_IN_PROGRESS" });
		}

		// Lock the document
		await collection.updateOne({ token }, { $set: { locked: true } });

		// Find the movie file
		const file = await findMovieFile("Heuried.mp4");
		if (!file) {
			await collection.updateOne({ token }, { $set: { locked: false } });
			return res.status(500).json({ error: "MOVIE_FILE_NOT_FOUND" });
		}

		// Get file stats
		const fileStats = statSync(file);
		const fileSize = fileStats.size;

		// Log download started
		logger.info(`🎬 Download started for token: ${token}, IP: ${req.ip}, file: ${file}, size: ${fileSize} bytes`);

		// Handle client disconnect by unlocking if download not completed
		req.on("close", async () => {
			if (!downloadCompleted) {
				logger.info(`⏸️ Download paused/interrupted for token: ${token}`);
				try {
					await collection.updateOne({ token }, { $set: { locked: false } });
				} catch (err) {
					logger.error(`❌ Failed to unlock document on disconnect: ${err}`);
				}
			}
		});

		// Set common headers
		res.setHeader("Accept-Ranges", "bytes");
		res.setHeader("Content-Type", "video/mp4");
		res.setHeader("Content-Disposition", 'attachment; filename="Heuried.mp4"');

		try {
			// Handle range request
			const range = req.headers.range;

			if (range) {
				// Parse range
				const parts = range.replace(/bytes=/, "").split("-");
				const start = parseInt(parts[0], 10);
				// If end is not specified, use fileSize-1
				const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
				// Limit end to file size
				const finalEnd = Math.min(end, fileSize - 1);
				const chunkSize = finalEnd - start + 1;
				const percentOfFile = (chunkSize / fileSize * 100).toFixed(2);

				logger.info(`📥 Serving range: ${start}-${finalEnd} (${chunkSize} bytes, ${percentOfFile}%) for token: ${token}`);

				// Send partial content response
				res.status(206);
				res.setHeader("Content-Length", chunkSize);
				res.setHeader("Content-Range", `bytes ${start}-${finalEnd}/${fileSize}`);

				// Create read stream for the range
				const stream = createReadStream(file, { start, end: finalEnd });

				// Handle successful completion of the range
				res.on("finish", async () => {
					// Only mark as complete if this is the FULL file (start at 0)
					// or a very small start position (accepting first few bytes might be missing)
					const isCompleteDownload = start <= 1024 && finalEnd >= fileSize - 1024; // Allow 1KB tolerance

					if (isCompleteDownload) {
						downloadCompleted = true;
						logger.info(`✅ Download completed for token: ${token}`);

						try {
							await collection.updateOne(
								{ token },
								{
									$set: {
										downloadedAt: new Date(),
										locked: true // Keep locked after completion
									}
								}
							);

							// Send email notification
							sendMail(document.email, "Ihre Bestellung: Film heruntergeladen", "movie_downloaded.html");
							logger.info(`📧 Email sent to ${document.email} for completed download`);
						} catch (err) {
							logger.error(`❌ Failed to update document or send email: ${err}`);
						}
					} else {
						// Track progress - calculate how much was downloaded
						const percentComplete = ((fileSize - start) / fileSize * 100).toFixed(2);
						logger.info(`🔄 Range request completed (${start}-${finalEnd}), progress: ~${percentComplete}%`);

						// Check if the client has downloaded most of the file (>95%)
						if (percentComplete >= 95) {
							// If we're over 95%, consider it complete
							downloadCompleted = true;
							logger.info(`✅ Download considered complete (${percentComplete}%) for token: ${token}`);

							try {
								await collection.updateOne(
									{ token },
									{
										$set: {
											downloadedAt: new Date(),
											locked: true // Keep locked after completion
										}
									}
								);

								// Send email notification
								sendMail(document.email, "Ihre Bestellung: Film heruntergeladen", "movie_downloaded.html");
								logger.info(`📧 Email sent to ${document.email} for completed download`);
							} catch (err) {
								logger.error(`❌ Failed to update document or send email: ${err}`);
							}
						} else {
							// Otherwise, unlock for future download attempts
							await collection.updateOne({ token }, { $set: { locked: false } });
						}
					}
				});

				// Pipe the file stream to response
				stream.pipe(res);

				// Handle errors in the file stream
				stream.on("error", async (err) => {
					logger.error(`❌ Error streaming file: ${err}`);
					if (!res.headersSent) {
						res.status(500).json({ error: "STREAMING_ERROR" });
					}
					try {
						await collection.updateOne({ token }, { $set: { locked: false } });
					} catch (unlockErr) {
						logger.error(`❌ Failed to unlock document: ${unlockErr}`);
					}
				});

			} else {
				// Full file download
				logger.info(`📥 Full download requested for token: ${token}`);
				res.setHeader("Content-Length", fileSize);

				// Create read stream for the entire file
				const stream = createReadStream(file);

				// Handle successful completion
				res.on("finish", async () => {
					downloadCompleted = true;
					logger.info(`✅ Full download completed for token: ${token}`);

					try {
						await collection.updateOne(
							{ token },
							{
								$set: {
									downloadedAt: new Date(),
									locked: true // Keep locked after completion
								}
							}
						);

						// Send email notification
						sendMail(document.email, "Ihre Bestellung: Film heruntergeladen", "movie_downloaded.html");
						logger.info(`📧 Email sent to ${document.email} for completed download`);
					} catch (err) {
						logger.error(`❌ Failed to update document or send email: ${err}`);
					}
				});

				// Pipe the file stream to response
				stream.pipe(res);

				// Handle errors in the file stream
				stream.on("error", async (err) => {
					logger.error(`❌ Error streaming file: ${err}`);
					if (!res.headersSent) {
						res.status(500).json({ error: "STREAMING_ERROR" });
					}
					try {
						await collection.updateOne({ token }, { $set: { locked: false } });
					} catch (unlockErr) {
						logger.error(`❌ Failed to unlock document: ${unlockErr}`);
					}
				});
			}

		} catch (err) {
			logger.error(`❌ Unexpected error in download handler: ${err}`);
			if (!res.headersSent) {
				res.status(500).json({ error: "SERVER_ERROR" });
			}
			try {
				await collection.updateOne({ token }, { $set: { locked: false } });
			} catch (unlockErr) {
				logger.error(`❌ Failed to unlock document: ${unlockErr}`);
			}
		}
	},
} satisfies RouteHandler;