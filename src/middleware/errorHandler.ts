import { Request, Response, NextFunction } from "express";

const IS_PROD = process.env.NODE_ENV === "production";

const errorHandler = (
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  console.error("🔥 Error:", err);

  const statusCode = err.statusCode || 500;

  return res.status(statusCode).json({
    message:
      statusCode === 500
        ? "Internal server error"
        : err.message,

    ...(IS_PROD
      ? {}
      : {
          stack: err.stack,
          error: err.message,
        }),
  });
};

export default errorHandler;