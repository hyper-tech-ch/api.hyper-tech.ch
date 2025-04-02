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

// Check if the merged list covers from 0 to fileSize - 1 inclusive
function hasFullCoverage(ranges: Array<{ start: number; end: number }>, fileSize: number) {
	if (!ranges.length) return false;

	const first = ranges[0];
	const last = ranges[ranges.length - 1];
	if (first.start !== 0 || last.end !== fileSize - 1) return false;

	// Also confirm no gaps between merged ranges
	for (let i = 0; i < ranges.length - 1; i++) {
		if (ranges[i].end + 1 < ranges[i + 1].start) return false;
	}
	return true;
}

// Calculate total downloaded bytes from ranges
function totalBytesDownloaded(ranges: Array<{ start: number; end: number }>) {
	return ranges.reduce((total, range) => {
		return total + (range.end - range.start + 1);
	}, 0);
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

		// Check if the document is available and not locked
		let document = await collection.findOne({ token, locked: false });
		if (!document) {
			res.status(400).json({ error: "TOKEN_INVALID", message: "DOCUMENT_LOCKED" });
			return;
		}

		// Locate the movie file
		const file = await findMovieFile("Heuried.mp4");
		if (!file) {
			res.status(500).json({ error: "MOVIE_FILE_NOT_FOUND" });
			return;
		}

		// Lock the document to prevent parallel downloads
		await collection.updateOne({ token }, { $set: { locked: true } });

		const fileStats = statSync(file);
		const fileSize = fileStats.size;
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
				logger.info("⚠️ Client disconnected before download completed. Unlocking document to allow resume.");
				try {
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
			const chunkSize = end - start + 1;

			res.writeHead(206, {
				"Content-Range": `bytes ${start}-${end}/${fileSize}`,
				"Accept-Ranges": "bytes",
				"Content-Length": chunkSize,
				"Content-Type": "video/mp4",
				"Content-Disposition": 'attachment; filename="Heuried.mp4"',
			});

			const fileStream = createReadStream(file, { start, end });

			fileStream.on("data", chunk => {
				bytesStreamed += chunk.length;
			});

			logger.info(`Streaming range: ${start}-${end} (${chunkSize} bytes) to IP: ${req.ip} with token: ${token}`);

			// When the response is finished flushing data
			res.on("finish", async () => {
				try {
					const docNow = await collection.findOne({ token });
					if (!docNow) {
						logger.error("❌ Document missing after range download, cannot update partialRanges");
						return;
					}

					// Record the served range in document
					const existingRanges = docNow.partialRanges || [];
					existingRanges.push({ start, end });
					const mergedRanges = mergeRanges(existingRanges);

					// Calculate total bytes downloaded from all ranges
					const totalBytes = totalBytesDownloaded(mergedRanges);

					// Log progress for debugging
					logger.debug(`Range download progress: ${totalBytes}/${fileSize} bytes (${(totalBytes / fileSize * 100).toFixed(2)}%) for token: ${token}`);

					// Check for full coverage OR if total bytes downloaded matches the file size
					// This handles cases where browsers download chunks out of order
					const isComplete =
						hasFullCoverage(mergedRanges, fileSize) ||
						totalBytes >= fileSize;

					if (isComplete && !docNow.downloadedAt) {
						// Mark as successful before updating the document
						downloadSuccessful = true;
						logger.info(`✅ Range-based download completed for token: ${token} from IP: ${req.ip}`);
						logger.info(`Total bytes: ${totalBytes}, File size: ${fileSize}`);

						// Update document with merged ranges AND completion status
						try {
							await collection.updateOne({ token }, {
								$set: {
									partialRanges: mergedRanges,
									downloadedAt: new Date(),
									locked: true // Keep it locked after successful download
								}
							});

							// Only send email if it hasn't been downloaded before
							if (!docNow.downloadedAt) {
								sendMail(docNow.email, "Ihre Bestellung: Film heruntergeladen", "movie_downloaded.html");
								logger.info(`📧 Email sent to ${docNow.email} for completed download`);
							} else {
								logger.info(`🔄 Download complete, but email already sent previously`);
							}
						} catch (err) {
							logger.error("❌ Failed to update document or send email:", err);
						}
					} else {
						// Just update the ranges
						await collection.updateOne({ token }, { $set: { partialRanges: mergedRanges } });

						if (!isComplete) {
							logger.info(`⚠️ Partial content finished. Coverage so far: ${totalBytes}/${fileSize} bytes (${Math.round(totalBytes / fileSize * 100)}%)`);
							await collection.updateOne({ token }, { $set: { locked: false } });
						}
					}
				} catch (err) {
					logger.error("❌ Error updating partial ranges:", err);
					try {
						await collection.updateOne({ token }, { $set: { locked: false } });
					} catch (unlockErr) {
						logger.error("❌ Failed to unlock document:", unlockErr);
					}
				}
			});

			fileStream.on("error", async err => {
				logger.error("❌ Error during partial file streaming:", err);
				res.status(500).json({ error: "Failed to stream the file" });
				try {
					await collection.updateOne({ token }, { $set: { locked: false } });
				} catch (unlockErr) {
					logger.error("❌ Failed to unlock the document:", unlockErr);
				}
			});

			fileStream.pipe(res);

		} else {
			// Full file download (no Range header)
			res.setHeader("Content-Length", fileSize);
			res.setHeader("Content-Type", "video/mp4");
			res.setHeader("Content-Disposition", 'attachment; filename="Heuried.mp4"');

			const fileStream = createReadStream(file);

			fileStream.on("data", chunk => {
				bytesStreamed += chunk.length;
			});

			res.on("finish", async () => {
				// If we streamed exactly fileSize bytes
				if (bytesStreamed === fileSize) {
					logger.info(`✅ Full file download completed for token: ${token} from IP: ${req.ip}`);
					downloadSuccessful = true;

					try {
						// Get current document state
						const docNow = await collection.findOne({ token });
						if (!docNow) {
							logger.error("❌ Document missing after full download");
							return;
						}

						// Update document with full coverage
						await collection.updateOne(
							{ token },
							{
								$set: {
									partialRanges: [{ start: 0, end: fileSize - 1 }],
									downloadedAt: new Date(),
									locked: true, // lock to prevent further downloads
								},
							}
						);

						// Only send email if it hasn't been downloaded before
						if (!docNow.downloadedAt) {
							sendMail(docNow.email, "Ihre Bestellung: Film heruntergeladen", "movie_downloaded.html");
							logger.info(`📧 Email sent to ${docNow.email} for completed download`);
						} else {
							logger.info(`🔄 Download complete, but email already sent previously`);
						}
					} catch (err) {
						logger.error("❌ Failed to update document or send email:", err);
					}
				} else {
					logger.info(`⚠️ Full file stream ended, but only ${bytesStreamed}/${fileSize} bytes were sent.`);
					try {
						await collection.updateOne({ token }, { $set: { locked: false } });
					} catch (unlockErr) {
						logger.error("❌ Failed to unlock the document:", unlockErr);
					}
				}
			});

			fileStream.on("error", async err => {
				logger.error("❌ Error during file streaming:", err);
				res.status(500).json({ error: "Failed to stream the file" });
				try {
					await collection.updateOne({ token }, { $set: { locked: false } });
				} catch (unlockErr) {
					logger.error("❌ Failed to unlock the document:", unlockErr);
				}
			});

			fileStream.pipe(res);
		}
	},
} satisfies RouteHandler;