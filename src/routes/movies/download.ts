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
    
    logger.info(`🎬 Download started for token: ${token}, IP: ${req.ip}, file: ${file}, size: ${fileSize} bytes`);

    // Handle client disconnect by unlocking if download not completed
    req.on("close", async () => {
      if (!downloadCompleted) {
        logger.info(`⏸️ Download paused/interrupted for token: ${token}`);
        try {
          await collection.updateOne({ token }, { $set: { locked: false } });
        } catch (err) {
          logger.error(`❌ Failed to unlock document: ${err}`);
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
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const finalEnd = Math.min(end, fileSize - 1);
        const chunkSize = finalEnd - start + 1;
        
        // Calculate ACTUAL progress percentage (how much is already downloaded)
        const downloadedBytes = start;
        const downloadedPercent = Math.round((downloadedBytes / fileSize) * 100);
        
        logger.info(`📥 Serving range: ${start}-${finalEnd}, download progress: ${downloadedPercent}% (${downloadedBytes}/${fileSize} bytes)`);
        
        // Send partial content
        res.status(206);
        res.setHeader("Content-Length", chunkSize);
        res.setHeader("Content-Range", `bytes ${start}-${finalEnd}/${fileSize}`);
        
        // Create stream
        const stream = createReadStream(file, { start, end: finalEnd });
        
        // Handle completion of the range
        res.on("finish", async () => {
          // If at least 95% of file was already downloaded, mark as completed
          if (downloadedPercent >= 95) {
            downloadCompleted = true;
            logger.info(`✅ Download completed (${downloadedPercent}%) for token: ${token}`);
            
            try {
              await collection.updateOne(
                { token },
                { $set: { downloadedAt: new Date(), locked: true } }
              );
              
              // Send email
              sendMail(document.email, "Ihre Bestellung: Film heruntergeladen", "movie_downloaded.html");
              logger.info(`📧 Email sent to ${document.email} for completed download`);
            } catch (err) {
              logger.error(`❌ Failed to update document or send email: ${err}`);
            }
          } else {
            // Otherwise unlock for future requests
            await collection.updateOne({ token }, { $set: { locked: false } });
          }
        });
        
        // Error handling
        stream.on("error", async (err) => {
          logger.error(`❌ Error streaming file: ${err}`);
          try {
            await collection.updateOne({ token }, { $set: { locked: false } });
          } catch (unlockErr) {
            logger.error(`❌ Failed to unlock document: ${unlockErr}`);
          }
        });
        
        // Send the file
        stream.pipe(res);
        
      } else {
        // Full file download
        logger.info(`📥 Serving full file (0% progress) for token: ${token}`);
        res.setHeader("Content-Length", fileSize);
        
        const stream = createReadStream(file);
        
        // Handle completion
        res.on("finish", async () => {
          downloadCompleted = true;
          logger.info(`✅ Full download completed for token: ${token}`);
          
          try {
            await collection.updateOne(
              { token },
              { $set: { downloadedAt: new Date(), locked: true } }
            );
            
            // Send email
            sendMail(document.email, "Ihre Bestellung: Film heruntergeladen", "movie_downloaded.html");
            logger.info(`📧 Email sent to ${document.email} for completed download`);
          } catch (err) {
            logger.error(`❌ Failed to update document or send email: ${err}`);
          }
        });
        
        // Error handling
        stream.on("error", async (err) => {
          logger.error(`❌ Error streaming file: ${err}`);
          try {
            await collection.updateOne({ token }, { $set: { locked: false } });
          } catch (unlockErr) {
            logger.error(`❌ Failed to unlock document: ${unlockErr}`);
          }
        });
        
        // Send the file
        stream.pipe(res);
      }
      
    } catch (err) {
      logger.error(`❌ Unexpected error: ${err}`);
      try {
        await collection.updateOne({ token }, { $set: { locked: false } });
      } catch (unlockErr) {
        logger.error(`❌ Failed to unlock document: ${unlockErr}`);
      }
    }
  },
} satisfies RouteHandler;