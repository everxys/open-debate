import { NextResponse } from "next/server";
import { ZodError } from "zod";

export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly headers?: Record<string, string>
  ) {
    super(message);
  }
}

export function toErrorResponse(error: unknown) {
  if (error instanceof AppError) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: error.code,
          message: error.message
        }
      },
      { status: error.status, headers: error.headers }
    );
  }

  if (error instanceof ZodError) {
    const firstIssue = error.issues[0];
    const path = firstIssue?.path?.length ? firstIssue.path.join(".") : "input";
    const message = firstIssue ? `${path}: ${firstIssue.message}` : "Invalid request";

    return NextResponse.json(
      {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message,
          details: error.issues
        }
      },
      { status: 400 }
    );
  }

  console.error(error);
  return NextResponse.json(
    {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Unexpected server error"
      }
    },
    { status: 500 }
  );
}
