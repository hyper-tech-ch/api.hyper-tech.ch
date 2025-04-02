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
	// Once merged, if the first range starts at 0 and the last range ends at fileSize-1
	// and there’s only one range in that scenario, or multiple contiguous ranges covering that entire span
	// we have coverage
	const first = ranges[0];
	const last = ranges[ranges.length - 1];
	if (first.start !== 0 || last.end !== fileSize - 1) return false;

	// Also confirm no gaps between merged ranges
	for (let i = 0; i < ranges.length - 1; i++) {
		if (ranges[i].end + 1 < ranges[i + 1].start) return false;
	}
	return true;
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
				// Record the served range in the document
				try {
					const docNow = await collection.findOne({ token });
					if (!docNow) {
						logger.error("❌ Document missing after range download, cannot update partialRanges");
						return;
					}
					const existingRanges = docNow.partialRanges || [];
					existingRanges.push({ start, end });
					const mergedRanges = mergeRanges(existingRanges);
					await collection.updateOne({ token }, { $set: { partialRanges: mergedRanges } });

					// Re-fetch the doc with merged partialRanges
					const updatedDoc = await collection.findOne({ token });
					if (updatedDoc) {
						// Check coverage
						if (hasFullCoverage(updatedDoc.partialRanges || [], fileSize)) {
							downloadSuccessful = true;
							logger.info(`✅ Range-based download completed (full coverage) for token: ${token} from IP: ${req.ip}`);

							// Mark as downloadedAt and send the email
							try {
								await collection.updateOne({ token }, {
									$set: {
										downloadedAt: new Date(),
										locked: false // once fully downloaded, lock isn't needed
									}
								});
								sendMail(updatedDoc.email, "Ihre Bestellung: Film heruntergeladen", "movie_downloaded.html");
							} catch (err) {
								logger.error("❌ Failed to update document or send email:", err, "token:", token);
							}
						} else {
							logger.info("⚠️ Partial content finished, but file coverage incomplete at the moment.");
							// Just unlock; user can do subsequent requests
							await collection.updateOne({ token }, { $set: { locked: false } });
						}
					}
				} catch (err) {
					logger.error("❌ Error updating partialRanges or unlocking document:", err);
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
				// If we wrote exactly fileSize bytes, treat it as fully downloaded
				if (bytesStreamed === fileSize) {
					// Mark coverage from [0 ... fileSize-1]
					logger.info(`✅ Full file download completed for token: ${token} from IP: ${req.ip}`);
					downloadSuccessful = true;

					try {
						// Merge coverage as if from 0 to fileSize-1
						const docNow = await collection.findOne({ token });
						if (docNow) {
							const updatedRanges = mergeRanges([
								...(docNow.partialRanges || []),
								{ start: 0, end: fileSize - 1 }
							]);

							// Mark as downloaded
							await collection.updateOne(
								{ token },
								{
									$set: {
										partialRanges: updatedRanges,
										downloadedAt: new Date(),
										locked: true
									},
								},
							);

							// Double-check coverage
							if (hasFullCoverage(updatedRanges, fileSize)) {
								sendMail(docNow.email, "Ihre Bestellung: Film heruntergeladen", "movie_downloaded.html");
							}
						}
					} catch (err) {
						logger.error("❌ Failed to update document or send email:", err, "token:", token);
					}
				} else {
					logger.info("⚠️ Full file stream ended, but download was incomplete. Unlocking document.");
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