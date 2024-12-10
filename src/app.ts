// Main application entry point

import { Application, Request, Response } from "express";
import { readDirRecursive } from "./helpers/readDirRecursive";
import { RouteHandler } from "exports/route";
import { exit } from "process";
import path from "path";

const express = require('express');

// Constants
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 80;

////////////////////////////////////////////////////////////////

console.log("⚙️  Preparing to start express.js server...\n");

// Create the server
const app: Application = express();

async function main() {
	// Prepare for gathering all the routes recursively
	console.log("⌛ Gathering routes...");
	let routes: RouteHandler[] = []

	// If it failed, stop the server since safe execution cannot be guaranteed anymore.
	try {
		const files: string[] = await readDirRecursive('./dist/routes');

		for (const filePath of files) {
			console.log("🔗 " + filePath);

			const absolutePath = path.resolve(process.cwd(), filePath);
			const routeModule = await import(`file://${absolutePath}`);

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