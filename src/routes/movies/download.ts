import { RouteHandler } from "exports/route";
import { NextFunction, Request, Response } from "express";
import { GetCollection } from "../../helpers/database";
import { readDirRecursive } from "../../helpers/readDirRecursive";
import path from "path";
import { createReadStream, statSync } from "fs";
import cors from "cors";
import { sendMail } from "../../helpers/sendMail";
import { getLogger } from "../../helpers/logger";

async function findMovieFile(fileName: string): Promise<string | null> {
	const emailsDir = path.resolve(__dirname, '../../../assets/movies');
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
		const document = await collection.findOne({ token: token, locked: false });
		if (!document) {
			res.status(400).json({ error: "TOKEN_INVALID", message: "DOCUMENT_LOCKED" });
			return;
		}

		// Find the movie file
		const file = await findMovieFile("Heuried.mp4");
		if (!file) {
			res.status(500).json({ error: "MOVIE_FILE_NOT_FOUND" });
			return;
		}

		// Lock the document
		await collection.updateOne({ token: token }, { $set: { locked: true } });

		const fileStats = statSync(file);
		const fileSize = fileStats.size;
		const rangeHeader = req.headers.range;
		let downloadSuccessful = false;
		let bytesStreamed = 0;

		logger.info(`Streaming file: ${file} to IP: ${req.ip} with token: ${token}`);

		// Helper to unlock if download wasn’t flagged as successful
		req.on("close", async () => {
			if (!downloadSuccessful) {
				logger.info("⚠️ Client disconnected before download completed. Unlocking document to allow resume.");
				try {
					await collection.updateOne({ token: token }, { $set: { locked: false } });
				} catch (unlockErr) {
					logger.error("❌ Failed to unlock the document on client disconnect:", unlockErr);
				}
			}
		});

		if (rangeHeader) {
			// Partial content
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

			// Listen to the response "finish" to be sure everything was flushed
			res.on("finish", async () => {
				if (bytesStreamed === chunkSize && end === fileSize - 1) {
					downloadSuccessful = true;
					logger.info(`✅ Range-based download completed for token: ${token} from IP: ${req.ip}`);

					try {
						await collection.updateOne({ token: token }, { $set: { downloadedAt: new Date() } });
						sendMail(document.email, "Ihre Bestellung: Film heruntergeladen", "movie_downloaded.html");
					} catch (err) {
						logger.error("❌ Failed to update document or send email:", err, "token:", token);
					}
				} else {
					logger.info("⚠️ Partial content finished, but not the entire file.");
				}
			});

			fileStream.on("error", async err => {
				logger.error("❌ Error during partial file streaming:", err);
				res.status(500).json({ error: "Failed to stream the file" });
				try {
					await collection.updateOne({ token: token }, { $set: { locked: false } });
				} catch (unlockErr) {
					logger.error("❌ Failed to unlock the document:", unlockErr);
				}
			});

			fileStream.pipe(res);
		} else {
			// Full file download
			res.setHeader("Content-Length", fileSize);
			res.setHeader("Content-Type", "video/mp4");
			res.setHeader("Content-Disposition", 'attachment; filename="Heuried.mp4"');

			const fileStream = createReadStream(file);

			fileStream.on("data", chunk => {
				bytesStreamed += chunk.length;
			});

			// Use res.on("finish") to confirm all bytes are flushed
			res.on("finish", async () => {
				if (bytesStreamed === fileSize) {
					downloadSuccessful = true;
					logger.info(`✅ Full file download completed for token: ${token} from IP: ${req.ip}`);

					try {
						await collection.updateOne({ token: token }, { $set: { downloadedAt: new Date() } });
						sendMail(document.email, "Ihre Bestellung: Film heruntergeladen", "movie_downloaded.html");
					} catch (err) {
						logger.error("❌ Failed to update document or send email:", err, "token:", token);
					}
				} else {
					logger.info("⚠️ Full file stream ended, but download was incomplete.");
				}
			});

			fileStream.on("error", async err => {
				logger.error("❌ Error during file streaming:", err);
				res.status(500).json({ error: "Failed to stream the file" });
				try {
					await collection.updateOne({ token: token }, { $set: { locked: false } });
				} catch (unlockErr) {
					logger.error("❌ Failed to unlock the document:", unlockErr);
				}
			});

			fileStream.pipe(res);
		}
	}
} satisfies RouteHandler;