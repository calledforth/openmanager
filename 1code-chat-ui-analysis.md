# 1Code Chat UI - Complete Architecture Analysis

## Repository: https://github.com/21st-dev/1Code
## Stack: Electron + React 19 + TypeScript + Tailwind CSS + Jotai + Zustand

---

## 1. COMPLETE FILE MAP OF CHAT UI COMPONENTS

### Core Chat View (main/)
| File | Path | Purpose |
|------|------|---------|
| `active-chat.tsx` | `src/renderer/features/agents/main/` | **Main chat container** - the top-level `ChatView` component with scroll, diff sidebar, input area, all wired together |
| `messages-list.tsx` | `src/renderer/features/agents/main/` | **Message list rendering** - `MessageStoreProvider`, `MessagesList`, `MemoizedAssistantMessages`, external store for fine-grained subscriptions |
| `assistant-message-item.tsx` | `src/renderer/features/agents/main/` | **Assistant message rendering** - processes message parts (text, tools, reasoning), groups exploring/task tools, renders each part via the tool registry |
| `chat-input-area.tsx` | `src/renderer/features/agents/main/` | **Input bar** - model selector, mode toggle, mentions, slash commands, voice input, file upload, attachments |
| `isolated-message-group.tsx` | `src/renderer/features/agents/main/` | Message grouping - groups user message + assistant responses together |
| `isolated-messages-section.tsx` | `src/renderer/features/agents/main/` | Section wrapper for isolated message groups |
| `isolated-text-part.tsx` | `src/renderer/features/agents/main/` | Isolated text part rendering |
| `memoized-text-part.tsx` | `src/renderer/features/agents/main/` | **Text content renderer** - wraps `MemoizedMarkdown` with search highlighting |
| `new-chat-form.tsx` | `src/renderer/features/agents/main/` | New chat creation form |

### Tool Rendering (ui/)
| File | Path | Purpose |
|------|------|---------|
| `agent-tool-call.tsx` | `src/renderer/features/agents/ui/` | **Generic tool call renderer** - icon + title + subtitle in a single line |
| `agent-tool-registry.tsx` | `src/renderer/features/agents/ui/` | **Tool type registry** - maps tool types to icons, title generators, subtitle generators |
| `agent-tool-utils.ts` | `src/renderer/features/agents/ui/` | Tool state caching and comparison utilities for memo optimization |
| `agent-bash-tool.tsx` | `src/renderer/features/agents/ui/` | **Bash/command rendering** - shows command, output, exit code, expand/collapse |
| `agent-edit-tool.tsx` | `src/renderer/features/agents/ui/` | **File edit/write rendering** - inline diff with syntax highlighting via Shiki |
| `agent-thinking-tool.tsx` | `src/renderer/features/agents/ui/` | **Thinking/reasoning rendering** - collapsible with shimmer effect during streaming |
| `agent-exploring-group.tsx` | `src/renderer/features/agents/ui/` | **Exploring group** - groups 3+ consecutive Read/Grep/Glob/WebSearch tools into collapsible |
| `agent-task-tool.tsx` | `src/renderer/features/agents/ui/` | **Sub-agent/task rendering** - shows nested tools, elapsed time, auto-collapse |
| `agent-task-tools.tsx` | `src/renderer/features/agents/ui/` | Task tools group renderer |
| `agent-todo-tool.tsx` | `src/renderer/features/agents/ui/` | TODO tool rendering |
| `agent-plan-tool.tsx` | `src/renderer/features/agents/ui/` | Plan mode tool rendering |
| `agent-plan-file-tool.tsx` | `src/renderer/features/agents/ui/` | Plan file create/update |
| `agent-web-search-tool.tsx` | `src/renderer/features/agents/ui/` | Web search tool |
| `agent-web-search-collapsible.tsx` | `src/renderer/features/agents/ui/` | Collapsible web search results |
| `agent-web-fetch-tool.tsx` | `src/renderer/features/agents/ui/` | Web fetch tool |
| `agent-mcp-tool-call.tsx` | `src/renderer/features/agents/ui/` | MCP tool call rendering |
| `agent-ask-user-question-tool.tsx` | `src/renderer/features/agents/ui/` | Ask user question tool |
| `agent-diff-view.tsx` | `src/renderer/features/agents/ui/` | Full diff view panel |
| `agent-tool-interrupted.tsx` | `src/renderer/features/agents/ui/` | Interrupted tool state indicator |

