import e, { Request, Response, NextFunction } from "express";

export default (err: any, _: Request, res: Response, __: NextFunction) => {
    console.error(err);
    res.status(500).json({ message: "Something went wrong", error: err.message });
};