# Building with AI agents

What is known about building and running AI agents, organized by theme.

## Sources

| Tag | Source | Date |
|---|---|---|
| NS | Nick Saraev, [*AI Agents Full Course 2026*](https://www.youtube.com/watch?v=EsTrWCV0Ph4). Practical course from someone who sells automation and education. Strong demos, theory sometimes wrong (see Cautions). | studied 2026-10-06 |
| BEA | Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | 2024-12-19 |
| CTX | Anthropic, [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | 2025-09-29 |
| SKL | Anthropic, [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) | 2025-10-16, updated 2025-12-18 |
| MAR | Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) | 2025-06-13 |
| EVL | Anthropic (Grace, Hadfield, Olivares, De Jonghe), [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | 2026-01-09 |
| CCC | Anthropic (Nicholas Carlini), [Building a C compiler with a team of parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler) | 2026-02-05 |
| HRN | Anthropic (Prithvi Rajasekaran), [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps) | 2026-03-24 |
| STR | Anthropic (Michael Segner), [Steering Claude Code: when to use CLAUDE.md, skills, hooks, and subagents](https://claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more) | 2026-06-18 |
| SDLC | Anthropic (Louis Claxton), [The AI-native SDLC playbook](https://claude.com/resources/articles/the-ai-native-sdlc-playbook) | 2026-08-21 |
| COM | Anthropic (Ali Shazal, Matthew Koen), [The anatomy of effective commerce agents](https://claude.com/blog/the-anatomy-of-effective-commerce-agents) | 2026-09-02 |
| BP | Claude Code docs, [Best practices](https://code.claude.com/docs/en/best-practices) | read 2026-10-08 |
| AT | Claude Code docs, [Agent teams](https://code.claude.com/docs/en/agent-teams) | read 2026-10-08 |
| HS | Hamel Husain and Shreya Shankar, [Building eval systems that improve your AI product](https://www.lennysnewsletter.com/p/building-eval-systems-that-improve) (Lenny's Newsletter) | 2025-09-09 |

---

## 1. What an agent is

An agent is a language model running in a loop: it **observes** (reads instructions, files, the result of its last action), **thinks** (decides the next step) and **acts** (calls a tool: web search, file edit, shell command, browser click). The result of the action becomes new context and the loop repeats until the agent meets its **definition of done**. A chatbot answers once; an agent is model + tools + loop + memory. Market terms: *agent loop*, *ReAct*. [NS]

Anthropic separates two kinds of agentic system. **Workflows** are "systems where LLMs and tools are orchestrated through predefined code paths." **Agents** are "systems where LLMs dynamically direct their own processes and tool usage, maintaining control over how they accomplish tasks." [BEA]

**Start simple.** "We recommend finding the simplest solution possible, and only increasing complexity when needed." Agentic systems "often trade latency and cost for better task performance, and you should consider when this tradeoff makes sense." [BEA]

**The model is the smallest part.** What makes an agent perform is what surrounds it: tools, memory, context management, instructions. The market calls this the *harness* or *scaffolding*. [NS] Anthropic adds that a harness should be re-examined when a new model ships, "stripping away pieces that are no longer load-bearing." [HRN]

**Definition of done.** The criteria that tell the agent when to stop. Without them the agent stops too early or delivers something generic. It works as acceptance criteria written for a machine. [NS] Claude "stops when the work looks done"; without a check it can run, "looks done" is the only signal available. [BP]

**The agent's edge is parallelism, not intelligence.** One copy alone makes more mistakes than a person, but dozens of copies can run at once, trying different paths. Most advanced techniques below exploit this. [NS]

Anthropic's three core principles: keep the design **simple**, make it **transparent** by showing the agent's planning steps, and craft the **agent-computer interface** (tool definitions) through documentation and testing. [BEA]

## 2. Choosing models and platforms

The three main platforms are Claude Code (Anthropic), Codex (OpenAI) and Antigravity (Google). They work the same way: a working folder, chat, visible reasoning, tools and queued messages. [NS]

Differences as of mid-2026, according to the course [NS]:

| Model | Strong at | Weak at |
|---|---|---|
| Claude | Legible reasoning (you can follow, interrupt and redirect it), orchestration, consistency | Slower, visual design |
| Gemini | Front-end and design, native video understanding | Opaque reasoning, inconsistent quality |
| GPT / Codex | Back-end, math, test-driven development | Less legible |

A model's lead usually comes from which one was trained most recently, and it flips with the next generation. For most uses any of them works. Avoid tying a product to one model (*model-agnostic*). [NS]

**Routing** is a named Anthropic pattern: classify the input and send it to a specialized path. It "works well for complex tasks where there are distinct categories that are better handled separately, and where classification can be handled accurately." Sending easy questions to a smaller model and hard ones to a larger model is one use. [BEA]

**Cautions.** Model strengths in the table are the course author's observations, not measurements. Whether a task should go to a given model is a question for an eval (theme 11).

## 3. Memory and persistent instructions

An instruction file is pasted at the top of every conversation. The name depends on the tool (`CLAUDE.md`, `AGENTS.md` in Codex, `GEMINI.md`). It exists in layers: global, project, and automatic memory. Skills come next, then the message of the moment. [NS]

Keep it short and broadly applicable. "CLAUDE.md is loaded every session, so only include things that apply broadly. For domain knowledge or workflows that are only relevant sometimes, use skills instead." For each line, ask whether removing it would cause mistakes; if not, cut it. "Bloated CLAUDE.md files cause Claude to ignore your actual instructions." [BP]

**Learned rules** (*self-modifying instructions*). An instruction tells the agent to record a new rule whenever it is corrected, in the form "always/never do X because Y". Preference errors drop session after session. [NS] Anthropic applies the same idea in review: "When a review flags a mistake for the second time, the correction goes into `CLAUDE.md`." [SDLC]

**Instructions are not guardrails.** "When there's something that absolutely must not happen, an instruction is the wrong tool... A real guardrail needs to be deterministic." [STR] Hooks are deterministic; instructions are advisory. [BP] "A skill is an advisory control while a hook is the deterministic layer behind it." [SDLC]

**Cautions.** With many rules, they start to contradict each other, and the whole file costs context on every message (theme 9). Rules need pruning, not just accumulation. [NS] [BP]

## 4. Skills (reusable procedures)

A skill is a standard procedure stored in a file (`SKILL.md`) with a header holding a name and a description. It turns a task that would come out differently every time into a repeatable path. Claude, Codex and Gemini adopted the same format, and skills from other people can be reused. [NS]

**Progressive disclosure.** Only the name and description sit in the context at startup. The full `SKILL.md` loads when the skill is relevant, and bundled files load only when needed. That is why an agent can have many skills without paying for all of them on every message. [SKL] [NS]

"Instructions that are procedural, like deploy workflows, release checklists, or review processes, belong in a skill." [STR]

**Single agent with skills vs. subagents.** In Anthropic's commerce deployments, "a single agent with skills consistently has outperformed both the one-prompt-for-everything design and the subagent design on quality, and often at a lower cost and latency per task." The reason is the *handoff tax*: "Every handoff to a subagent is a state-lossy operation, which often impacts the quality of the subagent's response," and "each handoff can cost several times the tokens and adds seconds of latency." [COM]

## 5. Multi-agent orchestration and MCP

**Orchestrator and specialists.** A manager agent breaks the task down, delegates each part to the model that is strongest at it, then merges and validates. Course example: Claude coordinates, Gemini builds the interface, Codex builds the back-end and tests. The other models plug in as MCP servers. [NS] Anthropic's version is **orchestrator-workers**, "well-suited for complex tasks where you can't predict the subtasks needed." [BEA]

**MCP (Model Context Protocol).** The open standard, created by Anthropic, for plugging external tools and systems into an agent: browser, apps, other models. Each system exposes its actions once and any compatible agent can use them. [NS]

**Subagents.** Child agents, each with its own clean context, that return only the result to the parent. The subagent "returns only a condensed, distilled summary of its work (often 1,000-2,000 tokens)." [CTX] This keeps the main context clean. [NS]

**When multi-agent pays off.** Anthropic's research system (Opus 4 lead, Sonnet 4 subagents) "outperformed single-agent Claude Opus 4 by 90.2%" on its internal research eval. The cost: "agents typically use about 4× more tokens than chat interactions, and multi-agent systems use about 15× more tokens than chats." [MAR]

**When it does not.** "Some domains that require all agents to share the same context or involve many dependencies between agents are not a good fit for multi-agent systems," and "most coding tasks involve fewer truly parallelizable tasks than research." [MAR] The one subagent use Anthropic names as common in commerce production is deep research: "the subagent searches and reads documents, writes and runs code, traverses data models, and hits dead ends." [COM]

**Subagents vs. agent teams (Claude Code).** Subagents report results back to the main agent. In an agent team, separate sessions share a task list and message each other directly. "Use subagents when you need quick, focused workers that report back. Use agent teams when teammates need to share findings, challenge each other, and coordinate on their own." Agent teams "use significantly more tokens than a single session," and "for sequential tasks, same-file edits, or work with many dependencies, a single session or subagents are more effective." Recommended size: 3 to 5 teammates. The feature is experimental and off by default. [AT]

**Trade-offs.** Gains in quality and speed. Losses in cost (leaving the subsidized monthly plan for per-provider API billing) and complexity. Only worth it when a few quality points matter. [NS]

**Video as instructions.** Claude and GPT do not watch video, but Gemini does (about one frame per second). Claude sends Gemini a tutorial link, Gemini returns detailed steps, Claude executes them with its tools. [NS]

## 6. Using several runs to get better answers

Models are probabilistic: the same question yields slightly different answers each time. Three patterns exploit this.

**Stochastic consensus.** Run N agents in parallel on the same problem, each with a different framing ("limited budget", "only what is measurable", "from the user's point of view"). The parent groups the results into **consensus** (worth doing), **divergence** (worth analyzing) and **outliers** (a rare good idea or a hallucination). Good for ideation, decisions and ranking. Market terms: *self-consistency*, *ensembling*. [NS] Anthropic calls this **parallelization by voting**: "running the same task multiple times to get diverse outputs." Its sibling, **sectioning**, divides "a task into independent subtasks run in parallel." [BEA]

**Debate between agents.** Agents with different personas (systems thinker, pragmatist, edge-case hunter, user advocate, contrarian) write to a shared conversation file in turns. By challenging each other they refine ideas more than consensus does. Market term: *multi-agent debate*. [NS] Claude Code docs describe the same use for agent teams: when investigating, "a single agent tends to find one plausible explanation and stop looking"; teammates told to disprove each other's theories counter this anchoring. [AT]

**Independent review.** The agent that built something is attached to its own choices and rarely finds its own mistakes. Pass **only the result** (not the reasoning) to a reviewer with a fresh context, who checks correctness, edge cases, simplification and security. Fixes go to a third agent. Market terms: *generator-verifier*, *LLM-as-a-judge*. A direct cousin of evals. [NS]

Anthropic's evidence for separating the evaluator: when asked to evaluate work they produced, "agents tend to respond by confidently praising the work... even when, to a human observer, the quality is obviously mediocre." And "tuning a standalone evaluator to be skeptical turns out to be far more tractable than making a generator critical of its own work." In that harness, generator and evaluator agreed a **sprint contract** before each chunk of work: what done looks like and how it will be verified. [HRN] The pattern is named **evaluator-optimizer**, "particularly effective when we have clear evaluation criteria, and when iterative refinement provides measurable value." [BEA] Separation of duties also applies to approval: "the agent that wrote the code has no way to approve it." [SDLC]

**Cautions.**
- The course explains *mixture of experts* as "sending the question to several models and averaging". That is wrong. Mixture of experts is the internal architecture of **one** model, which routes each piece of text to a few specialized sub-blocks.
- Consensus and debate produce more ideas, not correct ideas. They support ideation; they do not replace strategic decisions.
- A reviewer asked to find gaps "will usually report some, even when the work is sound." Tell it to flag only gaps that affect correctness or the stated requirements. [BP]

## 7. Specify before executing

**Prompt contract.** Before a non-trivial task, the agent drafts a contract and only executes after the user approves it. Four parts: objective, constraints, output format and **failure conditions**, which are the differentiator (e.g., "fails if it looks like a generic template, breaks on mobile or exceeds 500 lines"). [NS]

**Reverse prompting.** Before the contract, the agent asks about five questions the user did not think to answer: goal, hidden assumptions, taste choices, failure modes. It raises the odds of getting it right the first time. Market term: *clarifying questions*. [NS] Claude Code docs recommend the same for larger features: have Claude interview you, then write a spec, then start a fresh session to execute it. "The most useful specs are self-contained: they name the files and interfaces involved, state what is out of scope, and end with an end-to-end verification step." [BP]

**Explore, plan, then code.** "Separate research and planning from implementation to avoid solving the wrong problem." Planning is most useful when the approach is uncertain or the change spans several files; "if you could describe the diff in one sentence, skip the plan." [BP]

**Artifact chain.** In Anthropic's AI-native SDLC, each stage commits an artifact the next stage reads: `intent.md`, `spec.md`, `plan.md`, the diff with tests, the PR with review findings, and the incident record. Together they form the audit trail. [SDLC]

**Give the agent a way to verify.** "Give Claude a check it can run: tests, a build, a screenshot to compare. It's the difference between a session you watch and one you walk away from." Ask for evidence (test output, the command and its result, a screenshot) rather than a claim of success. [BP]

## 8. Parallel agents in the browser

An orchestrator launches N agents, each with its own Chrome (via the Chrome DevTools MCP) and its own folder. They coordinate through a central chat file the orchestrator checks periodically. A task that takes 2 minutes per item gives 0.5 items per minute; 100 agents give 50 per minute. [NS]

Anthropic's large-scale parallel case: 16 agents, nearly 2,000 Claude Code sessions and about US$20,000 in API cost produced a 100,000-line C compiler. Lessons: "it's important that the task verifier is nearly perfect, otherwise Claude will solve the wrong problem"; each agent starts with no context, so READMEs and progress files must be kept current; parallelism was easy while there were many independent failing tests (each agent picked one) and broke down on one monolithic task until a new harness split it up. [CCC]

**Cautions.** Mass automation on third-party sites runs into terms of service, spam and data-protection law (LGPD/GDPR). The course mentions evading bot detection, which is a problem, not a technique to copy.

## 9. Context management

**Context window.** Everything the model sees in one call, today between 200,000 and 1,000,000 tokens (one token is about 0.75 words). The fuller the window, the **worse the quality** and the higher the cost. [NS] "As the number of tokens in the context window increases, the model's ability to accurately recall information from that context decreases" (*context rot*). [CTX]

**The goal.** "Find the smallest set of high-signal tokens that maximize the likelihood of your desired outcome." [CTX]

**Configuration takes space too.** In the course, 9,000 tokens were in use before the first message: system instructions, CLAUDE.md, memory, skills and MCP tools. A bloated setup makes every conversation start worse. [NS]

**Compaction.** When the window fills, the tool summarizes the history. Details get lost, such as tool output and old decisions. [NS] "Overly aggressive compaction can result in the loss of subtle but critical context whose importance only becomes apparent later." Critical information belongs in files (*structured note-taking*), not only in the conversation. [CTX]

**Iceberg technique / just-in-time context.** Keep in context only what must always be there (instructions, memory, current task, file being edited). Everything else the agent fetches on demand. [NS] Agents built this way "maintain lightweight identifiers (file paths, stored queries, web links, etc.) and use these references to dynamically load data into context at runtime using tools." [CTX] Market terms: *just-in-time context*, *agentic search*, part of *context engineering*.

## 10. Cost

**Routing by complexity.** Use the expensive model only where it matters. The course's 60-30-10 rule: 60% of tokens on a cheap model (Haiku, Gemini Flash) for simple tasks like classification and extraction, 30% on a mid-tier model (Sonnet), 10% on the top model (Opus) for planning, orchestration and judging. In the course's numbers, cost drops about 60% with a small quality loss; a lead-generation example costs about US$0.03 per lead against US$0.12 using only the top model. Market terms: *model routing*, *model cascading*. [NS]

**Batch API.** Non-urgent requests sent in bulk cost less. [NS]

**Plan vs. API.** Monthly plans are subsidized. Multi-provider setups on the API cost much more; the course author spent about US$500 in tokens just recording the course. [NS]

**Multi-agent multiplier.** About 4× the tokens of a chat for one agent, about 15× for a multi-agent system. [MAR] Agent team token usage "scales with the number of active teammates." [AT]

**Cautions.**
- The course calls the cost vs. quality curve "Yerkes-Dodson". That is a psychology law about arousal and performance, unrelated to this.
- Whether a task tolerates a cheaper model is decided by an eval, not by intuition.

## 11. Evals

**Start small, from real failures.** "20-50 simple tasks drawn from real failures is a great start." [EVL] Anthropic's research team "started with a set of about 20 queries representing real usage patterns." [MAR]

**Error analysis before rubrics.** "You cannot know what to measure until you systematically find out how your product fails in specific contexts." Their playbook has three phases: ground evals in error analysis of real interactions, build a reliable suite (code-based checks for objective issues, LLM-as-a-judge for subjective ones, validated against human labels), then operationalize it to catch regressions. [HS]

**Three kinds of grader.** Code-based (fast, cheap, objective, brittle to valid variation), model-based (flexible, captures nuance, non-deterministic, needs calibration) and human (gold standard, slow, expensive). [EVL]

**Capability vs. regression.** Capability evals ask what the agent can do well and should start at low pass rates. Regression evals ask whether it still handles everything it used to and should stay near 100%. Saturated capability evals graduate into the regression suite. [EVL]

**Consistency metrics.** pass@k "measures the likelihood that an agent gets at least one correct solution in k attempts." pass^k "measures the probability that all k trials succeed," which matters for customer-facing reliability. [EVL]

**Read the transcripts.** "You won't know if your graders are working well unless you read the transcripts and grades from many trials." [EVL] Human testers caught that early research agents "consistently chose SEO-optimized content farms over authoritative but less highly-ranked sources," which automated evals missed. [MAR]

**Who defines success.** "The people closest to product requirements and users are best positioned to define success." [EVL]

**Incidents become evals.** "When a fix ships, add an eval for the incident" so the issue stays covered. [SDLC]
