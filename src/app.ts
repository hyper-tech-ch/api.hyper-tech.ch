// Main application entry point

import { Application, NextFunction, Request, Response } from "express";
import { readDirRecursive } from "./helpers/readDirRecursive";
import { RouteHandler } from "exports/route";
import { exit } from "process";
import path from "path";
import { AuthorizationToken } from "exports/token";

const express = require('express');

// Constants
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 80;

////////////////////////////////////////////////////////////////

console.log("⚙️  Preparing to start express.js server...\n");

// Create the server
const app: Application = express();

async function main() {
	// Prepare Vars
	let routes: RouteHandler[] = []
	let authorizations: AuthorizationToken[] = []

	// Index the auth keys from all files so we can access them faster
	console.log("⌛ Indexing Authorization Tokens...");

	// If it failed, stop the server since safe execution cannot be guaranteed anymore.
	try {
		const files: string[] = await readDirRecursive('./dist/tokens');

		for (const filePath of files) {
			console.log("🔑 " + filePath);

			const absolutePath = path.resolve(process.cwd(), filePath);
			const routeModule = await import(`file://${absolutePath}`);

			if (path.dirname(absolutePath).endsWith("examples")) continue;

			if (routeModule.default && typeof routeModule.default === 'object') {
				authorizations.push(routeModule.default.default as AuthorizationToken);
			}
		}
	} catch (error) {
		console.error('🛑 Error reading directory:', error);
		exit(1);
	}

	console.log("✅ Authorization indexed\n");

	// Prepare for gathering all the routes recursively
	console.log("⌛ Gathering routes...");

	// If it failed, stop the server since safe execution cannot be guaranteed anymore.
	try {
		const files: string[] = await readDirRecursive('./dist/routes');

		for (const filePath of files) {
			console.log("🔗 " + filePath);

			const absolutePath = path.resolve(process.cwd(), filePath);
			const routeModule = await import(`file://${absolutePath}`);

			if (path.dirname(absolutePath).endsWith("examples")) continue;

			if (routeModule.default && typeof routeModule.default === 'object') {
				routes.push(routeModule.default.default as RouteHandler);
			}
		}
	} catch (error) {
		console.error('🛑 Error reading directory:', error);
		exit(1);
	}

	console.log("✅ Routes gathered\n");

	// Sort the routes by priority (lowest first)
	console.log("⌛ Sorting routes...");
	routes.sort((a, b) => a.Priority - b.Priority);

	console.log("✅ Routes sorted by priority.\n");

	// Register the routes
	routes.forEach(route => {
		// Authorization Manager
		// This part of the code makes sure the user
		// has access to the content they request
		if(route.AuthorizationGroup) {
			// Capture all incoming requests
			app.use(route.Path, (req: Request, res: Response, next: NextFunction) => {
				// Check if the request even provided authorization
				if(!req.headers["x-authorization"]) {
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

						if (currentDate < token.ExpiresAt) return;
					}

					// Make sure that this token has access to the
					// required permissions
					if (!token.AllowedServices.includes(route.AuthorizationGroup)) return;

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
		app[route.Method](route.Path, route.OnRequest);
		console.log(`🚀 Registered ${route.Method.toUpperCase()} route: ${route.Path}`);
	});

	// Logs
	app.on("listening", function () {
		console.log(`✅ Server now running on port ${PORT}!`);
	});

	// Start the server
	app.listen(PORT)
}

main();