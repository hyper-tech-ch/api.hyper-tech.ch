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

        // Find the movie file - use document.fileName if available, fallback to hardcoded name
        const movieFileName = document.fileName || "Heuried.mp4";
        const file = await findMovieFile(movieFileName);
        if (!file) {
            await collection.updateOne({ token }, { $set: { locked: false } });
            return res.status(500).json({ error: "MOVIE_FILE_NOT_FOUND" });
        }

        // Get file stats
        const fileStats = statSync(file);
        const fileSize = fileStats.size;

        logger.info(`🎬 Download started for token: ${token}, IP: ${req.ip}, file: ${file}, size: ${fileSize} bytes`);

        // Helper function to mark as completed
        const markAsCompleted = async () => {
            if (downloadCompleted) return; // Prevent double execution
            downloadCompleted = true;

            logger.info(`✅ Download completed for token: ${token}`);

            try {
                await collection.updateOne(
                    { token },
                    { $set: { downloadedAt: new Date(), locked: false } } // Set locked to false as we're done
                );

                // Send email notification
                sendMail(document.email, "Ihre Bestellung: Film heruntergeladen", "movie_downloaded.html");
                logger.info(`📧 Email sent to ${document.email} for completed download`);
            } catch (err) {
                logger.error(`❌ Failed to mark download as completed: ${err}`);
            }
        };

        // Helper function to unlock the document
        const unlockDocument = async () => {
            if (downloadCompleted) return;

            try {
                await collection.updateOne({ token }, { $set: { locked: false } });
                logger.info(`🔓 Document unlocked for token: ${token}`);
            } catch (err) {
                logger.error(`❌ Failed to unlock document: ${err}`);
            }
        };

        // Helper function to track download progress
        const updateDownloadProgress = async (position: number) => {
            try {
                // Update downloadedBytes to track progress
                await collection.updateOne(
                    { token },
                    {
                        $set: {
                            lastDownloadPosition: position,
                            // Update the progress percentage
                            downloadProgress: Math.round((position / fileSize) * 100)
                        }
                    }
                );
            } catch (err) {
                logger.error(`❌ Failed to update download progress: ${err}`);
            }
        };

        // Handle client disconnect
        req.on("close", async () => {
            if (!res.writableEnded) {
                logger.info(`⏸️ Download paused/interrupted for token: ${token}`);
                await unlockDocument();
            }
        });

        // Set common headers
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Content-Disposition", `attachment; filename="${movieFileName}"`);

        try {
            // Handle range request
            const range = req.headers.range;
            let stream;

            if (range) {
                // Parse range
                const parts = range.replace(/bytes=/, "").split("-");
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                const finalEnd = Math.min(end, fileSize - 1);
                const chunkSize = finalEnd - start + 1;

                // Calculate progress percentage based on the ending position
                // This better represents how much of the file has been downloaded
                const progressPercentage = Math.round((finalEnd / fileSize) * 100);

                // A request is considered complete if it ends at the last byte of the file
                const isCompletionRequest = finalEnd >= fileSize - 1;

                logger.info(`📥 Serving range: ${start}-${finalEnd}/${fileSize} (${progressPercentage}% already downloaded)`);

                // Update progress in the database using the end position, not the start position
                await updateDownloadProgress(finalEnd);

                // Send partial content
                res.status(206);
                res.setHeader("Content-Length", chunkSize);
                res.setHeader("Content-Range", `bytes ${start}-${finalEnd}/${fileSize}`);

                // Create stream
                stream = createReadStream(file, { start, end: finalEnd });

                // If this range includes the end of the file, mark as completed when done
                if (isCompletionRequest) {
                    res.on("finish", markAsCompleted);
                    logger.info(`⚠️ This appears to be a completion request (ends at byte ${finalEnd}/${fileSize - 1})`);
                } else {
                    res.on("finish", unlockDocument);
                }
            } else {
                // Full file download
                logger.info(`📥 Serving full file for token: ${token}`);
                res.setHeader("Content-Length", fileSize);

                // Create stream
                stream = createReadStream(file);

                // Mark as completed when the full file is sent
                res.on("finish", markAsCompleted);
            }

            // Error handling for stream
            stream.on("error", async (err) => {
                logger.error(`❌ Error streaming file: ${err}`);
                await unlockDocument();
                if (!res.headersSent) {
                    res.status(500).send("Error streaming file");
                }
            });

            // Send the file
            stream.pipe(res);

        } catch (err) {
            logger.error(`❌ Unexpected error: ${err}`);
            await unlockDocument();
            if (!res.headersSent) {
                res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
            }
        }
    },
} satisfies RouteHandler;