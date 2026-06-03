import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextTsql from "./TextTsql.ts";

const metadata = {
    mimetype: "text/x-tsql",
    glyph: "🔷",
    extensions: [".sql"] as const,
};

describe("TextTsql — instantiation", () => {
    it("instantiates with metadata", () => {
        const h = new TextTsql(metadata);
        assert.equal(h.mimetype, "text/x-tsql");
        assert.equal(h.glyph, "🔷");
    });
});

describe("TextTsql — extract", () => {
    it("extracts CREATE TABLE + columns", () => {
        const h = new TextTsql(metadata);
        const src = [
            "CREATE TABLE Users (",
            "    Id INT IDENTITY(1,1) PRIMARY KEY,",
            "    Email NVARCHAR(255) NOT NULL,",
            "    Name NVARCHAR(255) NOT NULL,",
            "    CreatedAt DATETIME2 DEFAULT SYSUTCDATETIME()",
            ");",
        ].join("\n");
        const syms = h.extractRaw(src);
        const t = syms.find((s) => s.name === "Users" && s.kind === "class");
        assert.ok(t);
        assert.ok(syms.find((s) => s.name === "Id"));
        assert.ok(syms.find((s) => s.name === "Email"));
        assert.ok(syms.find((s) => s.name === "Name"));
        assert.ok(syms.find((s) => s.name === "CreatedAt"));
    });

    it("extracts CREATE VIEW as class", () => {
        const h = new TextTsql(metadata);
        const src = "CREATE VIEW ActiveUsers AS SELECT * FROM Users WHERE DeletedAt IS NULL;";
        const syms = h.extractRaw(src);
        const v = syms.find((s) => s.name === "ActiveUsers");
        assert.ok(v);
        assert.equal(v.kind, "class");
    });

    it("extracts CREATE INDEX as field", () => {
        const h = new TextTsql(metadata);
        const src = "CREATE INDEX IX_Users_Email ON Users (Email);";
        const syms = h.extractRaw(src);
        const i = syms.find((s) => s.name === "IX_Users_Email");
        assert.ok(i);
        assert.equal(i.kind, "field");
    });

    it("extracts CREATE PROCEDURE as function", () => {
        const h = new TextTsql(metadata);
        const src = [
            "CREATE PROCEDURE RefreshStats",
            "AS",
            "BEGIN",
            "    EXEC sp_updatestats;",
            "END;",
        ].join("\n");
        const syms = h.extractRaw(src);
        const p = syms.find((s) => s.name === "RefreshStats");
        assert.ok(p);
        assert.equal(p.kind, "function");
    });

    it("extracts CREATE FUNCTION as function", () => {
        const h = new TextTsql(metadata);
        const src = [
            "CREATE FUNCTION AddOne(@x INT) RETURNS INT",
            "AS",
            "BEGIN",
            "    RETURN @x + 1;",
            "END;",
        ].join("\n");
        const syms = h.extractRaw(src);
        const f = syms.find((s) => s.name === "AddOne");
        assert.ok(f);
        assert.equal(f.kind, "function");
    });

    it("extracts CREATE SCHEMA as module", () => {
        const h = new TextTsql(metadata);
        const src = "CREATE SCHEMA auth;";
        const syms = h.extractRaw(src);
        const s = syms.find((sym) => sym.name === "auth");
        assert.ok(s);
        assert.equal(s.kind, "module");
    });

    it("extracts CREATE TYPE as type", () => {
        const h = new TextTsql(metadata);
        const src = "CREATE TYPE PhoneNumber FROM NVARCHAR(20) NOT NULL;";
        const syms = h.extractRaw(src);
        const t = syms.find((s) => s.name === "PhoneNumber");
        assert.ok(t);
        assert.equal(t.kind, "type");
    });

    it("extracts CREATE SEQUENCE as field", () => {
        const h = new TextTsql(metadata);
        const src = "CREATE SEQUENCE OrderId AS INT START WITH 1000;";
        const syms = h.extractRaw(src);
        const sq = syms.find((s) => s.name === "OrderId");
        assert.ok(sq);
        assert.equal(sq.kind, "field");
    });

    it("extracts CREATE TRIGGER as method", () => {
        const h = new TextTsql(metadata);
        const src = [
            "CREATE TRIGGER TouchUpdatedAt ON Users",
            "AFTER UPDATE",
            "AS",
            "BEGIN",
            "    UPDATE Users SET UpdatedAt = SYSUTCDATETIME() FROM Users JOIN inserted ON Users.Id = inserted.Id;",
            "END;",
        ].join("\n");
        const syms = h.extractRaw(src);
        const t = syms.find((s) => s.name === "TouchUpdatedAt");
        assert.ok(t);
        assert.equal(t.kind, "method");
    });

    it("excludes DML statements", () => {
        const h = new TextTsql(metadata);
        const src = [
            "INSERT INTO Users (Id, Name) VALUES (1, 'a');",
            "UPDATE Users SET Name = 'b' WHERE Id = 1;",
            "SELECT * FROM Users;",
            "DELETE FROM Users;",
            "CREATE TABLE T (Id INT);",
        ].join("\n");
        const syms = h.extractRaw(src);
        const names = syms.map((s) => s.name);
        assert.deepEqual(names.toSorted(), ["Id", "T"]);
    });

    it("returns empty array for empty input", () => {
        const h = new TextTsql(metadata);
        assert.deepEqual(h.extractRaw(""), []);
    });

    it("does not throw on malformed source (graceful)", () => {
        const h = new TextTsql(metadata);
        assert.doesNotThrow(() => h.extractRaw("CREATE TABLE ( broken"));
        assert.doesNotThrow(() => h.extractRaw("@@ totally bogus"));
    });

    it("handles bracket-quoted identifiers ([weird-name])", () => {
        const h = new TextTsql(metadata);
        const src = "CREATE TABLE [Users-2024] ([Id] INT, [first name] NVARCHAR(255));";
        const syms = h.extractRaw(src);
        assert.ok(syms.find((s) => s.name === "Users-2024"));
        assert.ok(syms.find((s) => s.name === "Id"));
        assert.ok(syms.find((s) => s.name === "first name"));
    });
});

