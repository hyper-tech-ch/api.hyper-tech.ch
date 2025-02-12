import { RouteHandler } from "exports/route";
import { NextFunction, Request, Response } from "express";

export default {
	Method: "get",
	Path: "/",
	Priority: 0,
	
	AuthorizationGroup: null,

	OnRequest: function (req: Request, res: Response, next: NextFunction) {
		res.redirect("https://hyper-tech.ch/")
	}
} satisfies RouteHandler