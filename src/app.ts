// Main application entry point

import { Application, Request, Response } from "express";
const express = require('express');

// Constants
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 80;

////////////////////////////////////////////////////////////////

// Create the server
const app: Application = express();

app.get('/', (req: Request, res: Response) => {
	res.send('Hello World!');
});

app.listen(PORT)