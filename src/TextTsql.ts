import { AntlrExtractor, withExtractor } from "@plurnk/plurnk-mimetypes";
import type { ExtractionVisitor } from "@plurnk/plurnk-mimetypes";
import { CharStream, CommonTokenStream } from "antlr4ng";
import { TSqlLexer } from "./generated/TSqlLexer.ts";
import { TSqlParser } from "./generated/TSqlParser.ts";
import { TSqlParserVisitor } from "./generated/TSqlParserVisitor.ts";

// text/x-tsql handler. ANTLR grammar from grammars-v4/sql/tsql.
// SQL Server's T-SQL dialect.
//
// Parser entry rule: tsql_file.
export default class TextTsql extends AntlrExtractor {
    protected parseTree(content: string): unknown {
        const lexer = new TSqlLexer(CharStream.fromString(content));
        const tokens = new CommonTokenStream(lexer);
        const parser = new TSqlParser(tokens);
        parser.removeErrorListeners();
        return parser.tsql_file();
    }

    protected createVisitor(): ExtractionVisitor {
        return new TextTsqlVisitor() as unknown as ExtractionVisitor;
    }
}

// SPEC §3 mapping:
//   CREATE TABLE name (cols)            → class; columns → field
//   CREATE VIEW name AS                 → class
//   CREATE INDEX name ON table          → field
//   CREATE TRIGGER name (DML / DDL)     → method
//   CREATE PROCEDURE name (args)        → function
//   CREATE FUNCTION name (args)         → function
//   CREATE SCHEMA name                  → module
//   CREATE TYPE name                    → type
//   CREATE DATABASE name                → module
//   CREATE SEQUENCE name                → field
//   DML / sql_clauses                   → excluded
class TextTsqlVisitor extends withExtractor(TSqlParserVisitor) {
    visitCreate_table = (ctx: any): null => {
        if (this.inBody) return null;
        const tn = ctx.table_name?.();
        const name = sqlNameText(tn);
        if (!name) return null;
        this.addSymbol("class", name, ctx);
        // column_definitions are nested in column_def_table_constraints.
        const cols = findDescendants(ctx, "Column_definitionContext");
        for (const col of cols) {
            const id = (col as { id_?: () => Array<unknown> | unknown }).id_?.();
            const idArr = Array.isArray(id) ? id : id ? [id] : [];
            const colName = sqlNameText(idArr[0]);
            if (colName) this.addSymbol("field", colName, ctx);
        }
        // Foreign keys are cross-table dependencies: this table USES the
        // referenced table. Both the inline column FK and the named table
        // CONSTRAINT wrap the referenced table_name in foreign_key_options,
        // which never contains this table's own name — so no self-reference.
        for (const fko of findDescendants(ctx, "Foreign_key_optionsContext")) {
            const refTable = (fko as { table_name?: () => unknown }).table_name?.();
            const fkName = sqlNameText(refTable);
            if (fkName) this.addRef("use", fkName, refTable as never, { container: name });
        }
        return null;
    };

    visitCreate_view = (ctx: any): null => {
        if (this.inBody) return null;
        const sn = ctx.simple_name?.();
        const name = sqlNameText(sn);
        if (name) this.addSymbol("class", name, ctx);
        // A view USES every table its SELECT reads — the core SQL graph edge
        // (view → use → source tables). container = the view being created.
        if (name) this.refSourceTables(ctx, name);
        return null;
    };

    visitCreate_index = (ctx: any): null => {
        if (this.inBody) return null;
        // create_index: CREATE UNIQUE? clustered? INDEX id_ ON table_name ...
        const ids = collectChildren(ctx, "id_");
        const name = sqlNameText(ids[0]);
        if (name) this.addSymbol("field", name, ctx);
        // An index attaches to its ON table.
        const onTable = ctx.table_name?.();
        const onName = sqlNameText(onTable);
        if (name && onName) this.addRef("use", onName, onTable, { container: name });
        return null;
    };

    visitCreate_or_alter_dml_trigger = (ctx: any): null => {
        if (this.inBody) return null;
        const sn = ctx.simple_name?.();
        const name = sqlNameText(sn);
        if (name) this.addSymbol("method", name, ctx);
        // A trigger references its ON table and every table its body touches.
        if (name) {
            const onTable = ctx.table_name?.();
            const onName = sqlNameText(onTable);
            if (onName) this.addRef("use", onName, onTable, { container: name });
            this.refSourceTables(ctx, name);
        }
        return null;
    };

    visitCreate_or_alter_ddl_trigger = (ctx: any): null => {
        if (this.inBody) return null;
        // DDL trigger: first id_ is the trigger name.
        const ids = collectChildren(ctx, "id_");
        const name = sqlNameText(ids[0]);
        if (name) this.addSymbol("method", name, ctx);
        return null;
    };

