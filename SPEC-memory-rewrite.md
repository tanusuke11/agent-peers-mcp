# Memory Categories Rewrite — Spec

## Goal

Reduce repo memory categories from 5 to **3**:

| New | Purpose |
|---|---|
| `task` | Which peer did/is doing what work. Replaces ad-hoc activity tracking. |
| `issue` | Currently raised problems / open bugs / known broken state. |
| `architecture` | Project architecture facts (stays). |

The current 5 categories (`decision`, `learning`, `architecture`, `bug-fix`, `convention`)
are abolished. **Existing memory rows in the DB should be migrated** as follows:

- `architecture` → `architecture` (keep)
- `bug-fix` → `issue` (a bug-fix usually documents an issue that was fixed; if it remains useful, surface it as `issue`)
- `decision` → `architecture` (decisions describe how the system is built, fold them in)
- `convention` → `architecture` (conventions are part of the architecture's rules)
- `learning` → `architecture` (catch-all)

Apply the migration in the broker startup as a one-shot SQL UPDATE.

## Files to change

You must search for every reference. Start here:

1. `src/shared/types.ts` — `MemoryCategory` union, all related interfaces.
2. `src/broker/index.ts` —
   - schema (`category TEXT NOT NULL DEFAULT 'learning'` → `'architecture'`)
   - one-shot migration: `UPDATE repo_memories SET category = ... WHERE category IN (...)`
   - `check_conflicts` advisory branches (currently `if (row.category === "decision" || "convention" || "architecture")` and `if (row.category === "bug-fix" || "learning")`) — re-tier them: surface `architecture` and `issue` as advisory; treat `task` differently (recent task entries can be surfaced as "currently in progress" notice).
3. `src/server/index.ts` — `save_memory` Zod enum, tool description, prompt strings that mention old categories.
4. `src/extension/views/memory.ts` (the new view) — any category-specific rendering.

Search:
```
grep -rEn "MemoryCategory|\"decision\"|\"convention\"|\"learning\"|\"bug-fix\"|'decision'|'convention'|'learning'|'bug-fix'" src/
```

Replace every match with the new 3-category model. Be careful not to mangle
unrelated occurrences (e.g. word "decision" in user-facing prose; only change
those if they describe the categories themselves).

## Migration SQL (run once on broker startup)

```ts
try {
  db.exec(`
    UPDATE repo_memories SET category = 'issue' WHERE category = 'bug-fix';
    UPDATE repo_memories SET category = 'architecture' WHERE category IN ('decision','convention','learning');
  `);
} catch { /* noop */ }
```

Wrap in try/catch — safe to re-run.

## save_memory tool description (update text)

In `src/server/index.ts` around the `save_memory` Zod tool:

```ts
category: z.enum(["task", "issue", "architecture"]).describe(
  "Category. Use 'task' to record what a peer did or is doing. Use 'issue' to log open problems or bugs. Use 'architecture' to record how the project is built (modules, conventions, decisions, file layout)."
),
```

Update the surrounding tool description and the broker-instructions string
(around line 887) accordingly.

## check_conflicts surfacing

Re-think the advisory tiering:
- `architecture` entries → advisory (background knowledge)
- `issue` entries that overlap with current task files → blocking-style warning
- `task` entries from other peers in the same files → existing duplicate-task path
  already covers this via current_task / task_intent; consider whether `task`
  memories add anything beyond `selectAllPeers` introspection. If they do, surface them.

## Constraints

- Do not change any other feature.
- Do not edit `src/extension/index.ts` (doe owns it).
- Do not edit `src/extension/views/peer-list.ts` (orca touched it).
- Do not edit `src/server/index.ts` register payload (swan owns it).
- Coordinate broker.ts edits with narwhal: narwhal is rewriting register/cleanup;
  you only need to add the migration SQL and update the schema default + check_conflicts
  advisory branches. **Read narwhal's report first** to avoid stomping on a freshly-rewritten section.
  If narwhal hasn't reported yet, wait for cat to signal you.
- OS-independent.
- When done, run `bun run build` (all components) and reply with type=report.
