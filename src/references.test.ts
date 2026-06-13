import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextTsql from "./TextTsql.ts";

const h = () => new TextTsql({ mimetype: "text/x-tsql", glyph: "🗄", extensions: [".sql"] as const });

// T-SQL exercises bracket-quoted, schema-qualified identifiers ([dbo].[Users])
// alongside bare ones — all normalize to the bare object name so refs and defs
// agree. Decoys: a string literal and a comment must never leak as refs.
const SQL = `-- CommentDecoy: not a table
CREATE TABLE [dbo].[Users] (
  Id INT PRIMARY KEY,
  Name NVARCHAR(255) DEFAULT 'StringDecoy'
);
CREATE TABLE [dbo].[Orders] (
  Id INT PRIMARY KEY,
  UserId INT NOT NULL FOREIGN KEY REFERENCES [dbo].[Users](Id),
  CategoryId INT,
  CONSTRAINT fk_cat FOREIGN KEY (CategoryId) REFERENCES Categories(Id)
);
CREATE VIEW dbo.ActiveOrders AS
  SELECT o.Id, u.Name
  FROM dbo.Orders AS o
  JOIN dbo.Users u ON u.Id = o.UserId;
CREATE INDEX IX_Orders_User ON dbo.Orders (UserId);
CREATE PROCEDURE dbo.GetActive AS
  SELECT * FROM dbo.Orders WHERE Id IN (SELECT Id FROM dbo.AuditLog);
`;

describe("text/x-tsql references (ANTLR refs grind)", () => {
    it("emits the SQL dependency graph with conformance invariants", async () => {
        const handler = h();
        const symbols = await handler.extractRaw(SQL);
        const refs = await handler.references(SQL);
        const defNames = new Set(symbols.map((s) => s.name));

        assert.ok(refs.length > 0, "produces refs");
        // Invariants (mirror the framework conformance harness).
        for (const r of refs) {
            assert.ok(r.line >= 1 && r.column >= 1, `1-indexed: ${r.name}`);
            assert.equal(typeof r.endColumn, "number");
            assert.equal(r.kind, "use", "SQL refs are declared dependencies");
            // No string-literal / comment leakage.
            assert.notEqual(r.name, "StringDecoy");
            assert.notEqual(r.name, "CommentDecoy");
        }

        // The graph edges, by container (the created object) → used table.
        const edge = (container: string, name: string) =>
            refs.some((r) => r.container === container && r.name === name);

        // View reads its source tables (bracket/schema qualification stripped).
        assert.ok(edge("ActiveOrders", "Orders"), "view → Orders");
        assert.ok(edge("ActiveOrders", "Users"), "view → Users");
        // FK dependency — both inline column FK and named table CONSTRAINT.
        assert.ok(edge("Orders", "Users"), "Orders inline FK → Users");
        assert.ok(edge("Orders", "Categories"), "Orders CONSTRAINT FK → Categories");
        // Index attaches to its ON table.
        assert.ok(edge("IX_Orders_User", "Orders"), "index → Orders");
        // Procedure body touches its tables (incl. nested subquery table).
        assert.ok(edge("GetActive", "Orders"), "procedure → Orders");
        assert.ok(edge("GetActive", "AuditLog"), "procedure subquery → AuditLog");

        // Join proof: the view/FK edges resolve to local table defs.
        assert.ok(defNames.has("Users") && defNames.has("Orders"));
        // A def's own name never appears as a ref (no self-reference).
        assert.ok(!refs.some((r) => r.name === r.container));
    });
});
