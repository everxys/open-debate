# TODO

## High Priority

### 1. Rebuild Tool Harness Around A Runtime Action Protocol

- Current problem:
  the debate runtime still depends on provider-native `tool_calls` behavior to stay stable across long context, multi-step file operations, and resumed conversations.
- Why this is the wrong abstraction:
  Playground can pass short sandbox tool tests while the real runtime still fails on long prompts, fake `tool_calls`, or provider-specific protocol drift.
- Goal:
  keep read/write capability for resumed debates, but move reliability ownership from provider-native tool calling into our own harness.

#### 1.1 Replace Provider-Native Tool Calls As The Primary Contract

- Introduce a small harness-owned action protocol instead of treating OpenAI / Anthropic native tool calling as the main runtime contract.
- The model-facing action surface should be intentionally tiny and explicit, for example:
  - `read`
  - `search`
  - `write_replace`
  - `write_append`
  - `write_section`
  - `vote_cast`
- The harness should parse model output into actions, execute them itself, and feed normalized results back into the next turn.
- Provider-native `tool_calls` may remain as an optional transport, but runtime correctness should not depend on them.
- Goal:
  if a model can emit short structured actions, it should still be able to use debate files correctly even when provider-native tool calling is flaky.

#### 1.2 Gate The Action Surface By Runtime State

- Stop exposing the full read/search/write/vote surface on every generation step.
- Add harness-side action policies so each turn only sees the minimum viable action set for the current state:
  - missing path / unknown target:
    allow `list` or `search` only
  - target path known:
    allow `read`
  - drafting or updating output:
    allow one write action family only
  - open official vote and seat not yet voted:
    allow only `vote_cast`
- Tie this to:
  current phase, current role type, open vote state, and whether the seat already has a working set.
- Goal:
  reduce action entropy so models stop wandering across unrelated tools in long debates.

#### 1.3 Add A Seat-Level Working Set For Resumed Conversations

- Persist a lightweight working set per debate seat, so a resumed conversation does not need to rediscover files from scratch.
- Working set should include:
  - recently read files
  - recently written files
  - current canonical source files
  - version / updatedAt metadata
  - short cached summaries / excerpts
- On resumed turns, inject the working set into prompt context before allowing exploratory file actions.
- Prefer:
  direct read/write against known working-set targets
  over
  repeated `list/search` rediscovery loops.
- Suggested storage / ownership:
  - new runtime helper beside [lib/runtime/runtime-inline-loaders.ts](</C:/Users/Administrator/dev/open-debate/lib/runtime/runtime-inline-loaders.ts>)
  - persisted JSON under debate context files or dedicated DB state, but owned by harness rather than by model output.
- Goal:
  preserve file continuity across restarted conversations without requiring broad exploratory tool use every time.

#### 1.4 Shrink And Normalize Write Semantics

- Current `debate_files_write` is too schema-heavy for unstable tool callers:
  `mode`, `baseVersion`, `baseUpdatedAt`, `reason`, `targetHeading`, `allowShrink`.
- Replace the model-facing write contract with smaller action families:
  - `write_replace(path, content)`
  - `write_append(path, content)`
  - `write_section(path, heading, content)`
- Keep concurrency/version safety in the harness, not in the model-facing action schema.
- Harness should auto-fill:
  version checks, updatedAt checks, shrink protection, and allowable path policy.
- Keep the underlying safe-write engine, but stop asking the model to construct the full low-level payload itself.
- Goal:
  make writes robust enough for weaker tool callers without losing file safety.

#### 1.5 Replace Fixed Tool-Round Limits With Semantic Loop Detection

- Do not restore `MAX_TOOL_ROUNDS`.
- Add harness-side loop detection based on repeated action patterns instead of raw count:
  - repeated identical `search(query)`
  - repeated `stat(path)` without a subsequent write
  - repeated read of the same file without producing a new action
  - repeated writes with near-identical content
  - oscillation between `list` and `search` with no narrowing progress
- When loop patterns are detected:
  fail loudly with a specific runtime error such as
  `AI_TOOL_LOOP_DETECTED`
  and include the repeated pattern in diagnostics.
- Goal:
  stop useless action churn without hiding the real failure behind generic retry or arbitrary caps.

#### 1.6 Keep Playground Aligned With The New Harness

- After the action protocol exists, Playground must stop testing only provider-native tool calling.
- Add a second capability layer in Playground for harness actions:
  - can the model emit valid harness actions?
  - can the harness execute and return normalized results?
  - does the model close the loop after receiving action results?
- Keep existing checklist useful, but treat it as
  `provider native capability smoke`
  rather than
  `production runtime compatibility`.
- Goal:
  make Playground representative of the real harness contract instead of only the raw provider contract.

#### 1.7 Suggested Implementation Order

- Phase 1:
  define action protocol types and parser module.
- Phase 2:
  add harness executor that maps actions onto existing file/vote primitives.
