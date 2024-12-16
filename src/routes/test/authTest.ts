import { RouteHandler } from "exports/route";
import { NextFunction, Request, Response } from "express";

export default {
	Method: "get",
	Path: "/auth",
	Priority: 0,

	AuthorizationGroup: "Test",

	OnRequest: function (req: Request, res: Response, next: NextFunction) {
		res.json({
			success: true,
			dataType: "string[]",
			data: [
				"If you read this, the auth manager works and you have access to read this"
			],
		})
	}
} satisfies RouteHandler