    visitCreate_or_alter_procedure = (ctx: any): null => {
        if (this.inBody) return null;
        const fps = ctx.func_proc_name_schema?.();
        const name = sqlNameText(fps);
        if (name) this.addSymbol("function", name, ctx);
        // A stored procedure USES every table its body reads/writes — a rich
        // T-SQL graph edge (proc → use → tables). container = the procedure.
        if (name) this.refSourceTables(ctx, name);
        return null;
    };

    visitCreate_or_alter_function = (ctx: any): null => {
        if (this.inBody) return null;
        const fps = ctx._funcName ?? ctx.func_proc_name_schema?.();
        const name = sqlNameText(fps);
        if (name) this.addSymbol("function", name, ctx);
        return null;
    };

    visitCreate_schema = (ctx: any): null => {
        if (this.inBody) return null;
        const name = sqlNameText(ctx._schema_name);
        if (name) this.addSymbol("module", name, ctx);
        return null;
    };

    visitCreate_database = (ctx: any): null => {
        if (this.inBody) return null;
        const name = sqlNameText(ctx._database);
        if (name) this.addSymbol("module", name, ctx);
        return null;
    };

    visitCreate_type = (ctx: any): null => {
        if (this.inBody) return null;
        const name = sqlNameText(ctx._name);
        if (name) this.addSymbol("type", name, ctx);
        return null;
    };

    visitCreate_sequence = (ctx: any): null => {
        if (this.inBody) return null;
        const name = sqlNameText(ctx._sequence_name);
        if (name) this.addSymbol("field", name, ctx);
        return null;
    };

    // Emit a `use` ref for every real source table under `ctx`, owned by the
    // created object `container`. table_source_item.full_table_name() is the
    // clean path: it yields only FROM/JOIN/subquery tables, excluding the bare
    // alias references (o.Id, u.Name) that also surface as full_table_name.
    private refSourceTables(ctx: unknown, container: string): void {
        for (const item of findDescendants(ctx, "Table_source_itemContext")) {
            const ftn = (item as { full_table_name?: () => unknown }).full_table_name?.();
            const tableName = sqlNameText(ftn);
            if (tableName) this.addRef("use", tableName, ftn as never, { container });
        }
    }
}

function sqlNameText(ctx: unknown): string | null {
    if (!ctx) return null;
    const raw = (ctx as { getText?: () => string }).getText?.();
    if (!raw) return null;
    return unquoteSqlIdentifier(raw);
}

// Normalize a (possibly schema-qualified, possibly bracket-quoted) T-SQL
// identifier to its bare object name. [dbo].[Users] → Users; dbo.Orders →
// Orders; [Users-2024] → Users-2024. Splitting on dots OUTSIDE brackets keeps
// refs and defs in agreement regardless of how a name was written.
function unquoteSqlIdentifier(s: string): string {
    return unquotePart(lastDottedComponent(s));
}

function lastDottedComponent(s: string): string {
    let inBracket = false;
    for (let i = s.length - 1; i >= 0; i -= 1) {
        const ch = s[i];
        if (ch === "]") inBracket = true;
        else if (ch === "[") inBracket = false;
        else if (ch === "." && !inBracket) return s.slice(i + 1);
    }
    return s;
}

function unquotePart(s: string): string {
    if (s.length >= 2) {
        const first = s[0];
        const last = s[s.length - 1];
        if (first === '"' && last === '"') return s.slice(1, -1).replace(/""/g, '"');
        if (first === "[" && last === "]") return s.slice(1, -1).replace(/]]/g, "]");
    }
    return s;
}

function collectChildren(ctx: unknown, methodName: string): unknown[] {
    const node = ctx as Record<string, unknown>;
    const accessor = node[methodName] as ((...args: unknown[]) => unknown) | undefined;
    if (typeof accessor !== "function") return [];
    const raw = accessor.call(node);
    if (Array.isArray(raw)) return raw;
    return raw ? [raw] : [];
}

function findDescendants(root: unknown, ctxName: string): unknown[] {
    const out: unknown[] = [];
    const stack: unknown[] = [root];
    while (stack.length > 0) {
        const node = stack.pop() as {
            constructor?: { name?: string };
            getChildCount?: () => number;
            getChild?: (i: number) => unknown;
        };
        if (!node) continue;
        if (node.constructor?.name === ctxName) out.push(node);
        const count = node.getChildCount?.() ?? 0;
        for (let i = 0; i < count; i += 1) stack.push(node.getChild?.(i));
    }
    return out;
}