describe("TextTsql — framework integration", () => {
    it("renders extracted hierarchy via format()", async () => {
        const h = new TextTsql(metadata);
        const out = await h.symbolsRaw("CREATE TABLE Answers (Id INT);");
        assert.ok(out.includes("class Answers"));
    });

    it("jsonpath dispatches against the deep-json ANTLR parse tree (issue #10)", async () => {
        // Every ANTLR deep tree has a root with a `type` field — verify
        // jsonpath reaches it via the deep-channel dispatch.
        const h = new TextTsql(metadata);
        const roots = await h.query("class Probe {}", "jsonpath", "$.type");
        assert.equal(roots.length, 1);
        assert.equal(typeof roots[0].matched, "string");
    });
});

// Real-world smoke against a representative T-SQL migration.
describe("TextTsql — real-world smoke (migration-shape)", () => {
    const SRC = [
        "CREATE SCHEMA auth;",
        "",
        "CREATE TABLE Users (",
        "    Id INT IDENTITY(1,1) PRIMARY KEY,",
        "    Email NVARCHAR(255) NOT NULL UNIQUE,",
        "    Name NVARCHAR(255) NOT NULL,",
        "    CreatedAt DATETIME2 DEFAULT SYSUTCDATETIME(),",
        "    UpdatedAt DATETIME2 DEFAULT SYSUTCDATETIME()",
        ");",
        "",
        "CREATE INDEX IX_Users_Email ON Users (Email);",
        "",
        "CREATE TABLE Posts (",
        "    Id INT IDENTITY(1,1) PRIMARY KEY,",
        "    UserId INT NOT NULL FOREIGN KEY REFERENCES Users(Id),",
        "    Title NVARCHAR(255) NOT NULL,",
        "    Body NVARCHAR(MAX)",
        ");",
        "",
        "CREATE INDEX IX_Posts_UserId ON Posts (UserId);",
        "",
        "CREATE VIEW ActivePosts AS",
        "    SELECT p.* FROM Posts p WHERE p.PublishedAt IS NOT NULL;",
        "",
        "CREATE SEQUENCE OrderId AS BIGINT START WITH 1000;",
        "",
        "CREATE PROCEDURE RefreshStats",
        "AS",
        "BEGIN",
        "    EXEC sp_updatestats;",
        "END;",
        "",
        "CREATE TRIGGER TouchUsersUpdatedAt ON Users",
        "AFTER UPDATE",
        "AS",
        "BEGIN",
        "    UPDATE Users SET UpdatedAt = SYSUTCDATETIME() FROM Users JOIN inserted ON Users.Id = inserted.Id;",
        "END;",
    ].join("\n");

    it("surfaces schema + tables + columns + indexes + view + sequence + procedure + trigger", () => {
        const h = new TextTsql(metadata);
        const syms = h.extractRaw(SRC);
        const names = new Set(syms.map((s) => s.name));

        assert.ok(names.has("auth"));
        assert.ok(names.has("Users"));
        assert.ok(names.has("Posts"));
        assert.ok(names.has("ActivePosts"));
        assert.ok(names.has("OrderId"));

        assert.ok(names.has("Email"));
        assert.ok(names.has("Title"));
        assert.ok(names.has("UserId"));

        assert.ok(names.has("IX_Users_Email"));
        assert.ok(names.has("IX_Posts_UserId"));

        assert.ok(names.has("RefreshStats"));
        assert.ok(names.has("TouchUsersUpdatedAt"));
    });

    it("kind discrimination", () => {
        const h = new TextTsql(metadata);
        const syms = h.extractRaw(SRC);
        const byNameKind = new Map(syms.map((s) => [`${s.name}:${s.kind}`, s]));
        assert.ok(byNameKind.has("auth:module"));
        assert.ok(byNameKind.has("Users:class"));
        assert.ok(byNameKind.has("ActivePosts:class"));
        assert.ok(byNameKind.has("OrderId:field"));
        assert.ok(byNameKind.has("RefreshStats:function"));
        assert.ok(byNameKind.has("TouchUsersUpdatedAt:method"));
    });
});
