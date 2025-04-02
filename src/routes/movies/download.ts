import { RouteHandler } from "exports/route";
import { NextFunction, Request, Response } from "express";
import { GetCollection } from "../../helpers/database";
import { readDirRecursive } from "../../helpers/readDirRecursive";
import path from "path";
import { createReadStream, statSync } from "fs";
import cors from "cors";
import { sendMail } from "../../helpers/sendMail";
import { getLogger } from "../../helpers/logger";

// Merge overlapping or adjacent [start, end] segments
function mergeRanges(ranges: Array<{ start: number; end: number }>) {
	if (!ranges.length) return [];

	// Sort by starting offset
	ranges.sort((a, b) => a.start - b.start);

	const merged: Array<{ start: number; end: number }> = [];
	let current = { ...ranges[0] };

	for (let i = 1; i < ranges.length; i++) {
		const range = ranges[i];
		// If next range overlaps or is adjacent, merge
		if (range.start <= current.end + 1) {
			current.end = Math.max(current.end, range.end);
		} else {
			merged.push(current);
			current = { ...range };
		}
	}
	merged.push(current);
	return merged;
}

// Calculate total downloaded bytes from ranges
function totalBytesDownloaded(ranges: Array<{ start: number; end: number }>) {
	return ranges.reduce((total, range) => {
		return total + (range.end - range.start + 1);
	}, 0);
}

// Check if the ranges cover the entire file
function isFullyCovered(ranges: Array<{ start: number; end: number }>, fileSize: number) {
	// Sort and merge ranges first
	const merged = mergeRanges(ranges);

	// Calculate total bytes downloaded
	const totalBytes = totalBytesDownloaded(merged);
	const downloadPercentage = (totalBytes / fileSize) * 100;

	// If we've downloaded at least 99.9% of the file, consider it complete
	if (downloadPercentage >= 99.9) {
		return true;
	}

	// If there's a single range from 0 to end, it's complete
	if (merged.length === 1 && merged[0].start === 0 && merged[0].end >= fileSize - 1) {
		return true;
	}

	// Check if merged ranges cover the full file with no gaps
	if (merged.length > 0) {
		if (merged[0].start !== 0) return false;

		let currentEnd = merged[0].end;
		for (let i = 1; i < merged.length; i++) {
			if (merged[i].start > currentEnd + 1) return false;
			currentEnd = Math.max(currentEnd, merged[i].end);
		}

		return currentEnd >= fileSize - 1;
	}

	return false;
}

// Helper function to log download progress
function logDownloadProgress(ranges: Array<{ start: number; end: number }>, fileSize: number, logger: any, token: string, reason: string) {
	const mergedRanges = mergeRanges(ranges);
	const totalBytes = totalBytesDownloaded(mergedRanges);
	const progressPercentage = (totalBytes / fileSize * 100).toFixed(2);

	logger.info(`📊 Download progress [${reason}]: ${totalBytes}/${fileSize} bytes (${progressPercentage}%) for token: ${token}`);

	// Log details of merged ranges for debugging
	if (mergedRanges.length > 0) {
		logger.debug(`📊 Range details: ${mergedRanges.length} merged range(s)`);
		mergedRanges.forEach((range, i) => {
			const rangeSize = range.end - range.start + 1;
			const rangePercent = (rangeSize / fileSize * 100).toFixed(2);
			logger.debug(`📊 Range ${i + 1}: ${range.start}-${range.end} (${rangeSize} bytes, ${rangePercent}%)`);
		});
	}

	return { totalBytes, progressPercentage };
}

