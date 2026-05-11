import test from "node:test";
import assert from "node:assert/strict";

import * as coreAuth from "@/lib/core/auth";
import * as coreSession from "@/lib/core/auth/session-core";
import * as coreChangelog from "@/lib/core/changelog";
import * as coreDb from "@/lib/core/db";
import * as coreMigrations from "@/lib/core/db-migrations";
import * as coreHttp from "@/lib/core/http";
import * as coreLogger from "@/lib/core/logger/shared";
import * as legacyAuth from "@/lib/auth";
import * as legacySession from "@/lib/session-core";
import * as legacyChangelog from "@/lib/version";
import * as legacyDb from "@/lib/db";
import * as legacyMigrations from "@/lib/db-migrations";
import * as legacyHttp from "@/lib/http";
import * as legacyLogger from "@/lib/logger/shared";

test("legacy core entrypoints re-export the template foundation modules", () => {
  assert.equal(legacyHttp.apiRoute, coreHttp.apiRoute);
  assert.equal(legacyHttp.AppError, coreHttp.AppError);
  assert.equal(legacyDb.ensureDb, coreDb.ensureDb);
  assert.equal(legacyMigrations.listDbMigrations, coreMigrations.listDbMigrations);
  assert.equal(legacyLogger.sanitizeLogFields, coreLogger.sanitizeLogFields);
  assert.equal(legacyAuth.requireUser, coreAuth.requireUser);
  assert.equal(legacySession.createSessionToken, coreSession.createSessionToken);
  assert.equal(legacyChangelog.buildChangelog, coreChangelog.buildChangelog);
});