- Phase 3:
  gate action surface by phase / role / vote state.
- Phase 4:
  add seat-level working set persistence and prompt injection.
- Phase 5:
  split model-facing writes into normalized write action families.
- Phase 6:
  add semantic loop detection and diagnostics.
- Phase 7:
  realign Playground around the harness contract.

#### 1.8 Acceptance Criteria

- A resumed debate turn can continue file work without first rediscovering the whole file tree.
- Runtime no longer relies on provider-native `tool_calls` as the sole correctness path.
- Models only see the minimum action surface needed for the current step.
- Write actions no longer require the model to fill low-level concurrency metadata.
- Repeated action churn fails with explicit loop diagnostics, not silent fallback or arbitrary caps.
- Playground can verify harness-level action capability separately from raw provider-native tool capability.

#### 1.9 Unblock `list -> read` Progression

- Current problem:
  when the harness only allows `list/search`, a successful `list` result does not promote discovered paths into the working set or next-step target selection.
- Why this matters:
  the model can discover the exact file path and still remain stuck in another `list/search` turn instead of progressing into `read`.
- Goal:
  make discovery actions actually narrow the next action surface.
- Suggested change:
  after `list` or `search` returns a concrete shared target, persist that discovery into harness-owned state and recompute the action policy for the next generation step.

#### 1.10 Split Readable Shared Paths From Writable Shared Paths

- Current problem:
  shared-file read access and shared-file write access are still effectively modeled through the same `allowedOutputPaths` surface.
- Why this is dangerous:
  read-only but context-relevant files such as facts, summaries, and vote artifacts become entangled with write permissions, which makes harness policy both harder to reason about and easier to drift.
- Goal:
  give the harness separate read and write surfaces for shared files.
- Suggested change:
  introduce distinct runtime policy inputs for:
  - readable shared paths
  - writable shared targets
  and stop using the write-oriented surface as the implicit source of truth for reads.

#### 1.11 Make `read` Policy Truly Path-Scoped

- Current problem:
  the action policy presents `read` as “read the known target directly”, but the executor can still read a much broader path surface.
- Why this is the wrong abstraction:
  the model sees a narrow contract while the runtime silently executes a wider one, which keeps path drift alive even after action-surface narrowing.
- Goal:
  align the policy contract with the executor contract.
- Suggested change:
  when the harness says the current step has a known target, enforce `read` against that target set rather than the full shared readable surface or arbitrary seat files.

#### 1.12 Finish The Vote Migration To Harness-Owned Semantics

- Current problem:
  runtime debate execution is now harness-first, but vote semantics are still split between harness actions and the old provider-native tool stack.
- Why this causes drift:
  prompt wording, tool definitions, and execution paths still reference old vote tools such as `debate_vote_open` / `debate_vote_close`, while the new action protocol only exposes `vote_cast`.
- Goal:
  remove the half-migrated state so voting follows one clear runtime contract.
- Suggested change:
  either:
  - move vote open / close semantics fully into the harness-owned protocol
  or:
  - delete stale provider-native vote prompts, tool definitions, and dead execution branches that no longer participate in the main runtime.

#### 1.13 Expand Harness Checklist And Regression Coverage

- Current problem:
  Playground coverage currently proves only a small subset of harness capability.
- Missing coverage:
  - `list`
  - `search`
  - `write_append`
  - `write_section`
  - prompt implicit-read to first-policy synchronization
- Goal:
  make CI and Playground catch harness regressions before they reappear in live debates.
- Suggested change:
  add checklist cases and runtime tests for discovery-to-read progression, implicit prompt reads, and the full normalized write family rather than only the current `read / write / vote_cast` happy path.

### 2. Clean Up Workflow Config That No Longer Drives Runtime

- Goal:
  remove dead workflow knobs, but do not delete active runtime policy just because the runtime is now harness-first.

#### 2.1 Remove Dead `voting.custom` Bounds

- Current finding:
  `voting.custom.minOptions` and `voting.custom.maxOptions` still exist in workflow normalization / serialization, but do not appear to participate in current runtime behavior.
- Goal:
  delete these dead configuration fields from schema, defaults, editor UI, and serialization so workflow config reflects real runtime behavior.

#### 2.2 Keep Active Runtime Workflow Policy Explicit

- Do not delete these as “harness cleanup”, because they still influence runtime behavior:
  - `contextAccess.*`
  - `deliverables.allowedPaths`
  - `deliverables.requiredFiles`
  - `ideaBank.rawIdeaBankPath`
  - `ideaBank.derivedFiles.*`
  - `promptPolicies.outputBudget`
  - `phaseMachine.*`
  - `completion.mode`
  - `consensus.*`
  - `summarizer.*`
  - `voting.governance.*`
- Follow-up task:
  if workflow cleanup continues later, classify each remaining field as either:
  - harness policy input
  - non-harness runtime behavior
  - dead config
  before deleting anything.
