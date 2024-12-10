import { RouteHandler } from "exports/route";
import { NextFunction, Request, Response } from "express";

export default {
	Method: "get",
	Path: "/",
	Priority: 0,

	OnRequest: function (req: Request, res: Response, next: NextFunction) {
		res.json({
			success: true,
			dataType: "string[]",
			data: [
				"If you read this, the route handler works"
			],
		})
	}
} satisfies RouteHandler