import { RouteHandler } from "exports/route";
import { NextFunction, Request, Response } from "express";
import { GetCollection } from "../../helpers/database";
import { readDirRecursive } from "../../helpers/readDirRecursive";
import path from "path";
import { createReadStream, statSync } from "fs";
import cors from "cors";

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
			origin: "*", // Allow only this origin
			methods: ["GET"], // Allow only GET requests
			exposedHeaders: ["Content-Length"], // Expose headers like Content-Length
		}),
	],

	OnRequest: async function (req: Request, res: Response, next: NextFunction) {
		if (!req.query.token) {
			res.status(400).json({ error: "NO_TOKEN" });
			return;
		}

		let token = req.query.token as string;
		let collection = await GetCollection("movie_links");

		let document = await collection.findOne({ token: token, locked: false });

		if (!document) {
			res.status(404).json({ error: "TOKEN_INVALID" });
			return;
		}

		let file = await findMovieFile("Heuried.mp4");

		if (!file) {
			res.status(404).json({ error: "MOVIE_FILE_NOT_FOUND" });
			return;
		}

		const fileStats = statSync(file); // Get file stats to determine the size
		const fileSize = fileStats.size;
		res.setHeader("Content-Length", fileSize);

		const fileStream = createReadStream(file);
		let downloadSuccessful = false;

		// Set headers for the response
		res.setHeader("Content-Type", "video/mp4");
		res.setHeader("Content-Disposition", 'attachment; filename="movie.mp4"');

		// Lock the document to prevent further downloads
		collection.updateOne({ token: token }, { $set: { locked: true } });

		// Pipe the file stream to the response
		fileStream.pipe(res);

		// Listen for when the stream finishes successfully
		fileStream.on("end", () => {
			downloadSuccessful = true;
			console.log(`✅ File download completed for token: ${token}`);

			// Update the document to mark the download as completed
			collection.updateOne({ token: token }, { $set: { downloadedAt: new Date() } });
		});

		// Listen for errors in the file stream
		fileStream.on("error", (err: any) => {
			console.error("❌ Error during file streaming:", err);
			res.status(500).json({ error: "Failed to stream the file" });

			// Unlock the document to allow further downloads
			collection.updateOne({ token: token }, { $set: { locked: false } });
		});

		// Listen for when the client aborts the connection
		req.on("close", () => {
			if (!downloadSuccessful) {
				console.log(`⚠️  File download was canceled or not finished for token: ${token}`);

				// Unlock the document to allow further downloads
				collection.updateOne({ token: token }, { $set: { locked: false } });
			}
		});
	}
} satisfies RouteHandler