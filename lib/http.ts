import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { createServerLogger } from "@/lib/logger/server";
import type { LogFields } from "@/lib/logger/shared";
import { readSession, type Session } from "@/lib/session";

/** Application-specific error with code and HTTP status */
export class AppError extends Error {
  details?: unknown;

  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly headers?: Record<string, string>
  ) {
    super(message);
  }
}

const httpLogger = createServerLogger("http");

type ErrorResponseLogContext = {
  route?: string;
  method?: string;
  meta?: LogFields;
};

type RouteParams = Record<string, string>;

type NextRouteContext<TParams extends RouteParams> = {
  params: Promise<TParams>;
};

type ApiRouteLogMetaContext<TParams extends RouteParams> = {
  request: Request;
  params: TParams;
};

type ApiRouteOptions<TParams extends RouteParams> = {
  route: string;
  method: string;
  requireSession?: boolean | { message?: string };
  logMeta?: LogFields | ((context: ApiRouteLogMetaContext<TParams>) => LogFields | undefined);
};

export type ApiRouteContext<TParams extends RouteParams = RouteParams> = {
  request: Request;
  params: TParams;
  session: Session | null;
  setLogMeta: (meta: LogFields | undefined) => void;
};

type ApiRouteHandler<TParams extends RouteParams> = (
  context: ApiRouteContext<TParams>
) => Response | Promise<Response>;

function resolveRouteLogMeta<TParams extends RouteParams>(
  input: ApiRouteOptions<TParams>,
  context: ApiRouteLogMetaContext<TParams>
) {
  return typeof input.logMeta === "function" ? input.logMeta(context) : input.logMeta;
}

/** Return the standard success response envelope used by API routes. */
export function jsonSuccess(data: unknown, init?: ResponseInit | number) {
  const responseInit = typeof init === "number" ? { status: init } : init;
  return NextResponse.json({ success: true, data }, responseInit);
}

export async function readJsonBody<T = unknown>(request: Request, fallback?: T) {
  try {
    return (await request.json()) as T;
  } catch (error) {
    if (arguments.length >= 2) return fallback as T;
    throw error;
  }
}

/** Wrap App Router handlers with shared params/session/error handling. */
export function apiRoute<TParams extends RouteParams = RouteParams>(
  options: ApiRouteOptions<TParams>,
  handler: ApiRouteHandler<TParams>
) {
  return async function wrappedApiRoute(request: Request, context: NextRouteContext<TParams>) {
    let params = {} as TParams;
    let optionMeta: LogFields | undefined;
    let handlerMeta: LogFields | undefined;
    const setLogMeta = (meta: LogFields | undefined) => {
      if (!meta) return;
      handlerMeta = { ...(handlerMeta ?? {}), ...meta };
    };

    try {
      params = context?.params ? await context.params : ({} as TParams);
      optionMeta = resolveRouteLogMeta(options, { request, params });
      const session = options.requireSession ? await readSession() : null;
      if (options.requireSession && !session) {
        throw new AppError(
          "AUTH_REQUIRED",
          401,
          typeof options.requireSession === "object" ? options.requireSession.message ?? "Unauthorized" : "Unauthorized"
        );
      }
      return await handler({ request, params, session, setLogMeta });
    } catch (error) {
      return toErrorResponse(error, {
        route: options.route,
        method: options.method,
        meta: {
          ...(optionMeta ?? {}),
          ...(handlerMeta ?? {})
        }
      });
    }
  };
}

/** Convert error to standardized JSON response */
export function toErrorResponse(error: unknown, context?: ErrorResponseLogContext): NextResponse {
  const contextFields: LogFields = {
    ...(context?.route ? { route: context.route } : {}),
    ...(context?.method ? { method: context.method } : {}),
    ...(context?.meta ?? {})
  };

  if (error instanceof AppError) {
    const level = error.status >= 500 ? "error" : "warn";
    httpLogger[level]("request failed", {
      ...contextFields,
      error: {
        code: error.code,
        status: error.status,
        message: error.message,
        details: "details" in error ? (error as { details?: unknown }).details : undefined
      }
    });
    return NextResponse.json(
      {
        success: false,
        error: {
          code: error.code,
          message: error.message,
          ...(("details" in error && (error as { details?: unknown }).details !== undefined)
            ? { details: (error as { details?: unknown }).details }
            : {})
        }
      },
      { status: error.status, headers: error.headers }
    );
  }

  if (error instanceof ZodError) {
    const firstIssue = error.issues[0];
    const path = firstIssue?.path?.length ? firstIssue.path.join(".") : "input";
    const message = firstIssue ? `${path}: ${firstIssue.message}` : "Invalid request";
    httpLogger.warn("request validation failed", {
      ...contextFields,
      issues: error.issues
    });
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message, details: error.issues } },
      { status: 400 }
    );
  }

  httpLogger.error("unexpected request failure", {
    ...contextFields,
    error
  });
  return NextResponse.json(
    { success: false, error: { code: "INTERNAL_ERROR", message: "Unexpected server error" } },
    { status: 500 }
  );
}