async function findMovieFile(fileName: string): Promise<string | null> {
	const emailsDir = path.resolve(__dirname, "../../../assets/movies");
	const files = await readDirRecursive(emailsDir);
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
			exposedHeaders: ["Content-Disposition", "Content-Length"],
		}),
	],

	OnRequest: async function (req: Request, res: Response, next: NextFunction) {
		const logger = getLogger();

		if (!req.query.token) {
			res.status(400).json({ error: "NO_TOKEN" });
			return;
		}

		const token = req.query.token as string;
		const collection = await GetCollection("movie_links");

		// Check if the document is available
		let document = await collection.findOne({ token });

		// If there's already a downloadedAt timestamp, the download was completed
		if (document?.downloadedAt) {
			res.status(403).json({ error: "DOWNLOAD_ALREADY_COMPLETED" });
			return;
		}

		// Check if document exists and is not locked
		if (!document) {
			res.status(400).json({ error: "TOKEN_INVALID" });
			return;
		}

		if (document.locked) {
			res.status(400).json({ error: "DOWNLOAD_IN_PROGRESS", message: "Another download is in progress with this token" });
			return;
		}

		// Locate the movie file
		const file = await findMovieFile("Heuried.mp4");
		if (!file) {
			res.status(500).json({ error: "MOVIE_FILE_NOT_FOUND" });
			return;
		}

		// Get file stats
		const fileStats = statSync(file);
		const fileSize = fileStats.size;

		// Log current progress before starting new stream if partial ranges exist
		if (document.partialRanges && document.partialRanges.length > 0) {
			logDownloadProgress(document.partialRanges, fileSize, logger, token, "RESUME");
		}

		// Lock the document to prevent parallel downloads
		await collection.updateOne({ token }, { $set: { locked: true } });

		const rangeHeader = req.headers.range;

		logger.info(`Streaming file: ${file} to IP: ${req.ip} with token: ${token}`);

		let bytesStreamed = 0;
		let downloadSuccessful = false;

		// Ensure partialRanges array exists in the doc
		if (!document.partialRanges) {
			document.partialRanges = [];
			await collection.updateOne({ token }, { $set: { partialRanges: [] } });
		}

		// Unlock if the client disconnects and we haven't flagged success
		req.on("close", async () => {
			if (!downloadSuccessful) {
				try {
					// Get the current document state to log progress
					const currentDoc = await collection.findOne({ token });
					if (currentDoc?.partialRanges) {
						logDownloadProgress(currentDoc.partialRanges, fileSize, logger, token, "PAUSED");
					}

					logger.info("⚠️ Client disconnected before download completed. Unlocking document to allow resume.");
					await collection.updateOne({ token }, { $set: { locked: false } });
				} catch (err) {
					logger.error("❌ Failed to unlock the document on client disconnect:", err);
				}
			}
		});

		if (rangeHeader) {
			// Parse the range for partial content
			const [startStr, endStr] = rangeHeader.replace(/bytes=/, "").split("-");
			const start = parseInt(startStr, 10);
			const end = endStr ? parseInt(endStr, 10) : fileSize - 1;

			// Prevent end from exceeding file size
			const safeEnd = Math.min(end, fileSize - 1);
			const chunkSize = safeEnd - start + 1;

			// Log the specific range being requested
			logger.info(`📥 Range request: ${start}-${safeEnd} (${chunkSize} bytes, ${(chunkSize / fileSize * 100).toFixed(2)}% of file) for token: ${token}`);

			res.writeHead(206, {
				"Content-Range": `bytes ${start}-${safeEnd}/${fileSize}`,
				"Accept-Ranges": "bytes",
				"Content-Length": chunkSize,
				"Content-Type": "video/mp4",
				"Content-Disposition": 'attachment; filename="Heuried.mp4"',
			});

			const fileStream = createReadStream(file, { start, end: safeEnd });

			fileStream.on("data", chunk => {
				bytesStreamed += chunk.length;
			});

			// When the response is finished flushing data
			res.on("finish", async () => {
				try {
					// Get the latest document state
					const docNow = await collection.findOne({ token });
					if (!docNow) {
						logger.error("❌ Document missing after range download");
						return;
					}

					// Record the served range in document
					const existingRanges = docNow.partialRanges || [];
					existingRanges.push({ start, end: safeEnd });

					// Make sure we have no duplicate or overlapping ranges
					const mergedRanges = mergeRanges(existingRanges);

					// Log progress after this chunk
					const { totalBytes, progressPercentage } = logDownloadProgress(
						mergedRanges,
						fileSize,
						logger,
						token,
						"CHUNK_COMPLETED"
					);

					// First update the ranges regardless of completion
					await collection.updateOne(
						{ token },
						{ $set: { partialRanges: mergedRanges } }
					);

					// Check if download is complete
					if (isFullyCovered(mergedRanges, fileSize)) {
						// Mark as successful
						downloadSuccessful = true;
						logger.info(`✅ Range-based download COMPLETED for token: ${token} from IP: ${req.ip}`);
						logger.info(`✅ Total bytes: ${totalBytes}/${fileSize} (${progressPercentage}%)`);

						// Update document with completion status and keep it locked
						await collection.updateOne(
							{ token },
							{
								$set: {
									downloadedAt: new Date(),
									locked: true // Lock permanently after successful download
								}
							}
						);

						// Send email notification
						try {
							sendMail(docNow.email, "Ihre Bestellung: Film heruntergeladen", "movie_downloaded.html");
							logger.info(`📧 Email sent to ${docNow.email} for completed download`);
						} catch (emailErr) {
							logger.error(`❌ Failed to send email: ${emailErr}`);
						}
					} else {
						// Unlock for future download attempts
						logger.info(`⏸️ Partial content stream finished. Unlocking for future download attempts.`);
						await collection.updateOne({ token }, { $set: { locked: false } });
					}
				} catch (err) {
					logger.error(`❌ Error updating ranges: ${err}`);
					try {
						await collection.updateOne({ token }, { $set: { locked: false } });
					} catch (unlockErr) {
						logger.error(`❌ Failed to unlock document: ${unlockErr}`);
					}
				}
			});

			fileStream.on("error", async err => {
				logger.error(`❌ Error during partial file streaming: ${err}`);
				res.status(500).json({ error: "Failed to stream the file" });
				try {
					await collection.updateOne({ token }, { $set: { locked: false } });
				} catch (unlockErr) {
					logger.error(`❌ Failed to unlock the document: ${unlockErr}`);
				}
			});

			fileStream.pipe(res);
		} else {
			// Full file download (no Range header)
			res.setHeader("Content-Length", fileSize);
			res.setHeader("Content-Type", "video/mp4");
			res.setHeader("Content-Disposition", 'attachment; filename="Heuried.mp4"');
			logger.info(`📥 Full file download requested (${fileSize} bytes) for token: ${token}`);

			const fileStream = createReadStream(file);

			fileStream.on("data", chunk => {
				bytesStreamed += chunk.length;
			});

			res.on("finish", async () => {
				// If we streamed at least 99.9% of the file size
				if (bytesStreamed >= (fileSize * 0.999)) {
					logger.info(`✅ Full file download COMPLETED for token: ${token} from IP: ${req.ip}`);
					logger.info(`✅ Total bytes: ${bytesStreamed}/${fileSize} (${(bytesStreamed / fileSize * 100).toFixed(2)}%)`);
					downloadSuccessful = true;

					try {
						// Update document with full coverage and lock it
						await collection.updateOne(
							{ token },
							{
								$set: {
									partialRanges: [{ start: 0, end: fileSize - 1 }],
									downloadedAt: new Date(),
									locked: true // Lock permanently
								},
							}
						);

						// Send email
						const docNow = await collection.findOne({ token });
						if (docNow) {
							sendMail(docNow.email, "Ihre Bestellung: Film heruntergeladen", "movie_downloaded.html");
							logger.info(`📧 Email sent to ${docNow.email} for completed download`);
						}
					} catch (err) {
						logger.error(`❌ Failed to update document or send email: ${err}`);
					}
				} else {
					logger.info(`⚠️ Full file stream ended, but only ${bytesStreamed}/${fileSize} bytes were sent (${(bytesStreamed / fileSize * 100).toFixed(2)}%).`);
					try {
						await collection.updateOne({ token }, { $set: { locked: false } });
					} catch (unlockErr) {
						logger.error(`❌ Failed to unlock the document: ${unlockErr}`);
					}
				}
			});

			fileStream.on("error", async err => {
				logger.error(`❌ Error during file streaming: ${err}`);
				res.status(500).json({ error: "Failed to stream the file" });
				try {
					await collection.updateOne({ token }, { $set: { locked: false } });
				} catch (unlockErr) {
					logger.error(`❌ Failed to unlock the document: ${unlockErr}`);
				}
			});

			fileStream.pipe(res);
		}
	},
} satisfies RouteHandler;