### Message UI
| File | Path | Purpose |
|------|------|---------|
| `agent-user-message-bubble.tsx` | `src/renderer/features/agents/ui/` | **User message bubble** - rounded pill, overflow detection, expand dialog |
| `message-action-buttons.tsx` | `src/renderer/features/agents/ui/` | **Copy + Play (TTS)** buttons for assistant messages |
| `git-activity-badges.tsx` | `src/renderer/features/agents/ui/` | Git commit/PR badges on messages |
| `sub-chat-status-card.tsx` | `src/renderer/features/agents/ui/` | **Status card** - streaming indicator, changed files, stop/review buttons |
| `agent-queue-indicator.tsx` | `src/renderer/features/agents/ui/` | Queue indicator for pending messages |
| `sub-chat-selector.tsx` | `src/renderer/features/agents/ui/` | Sub-chat tab selector |
| `inline-edit.tsx` | `src/renderer/features/agents/ui/` | Inline edit UI |
| `text-selection-popover.tsx` | `src/renderer/features/agents/ui/` | Text selection context menu |

### Shared Components
| File | Path | Purpose |
|------|------|---------|
| `chat-markdown-renderer.tsx` | `src/renderer/components/` | **Markdown rendering** - uses Streamdown + Shiki for syntax highlighting |
| `text-shimmer.tsx` | `src/renderer/components/ui/` | **TextShimmer** - animated gradient text effect for streaming states |
| `prompt-input.tsx` | `src/renderer/components/ui/` | Prompt input base component |

### State Management
| File | Path | Purpose |
|------|------|---------|
| `message-store.ts` | `src/renderer/features/agents/stores/` | Message atoms with fine-grained Jotai subscriptions |
| `streaming-status-store.ts` | `src/renderer/features/agents/stores/` | Zustand store for per-subchat streaming status |
| `sub-chat-store.ts` | `src/renderer/features/agents/stores/` | Zustand store for sub-chat metadata |
| `agent-chat-store.ts` | `src/renderer/features/agents/stores/` | Agent chat state |
| `message-queue-store.ts` | `src/renderer/features/agents/stores/` | Message queue management |

### Styles
| File | Path | Purpose |
|------|------|---------|
| `globals.css` | `src/renderer/styles/` | Global CSS variables, theme, scrollbar, search highlights, chroma animation |
| `agents-styles.css` | `src/renderer/styles/` | Agent-specific styles, Streamdown spacing overrides, diff view styles |

---

## 2. ARCHITECTURE OVERVIEW

### Message Parts System
1Code uses AI SDK's **message parts** system. Each assistant message has a `parts` array with typed entries:

```typescript
// Part types used in rendering:
type PartType =
  | "text"              // Markdown text content
  | "reasoning"         // Extended thinking/reasoning
  | "tool-Thinking"     // Thinking tool (normalized from reasoning)
  | "tool-Bash"         // Shell command execution
  | "tool-Edit"         // File edit with diff
  | "tool-Write"        // File creation
  | "tool-Read"         // File read
  | "tool-Grep"         // Code search
  | "tool-Glob"         // File search
  | "tool-WebSearch"    // Web search
  | "tool-WebFetch"     // Web fetch
  | "tool-Task"         // Sub-agent/task
  | "tool-TodoWrite"    // TODO management
  | "tool-PlanWrite"    // Plan mode
  | "tool-AskUserQuestion" // Ask user
  | "tool-mcp__*"       // MCP tool calls
  | "exploring-group"   // Grouped exploring tools (virtual)
  | "task-group"        // Grouped task tools (virtual)
  | "step-start"        // Step delimiter (hidden)
```

Each part has a `state` field:
- `"input-streaming"` - Tool input being generated
- `"pending"` - Waiting for execution
- `"output-available"` - Completed with output
- `"output-error"` - Completed with error
- `"result"` - Alternative completion state

### Rendering Pipeline

```
ChatView (active-chat.tsx)
  └── IsolatedMessagesSection
       └── SimpleIsolatedGroup (per user message + assistant responses)
            ├── AgentUserMessageBubble (user message)
            └── MemoizedAssistantMessages
                 └── MessageItemWrapper (per assistant message)
                      └── AssistantMessageItem
                           ├── CollapsibleSteps (intermediate tools)
                           ├── renderPart() → dispatches to specific tool component
                           │    ├── MemoizedTextPart → MemoizedMarkdown
                           │    ├── AgentThinkingTool (reasoning)
                           │    ├── AgentBashTool
                           │    ├── AgentEditTool (inline diff)
                           │    ├── AgentExploringGroup (grouped reads)
                           │    ├── AgentTaskTool (sub-agents)
                           │    ├── AgentToolCall (generic)
                           │    └── AgentMcpToolCall
                           ├── MessageActionButtons (copy/play)
                           └── GitActivityBadges
```

