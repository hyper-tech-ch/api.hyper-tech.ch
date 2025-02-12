import { RouteHandler } from "exports/route";
import { NextFunction, Request, Response } from "express";

export default {
	Method: "get",
	Path: "/status",
	Priority: 0,
	
	AuthorizationGroup: null,

	OnRequest: function (req: Request, res: Response, next: NextFunction) {
		res.json({
			success: true,
			dataType: "null[]",
			data: [],
		})
	}
} satisfies RouteHandler