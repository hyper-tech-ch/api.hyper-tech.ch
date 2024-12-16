import { RouteHandler } from "exports/route";
import { NextFunction, Request, Response } from "express";

export default {
	Method: "get",
	Path: "/",
	Priority: 5,
	
	AuthorizationGroup: "",

	OnRequest: function (req: Request, res: Response, next: NextFunction) {
		res.json({
			success: true,
			dataType: "string[]",
			data: [
				"Works!"
			],
		})
	}
} satisfies RouteHandler