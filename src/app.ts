// Main application entry point

import { Application, Request, Response } from "express";
import { readDirRecursive } from "./helpers/readDirRecursive";
import { RouteHandler } from "exports/route";
import { exit } from "process";

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
		const files = await readDirRecursive('./dist/routes');

		// Dynamically import each route module
		for (const filePath of files) {
			const routeModule = await import(filePath);
		}
	} catch (error) {
		console.error('🛑 Error reading directory:', error);

		exit(1);
	}

	console.log("✅ Routes gathered!");

	// Sort the routes 

	app.listen(PORT)
}

main();