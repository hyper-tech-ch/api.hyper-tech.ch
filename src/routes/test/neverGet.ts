import { RouteHandler } from "exports/route";
import { NextFunction, Request, Response } from "express";

export default {
	Method: "get",
	Path: "/",
	Priority: 10,
	
	AuthorizationGroup: "Test",

	OnRequest: function (req: Request, res: Response, next: NextFunction) {
		res.json({
			success: true,
			dataType: "string[]",
			data: [
				"If you read this, the route handler DOES NOT WORK works",
				"This request is priority 10, but there should be a request with priority 0 before me."
			],
		})
	}
} satisfies RouteHandler