---

## 3. KEY COMPONENT PATTERNS

### A. User Message Bubble (`agent-user-message-bubble.tsx`)

**Design**: Rounded pill with `bg-input-background border`, max-height `100px` with overflow gradient.

```tsx
// Key classes:
"relative bg-input-background border px-3 py-2 rounded-xl whitespace-pre-wrap text-sm"
"max-h-[100px] overflow-hidden"

// Overflow gradient (bottom fade):
"absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-input-background to-transparent pointer-events-none"
```

**Features**:
- `useOverflowDetection` hook with ResizeObserver (no layout thrashing)
- Click-to-expand with full-message dialog
- Search highlighting via DOM TreeWalker (not React state)
- Image attachment thumbnails above text
- Text mentions (quote/diff) rendered as blocks

### B. Tool Call (Generic) (`agent-tool-call.tsx`)

**Design**: Single-line text with icon, title, and subtitle. No background/border - just inline text.

```tsx
// Structure:
<div className="flex items-start gap-1.5 py-0.5 px-2">
  <span className="text-xs text-muted-foreground whitespace-nowrap">
    {isPending ? <TextShimmer>{title}</TextShimmer> : title}
  </span>
  <span className="text-xs text-muted-foreground/70 truncate">
    {subtitle}
  </span>
</div>
```

**Key insight**: Tools are rendered as **plain text lines**, not cards or blocks. The `TextShimmer` component provides the animated gradient effect for pending tools.

### C. TextShimmer (`text-shimmer.tsx`)

**The signature visual effect** - animated gradient sweep across text during streaming.

```tsx
// Uses motion (framer-motion) with CSS background-clip: text
<MotionComponent
  className={cn("relative inline-block bg-clip-text [background-size:250%_100%]", className)}
  style={{
    backgroundImage: `linear-gradient(
      90deg,
      currentColor 0%,
      currentColor 40%,
      color-mix(in oklab, currentColor, transparent 70%) 50%,
      currentColor 60%,
      currentColor 100%
    )`,
  }}
  initial={{ backgroundPosition: "100% center" }}
  animate={shouldAnimate ? { backgroundPosition: "0% center" } : undefined}
  transition={{
    repeat: Infinity,
    duration,
    ease: "linear",
  }}
>
  {children}
</MotionComponent>
```

**Effect**: A translucent "wipe" sweeps left-to-right across the text continuously. Uses `color-mix(in oklab, currentColor, transparent 70%)` for the shimmer band.

### D. Thinking/Reasoning (`agent-thinking-tool.tsx`)

**Design**: Collapsible section, auto-expanded during streaming, auto-collapsed when done.

```tsx
// Header structure:
<div className="group flex items-start gap-1.5 py-0.5 px-2 cursor-pointer">
  <ChevronRight className={cn("transition-transform", isExpanded && "rotate-90")} />
  <span>
    {isStreaming ? <TextShimmer>Thinking</TextShimmer> : "Thought"}
  </span>
  <span className="text-muted-foreground/50">{previewText}</span>
  <span className="text-muted-foreground/40">{elapsedDisplay}</span>
</div>

// Content when expanded:
<div className="pl-5 pr-2 py-1 max-h-[200px] overflow-y-auto">
  <ChatMarkdownRenderer content={thinkingText} size="sm" />
</div>
```

**Behavior**:
- Auto-expands during streaming, auto-collapses on completion
- Shows elapsed time (ticking every second)
- Preview text (first 60 chars) when collapsed
- Top gradient fade on scrollable content

### E. Bash Tool (`agent-bash-tool.tsx`)

**Design**: Bordered card with header + collapsible output.

```tsx
// Container:
"border border-border rounded-lg overflow-hidden my-1"

// Header:
"flex items-center justify-between pl-2.5 pr-0.5 h-7"
// Shows: "Ran command: git, npm" with success/error badge

// Content area:
"border-t border-border px-2.5 py-1.5"
// Shows: $ command (green), stdout (white), stderr (red/yellow)

// Command display:
<span className="text-green-500 dark:text-green-400 mr-1.5">$ </span>
<code className="font-mono text-xs text-foreground/80 whitespace-pre-wrap break-all">
  {displayCommand}
</code>
```

