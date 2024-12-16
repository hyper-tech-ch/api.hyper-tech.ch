import { RouteHandler } from "exports/route";
import { NextFunction, Request, Response } from "express";

export default {
	Method: "get",
	Path: "/test",
	Priority: 0,

	AuthorizationGroup: "Test",

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