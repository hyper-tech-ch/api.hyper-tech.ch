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
			origin: "*", // Allow requests from any origin
			methods: ["GET"],
			exposedHeaders: ["Content-Disposition", "Content-Length"],
		}),
	],

	OnRequest: async function (req: Request, res: Response, next: NextFunction) {
		if (!req.query.token) {
			res.status(400).json({ error: "NO_TOKEN" });
			return;
		}

		let token = req.query.token as string;
		let collection = await GetCollection("movie_links");
		const logger = getLogger();

		let document = await collection.findOne({ token: token, locked: false });

		if (!document) {
			res.status(400).json({ error: "TOKEN_INVALID", message: "DOCUMENT_LOCKED" });
			return;
		}

		let file = await findMovieFile("Heuried.mp4");

		if (!file) {
			res.status(500).json({ error: "MOVIE_FILE_NOT_FOUND" });
			return;
		}

		const fileStats = statSync(file); // Get file stats to determine the size
		const fileSize = fileStats.size;
		res.setHeader("Content-Length", fileSize);

		const fileStream = createReadStream(file);
		logger.info(`Streaming file: ${file} to IP: ${req.ip} with token: ${token}`);

		// Set headers for the response
		res.setHeader("Content-Type", "video/mp4");
		res.setHeader("Content-Disposition", 'attachment; filename="Heuried.mp4"');

		// Lock the document to prevent further downloads
		await collection.updateOne({ token: token }, { $set: { locked: true } });

		// Pipe the file stream to the response
		fileStream.pipe(res);

		let downloadSuccessful = false;
		let bytesStreamed = 0;

		// Listen for when the stream finishes successfully
		fileStream.on("data", (chunk) => {
			bytesStreamed += chunk.length;
		});

		fileStream.on("end", async () => {
			if (res.writableEnded && bytesStreamed === fileSize) {
				// Ensure the response was fully sent to the client
				downloadSuccessful = true;
				logger.info(`✅ File download completed for token: ${token} from IP: ${req.ip}`);

				try {
					// Update the document to mark the download as completed
					await collection.updateOne({ token: token }, { $set: { downloadedAt: new Date() } });

					// Send E-Mail letting the customer know the movie was downloaded
					sendMail(
						document.email,
						"Ihre Bestellung: Film heruntergeladen",
						"movie_downloaded.html"
					);
				} catch (err) {
					logger.error("❌ Failed to update document or send email:", err, "token: ", token);
				}
			} else {
				logger.info("⚠️ File stream ended, but download was incomplete.");
			}
		});

		// Listen for errors in the file stream
		fileStream.on("error", async (err: any) => {
			logger.error("❌ Error during file streaming:", err);
			res.status(500).json({ error: "Failed to stream the file" });

			// Unlock the document to allow further downloads
			try {
				await collection.updateOne({ token: token }, { $set: { locked: false } });
			} catch (unlockErr) {
				logger.error("❌ Failed to unlock the document:", unlockErr);
			}
		});

		// Listen for when the client aborts the connection
		req.on("close", async () => {
			if (!downloadSuccessful) {
				logger.info("⚠️ Client disconnected before download completed.");

				// If the client did not reconnect, unlock the document
				logger.info("⚠️ Client did not reconnect. Unlocking the document.");
				try {
					// Unlock the document to allow further downloads
					await collection.updateOne({ token: token }, { $set: { locked: false } });
				} catch (unlockErr) {
					logger.error("❌ Failed to unlock the document on client disconnect:", unlockErr);
				}
			}
		});
	}
} satisfies RouteHandler