**Features**:
- Collapsed to 3 lines by default, expandable
- Shows "Generating command" with TextShimmer during input-streaming
- Path shortening (replaces absolute project paths with relative)
- Exit code-based success/error status (not tool state)

### F. Edit/Write Tool (`agent-edit-tool.tsx`)

**Design**: Bordered card with file icon, name, diff stats, and inline diff display.

```tsx
// Container:
"border border-border rounded-lg overflow-hidden my-1"

// Header:
<div className="flex items-center gap-1.5">
  {FileIcon}  // File type icon from file extension
  <TextShimmer>{filename}</TextShimmer>  // During streaming
  <span className="text-muted-foreground/50 truncate text-[11px]">{displayPath}</span>
</div>

// Diff stats:
<span className="text-emerald-600">+{addedLines}</span>
<span className="text-red-500">-{removedLines}</span>

// Diff content - git-style colored lines:
"bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"  // Added
"bg-red-500/10 text-red-700 dark:text-red-400"              // Removed
"text-foreground/60"                                          // Context
```

**Features**:
- Syntax highlighting via Shiki (skipped during streaming for FPS)
- Throttled streaming updates (10 FPS / 100ms intervals)
- Auto-scroll-to-bottom effect during streaming (last 15 lines)
- Collapsed by default showing from first change line
- Click filename to open in file viewer
- Shows "Creating"/"Editing" with shimmer during streaming

### G. Exploring Group (`agent-exploring-group.tsx`)

**Design**: Collapsible group of 3+ consecutive Read/Grep/Glob/WebSearch tools.

```tsx
// Header:
<div className="group flex items-start gap-1.5 py-0.5 px-2 cursor-pointer">
  <ChevronRight className={cn("transition-transform", isExpanded && "rotate-90")} />
  <span>{isStreaming ? "Exploring" : "Explored"}</span>
  <span className="text-muted-foreground/70">{subtitle}</span>
  // subtitle: "5 files, 2 searches"
</div>

// Expanded: scrollable list of individual tool calls
// Max 5 visible items (24px each), rest scrollable
```

**Behavior**: Auto-expanded during streaming, auto-collapses on completion. Auto-scrolls to latest tool.

### H. Sub-Agent/Task Tool (`agent-task-tool.tsx`)

**Design**: Same collapsible pattern as ExploringGroup but for sub-agent tasks.

```tsx
// Title with shimmer:
{isPending ? <TextShimmer>Running Subagent</TextShimmer> : "Completed Subagent"}

// Subtitle shows latest nested tool activity when running:
"Reading src/app.tsx"  // From last nested tool

// Elapsed time display:
<span className="text-muted-foreground/40">{elapsedTimeDisplay}</span>
```

### I. Markdown Renderer (`chat-markdown-renderer.tsx`)

**Libraries**: `streamdown` (block-level streaming markdown) + `remark-gfm` + `remark-breaks` + `shiki` (syntax highlighting)

```tsx
// Two modes:
// 1. Streaming: <Streamdown> component (ChatMarkdownRenderer)
// 2. Static: <MemoizedMarkdown> (per-block memoized rendering)

// Key Streamdown usage:
<Streamdown
  remarkPlugins={[remarkBreaks, remarkGfm]}
  components={components}  // Custom h1-h6, p, ul, ol, code, etc.
>
  {processedContent}
</Streamdown>

// Code blocks use Shiki for syntax highlighting:
const html = await highlightCode(children, language, themeId)
// Falls back to escaped plaintext if Shiki fails
```

**Typography**: Notion-like compact spacing via CSS overrides in `agents-styles.css`:
- Paragraphs: `text-sm text-foreground/80 my-px leading-normal py-[3px]`
- Headings: `font-semibold text-foreground` with proper `mt-[1.4em]` spacing
- Inline code: `bg-foreground/[0.06] dark:bg-foreground/[0.1] font-mono text-[85%] rounded px-[0.4em] py-[0.2em]`
- Links: `text-blue-600 dark:text-blue-400 no-underline hover:underline`

### J. SubChat Status Card (`sub-chat-status-card.tsx`)

**Design**: Bottom card showing streaming status + changed files.

```tsx
// Streaming state:
"Generating" + <AnimatedDots />  // Cycles through ., .., ...

// Completed state:
"3 files +42 -15" with Review button

// File list (expandable):
<FileIcon /> path/to/file.tsx  +12  -3
```

