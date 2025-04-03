// Main application entry point

import { Application, NextFunction, Request, Response } from "express";
import { readDirRecursive } from "./helpers/readDirRecursive";
import { RouteHandler } from "exports/route";
import path from "path";
import { AuthorizationToken } from "exports/token";
import { Connect } from "./helpers/database";
import { initLogger } from "./helpers/logger";
import { ShutdownApp } from "./helpers/shutdownApp";

const express = require('express');
require('dotenv').config();

// Constants
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 80;

////////////////////////////////////////////////////////////////

// Create the server
const app: Application = express();

async function main() {
	// Prepare Vars
	let routes: RouteHandler[] = []
	let authorizations: AuthorizationToken[] = []

	// Logger
	const logger = await initLogger();

	logger.info("Preparing to start express.js server...\n");

	// Verify environment variables
	logger.info("Verifying environment variables...");

	for (const envVar of [
		"MONGO_URI",
		"MONGO_DB",

		"STRIPE_SECRET_KEY",
		"STRIPE_PUBLIC_KEY",
		"STRIPE_SIGNING_SECRET",
		"STRIPE_MOVIE_PRODUCT_ID",

		"SEND_MAIL",
		"MAIL_USER",
		"MAIL_PASS",
		"MAIL_HOST",
		"MAIL_PORT",
	]) {
		if (!process.env[envVar]) {
			logger.error(`🛑 Missing environment variable: ${envVar}`);
			
			await ShutdownApp(1);
		}
	}


	// Index the auth keys from all files so we can access them faster
	logger.info("Indexing authorization tokens...");

	// If it failed, stop the server since safe execution cannot be guaranteed anymore.
	try {
		const files: string[] = await readDirRecursive('./dist/tokens');

		for (const filePath of files) {
			logger.info("🔑 " + filePath);

			const absolutePath = path.resolve(process.cwd(), filePath);
			const routeModule = await import(`file://${absolutePath}`);

			if (path.dirname(absolutePath).endsWith("examples")) continue;

			if (routeModule.default && typeof routeModule.default === 'object') {
				authorizations.push(routeModule.default.default as AuthorizationToken);
			}
		}
	} catch (error) {
		logger.error('🛑 Error reading directory:', error)
		await ShutdownApp(1);
	}

	logger.info("✅ Authorization indexed\n");

	logger.info("⌛ Connecting Database...");
	await Connect();
	logger.info("✅ Database connected\n");

	// Prepare for gathering all the routes recursively
	logger.info("⌛ Gathering routes...\n");

	// If it failed, stop the server since safe execution cannot be guaranteed anymore.
	try {
		const files: string[] = await readDirRecursive('./dist/routes');

		for (const filePath of files) {
			logger.info("🔗 " + filePath);

			const absolutePath = path.resolve(process.cwd(), filePath);
			const routeModule = await import(`file://${absolutePath}`);

			if (path.dirname(absolutePath).endsWith("examples")) continue;

			if (routeModule.default && typeof routeModule.default === 'object') {
				routes.push(routeModule.default.default as RouteHandler);
			}
		}
	} catch (error) {
		logger.error('🛑 Error reading directory:', error);
		await ShutdownApp(1);
	}

	logger.info("✅ Routes gathered\n");

	// Sort the routes by priority (lowest first)
	logger.info("⌛ Sorting routes...");
	routes.sort((a, b) => a.Priority - b.Priority);

	logger.info("✅ Routes sorted by priority.\n");

	// Register the routes
	routes.forEach(route => {
		// Authorization Manager
		// This part of the code makes sure the user
		// has access to the content they request
		if (route.AuthorizationGroup !== null) {
			// Capture all incoming requests
			app.use(route.Path, (req: Request, res: Response, next: NextFunction) => {
				// Check if the request even provided authorization
				if (!req.headers["x-authorization"]) {
					res.status(401).json({
						success: false,
						dataType: "string[]",
						data: [
							"You did not provide proper authorization to access this content."
						],
					})

					return;
				}

				///////////////////////////////////////////

				// Check what auth key they've provided
				let providedAuthKey = req.headers["x-authorization"]
				let authKeyValid = false

				authorizations.forEach(token => {
					if (token.SecretKey !== providedAuthKey) return;
					if (token.ExpiresAt && token.ExpiresAt instanceof Date) {
						const currentDate = new Date();

						if (currentDate > token.ExpiresAt) return;
					}

					// Make sure that this token has access to the
					// required permissions
					if (!token.AllowedServices.includes(route.AuthorizationGroup as string)) return;

					///////////////////////////////////////////

					authKeyValid = true;
				})

				if (!authKeyValid) {
					res.status(403).json({
						success: false,
						dataType: "string[]",
						data: [
							"You did not provide proper authorization to access this content."
						],
					})

					return;
				}

				///////////////////////////////////////////

				// If everything is fine, go on with the request
				next();
			})
		}

		// Link the route
		if (!route.Middleware) {
			app[route.Method](route.Path, route.OnRequest);
			logger.info(`🚀 Registered ${route.Method.toUpperCase()} route: ${route.Path}`);
		} else {
			app[route.Method](route.Path, route.Middleware, route.OnRequest);
			logger.info(`🚀 Registered ${route.Method.toUpperCase()} route: ${route.Path}`);
			logger.info(`└  Registered some middleware for this route.`);
		}
	});

	// Start the server
	const server = app.listen(PORT, () => {
		logger.info(`Server now running on port ${PORT}!`);
	})

	server.timeout = 1000 * 60 * 10; // 10 minutes

	server.on('error', (err: any) => {
		logger.error('🛑 Server error:', err);
	});
}

main();