### K. Input Area (`chat-input-area.tsx`)

**Design**: Multi-line input with model selector, mode toggle, send button, attachments.

```tsx
// Structure:
<PromptInput>
  <PromptInputContextItems>  // Images, files, text contexts above input
  <AgentsMentionsEditor>     // Rich text editor with @ mention support
  <PromptInputActions>       // Bottom bar: model selector, mode, voice, send
</PromptInput>

// Mode toggle: "Agent" ↔ "Plan" button
// Model selector: Dropdown with Claude/Codex models
// Voice: Hold-to-talk with VoiceWaveIndicator
// Send: AgentSendButton with stop/interrupt support
```

---

## 4. COLLAPSING LOGIC

The assistant message item has sophisticated collapsing:

```typescript
// If there's final text AFTER all tools → collapse tools into "N steps" header
// Otherwise → show everything inline

// Steps that count:
// - Tool calls (except ExitPlanMode, TaskOutput, nested tools)
// - Non-empty text parts

// CollapsibleSteps component:
<CollapsibleSteps stepsCount={visibleStepsCount}>
  {groupedParts}  // Exploring groups + task groups + individual tools
</CollapsibleSteps>
{finalTextParts}  // The actual response text shown below
```

---

## 5. STREAMING STATE MANAGEMENT

### Streaming Detection
```typescript
// In getToolStatus():
const isActivelyStreaming = chatStatus === "streaming" || chatStatus === "submitted"
const isPending = basePending && isActivelyStreaming
const isInterrupted = basePending && !isActivelyStreaming
```

### Performance Optimizations
1. **External Message Store** (`messages-list.tsx`): `useSyncExternalStore` with fine-grained subscriptions per message ID
2. **Jotai Atom Families**: `messageAtomFamily(id)` for per-message subscriptions
3. **AI SDK Mutation Detection**: External cache to detect in-place mutations (AI SDK mutates objects, doesn't create new references)
4. **Throttled Streaming Updates**: Edit tool throttles to 100ms intervals during streaming
5. **Shiki Skipping**: Syntax highlighting disabled during streaming for FPS

---

## 6. TOOL GROUPING

```typescript
// Exploring tools → grouped when 3+ consecutive:
const EXPLORING_TOOLS = ["tool-Read", "tool-Grep", "tool-Glob", "tool-WebSearch", "tool-WebFetch"]

// Task management tools → grouped when 1+ consecutive:
const TASK_TOOLS = ["tool-TaskCreate", "tool-TaskUpdate", "tool-TaskGet", "tool-TaskList"]

// Pipeline: parts → groupTaskTools() → groupExploringTools() → render
```

---

## 7. CSS DESIGN SYSTEM

### CSS Variables (from globals.css)
```css
:root {
  --background: 0 0% 100%;
  --foreground: 240 10% 3.9%;
  --border: 240 5.9% 90%;
  --input-background: 240 4.8% 95.9%;   /* User bubble bg */
  --muted: 240 4.8% 95.9%;
  --muted-foreground: 240 3.8% 46.1%;
  --primary: 228 100% 50%;              /* Blue accent */
  --tl-background: 0 0% 98%;           /* Chat background */
}

.dark {
  --background: 240 10% 3.9%;
  --foreground: 240 4.8% 95.9%;
  --border: 240 3.7% 15.9%;
  --input-background: 60 2% 18%;        /* #30302E - Claude-like */
  --tl-background: 60 2% 18%;
}
```

### Key Tailwind Patterns
- **Tool text**: `text-xs text-muted-foreground`
- **Tool subtitle**: `text-xs text-muted-foreground/70 truncate`
- **Borders**: `border border-border rounded-lg`
- **Diff added**: `bg-emerald-500/10 text-emerald-700 dark:text-emerald-400`
- **Diff removed**: `bg-red-500/10 text-red-700 dark:text-red-400`
- **Shimmer text**: `bg-clip-text [background-size:250%_100%]` with motion animation
- **Hover transitions**: `transition-[background-color,transform] duration-150 ease-out active:scale-[0.97]`
- **Code blocks**: `bg-muted rounded-lg font-mono text-sm`

---

## 8. THIRD-PARTY LIBRARIES

| Library | Version | Purpose |
|---------|---------|---------|
| `@ai-sdk/react` | ^3.0.14 | AI SDK React hooks (`useChat`) |
| `streamdown` | ^2.0.1 | Block-level streaming markdown renderer |
| `shiki` | ^1.24.4 | Syntax highlighting for code blocks + diffs |
| `motion` | ^11.15.0 | Animations (TextShimmer, collapse/expand, scroll-to-bottom) |
| `jotai` | ^2.11.1 | Atomic state management (per-message subscriptions) |
| `zustand` | ^5.0.3 | Stores (streaming status, sub-chats, message queue) |
| `remark-gfm` | ^4.0.1 | GitHub Flavored Markdown |
| `remark-breaks` | ^4.0.0 | Hard line breaks in markdown |
| `lucide-react` | ^0.468.0 | Icons |
| `sonner` | ^1.7.1 | Toast notifications |
| `@radix-ui/*` | various | Primitives (tooltip, dialog, dropdown, etc.) |
| `@git-diff-view/react` | ^0.0.35 | Full diff view panel |
| `diff` | ^8.0.3 | Diff computation |
| `@tanstack/react-query` | ^5.90.10 | Server state management |
| `mermaid` | ^11.12.2 | Mermaid diagram rendering |
| `tailwindcss-animate` | ^1.0.7 | Tailwind animation utilities |

---

## 9. COMPONENT MAPPING GUIDE

| 1Code Component | Maps To (Your App) | Key Responsibility |
|-----------------|-------------------|-------------------|
| `active-chat.tsx` (ChatView) | Your main ChatPage/ChatContainer | Top-level layout, scroll, input, sidebars |
| `messages-list.tsx` (MessagesList) | Your MessageList | Renders assistant message IDs, fine-grained subscriptions |
| `isolated-message-group.tsx` | Your MessageGroup | Groups user msg + assistant responses |
| `agent-user-message-bubble.tsx` | Your UserMessageBubble | Rounded pill with overflow + expand |
| `assistant-message-item.tsx` | Your AssistantMessage | Dispatches parts to renderers, collapsing logic |
| `memoized-text-part.tsx` | Your TextContent | Markdown rendering with search highlight |
| `chat-markdown-renderer.tsx` | Your MarkdownRenderer | Streamdown + Shiki + Remark |
| `agent-tool-call.tsx` | Your ToolCallLine | Generic one-line tool display |
| `agent-tool-registry.tsx` | Your ToolRegistry | Maps tool types to display metadata |
| `agent-bash-tool.tsx` | Your BashToolCard | Command + output display |
| `agent-edit-tool.tsx` | Your EditToolCard | Inline diff with syntax highlighting |
| `agent-thinking-tool.tsx` | Your ThinkingSection | Collapsible reasoning with shimmer |
| `agent-exploring-group.tsx` | Your ExploringGroup | Grouped read/search tools |
| `agent-task-tool.tsx` | Your SubAgentCard | Sub-agent with nested tools |
| `text-shimmer.tsx` | Your TextShimmer | Animated gradient text effect |
| `sub-chat-status-card.tsx` | Your StatusCard | Streaming indicator + file changes |
| `chat-input-area.tsx` | Your ChatInput | Input with model/mode/voice/attachments |
| `message-action-buttons.tsx` | Your MessageActions | Copy + TTS buttons |
| `agents-styles.css` | Your chat.css | Custom spacing, scrollbar, diff styles |
| `globals.css` | Your theme.css | CSS variables, color scheme |

---

## 10. KEY DESIGN DECISIONS TO PORT

### 1. Tools as Text Lines, Not Cards
Most tools render as single text lines (`text-xs text-muted-foreground`) with a shimmer effect during streaming. Only Bash and Edit get card-like treatment with borders.

### 2. Auto-Collapse Pattern
Thinking, Exploring Groups, and Task Tools all use the same pattern:
- **Expanded** during streaming
- **Auto-collapsed** when streaming ends (`wasStreamingRef` pattern)
- **Toggle** on click with chevron rotation

### 3. Collapsible Steps
When the assistant has a final text response after tools, all preceding tool calls collapse into a "N steps" header.

### 4. External Mutation Detection
AI SDK mutates message objects in place. 1Code uses external caches (`Map<string, snapshot>`) to detect actual changes rather than relying on React reference equality.

### 5. Message Grouping
Messages are grouped as user→assistant pairs. Each group is a `MessageGroup` with sticky user bubble and flowing assistant content below.

### 6. Streaming Markdown
Uses `streamdown` library for block-level memoized markdown during streaming. Each block is independently memoized by content hash.
