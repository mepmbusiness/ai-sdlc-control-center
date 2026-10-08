# Product management practice

What product managers do across the lifecycle, how product risk is framed, and how Anthropic runs product work with AI. Organized by theme.

## Sources

| Tag | Source | Date |
|---|---|---|
| AG | Aakash Gupta, [Product development lifecycle stages](https://www.aakashg.com/product-development-lifecycle-stages/) | read 2026-10-06 |
| AMP | Amplitude, [What is the product development lifecycle (PDLC)?](https://amplitude.com/explore/product/product-development-lifecycle) | read 2026-10-08 |
| RM | Ravi Mehta, Product Competency Toolkit, as described by [Reforge](https://www.reforge.com/blog/product-manager-skills) | read 2026-10-08 |
| PI | Pragmatic Institute, [Pragmatic Framework](https://pragmaticinstitute.com/product/framework/launch) | read 2026-10-08 |
| SVPG | Marty Cagan (SVPG), [The four big risks](https://svpg.com/four-big-risks/) | read 2026-10-08 |
| TT | Teresa Torres (Product Talk), [Discovery habit](https://www.producttalk.org/glossary-discovery-discovery-habit/) and [How I designed and implemented evals for Product Talk's Interview Coach](https://www.producttalk.org/2025/09/interview-coach-evals/) | 2025-09 |
| CW | Cat Wu (Head of Product, Claude Code), [Product management on the AI exponential](https://claude.com/blog/product-management-on-the-ai-exponential) | 2026-03-19 |
| ATU | Anthropic, [How Anthropic teams use Claude Code](https://claude.com/blog/how-anthropic-teams-use-claude-code) | read 2026-10-08 |
| SDLC | Anthropic (Louis Claxton), [The AI-native SDLC playbook](https://claude.com/resources/articles/the-ai-native-sdlc-playbook) | 2026-08-21 |
| DP | Dean Peters, [Product-Manager-Skills](https://github.com/deanpeters/Product-Manager-Skills) (GitHub) | read 2026-10-06 |

---

## 1. The product development lifecycle

Amplitude names six core stages: "discovery, definition, design, development, launch, and iteration." A success metric is set during definition, and measurement runs through every stage. [AMP]

Aakash Gupta's breakdown, with the PM's activities and artifacts at each stage [AG]:

| Stage | PM activities | Artifacts |
|---|---|---|
| Ideation and strategic discovery | Jobs-to-be-done interviews, competitive analysis, AI-assisted research synthesis | Validated problem statement, personas, competitive analysis |
| Strategy and scope | Business case with TAM/SAM/SOM, MVP scope, prioritization (RICE, MoSCoW) | One-page business case, roadmap, prioritized MVP list, OKRs |
| Prototyping and design validation | Design brief, wireframe and mockup review, user testing | User flows, wireframes, interactive prototypes, test results |
| Building and testing | Sprint planning, backlog prioritization, acceptance criteria, scope/time/quality trade-offs | Working software, QA results, bug reports |
| Launch and growth | Go-to-market coordination, feedback collection, quantitative and qualitative analysis, iteration | GTM plan, sales enablement, dashboards, iteration backlog |
| Maturity, decline, sunsetting | Performance monitoring, engagement analysis, sunset strategy | Sunset plan, migration strategy, end-of-life communication |

## 2. PM competencies and responsibilities

Ravi Mehta's toolkit (former CPO at Tinder, product leader at Meta, Tripadvisor and Xbox) describes 12 competencies in four areas [RM]:

| Area | Competencies |
|---|---|
| Product Execution | Feature specification, product delivery, product quality |
| Customer Insight | Fluency with data, voice of the customer, user experience design |
| Product Strategy | Business outcome ownership, product vision and roadmapping, strategic impact |
| Influencing People | Stakeholder management, team leadership, managing up |

Most PMs, even the best, excel at only a handful of these; strong PMs know their gaps and build teams that fill them. [RM]

The Pragmatic Framework maps product work as 37 activities on two axes: strategic to executional, and business-oriented to technology-oriented. Examples include market problems, win/loss analysis, competitive landscape, market definition, product roadmap, pricing, buyer and user personas, requirements, use scenarios, launch, sales enablement and channel support. [PI]

Dean Peters' open-source PM skills library is a useful coverage reference: 77 skills across framing and strategy, stakeholder alignment, discovery and research, prioritization and roadmapping, PM deliverables (user stories, PRDs, press releases), validation and experimentation, and finance, growth and competitive intelligence. It uses skills only, no subagents, with human decision points between steps. [DP]

## 3. Product risk

Cagan's four big risks, and who owns each in an empowered product team [SVPG]:

| Risk | Question | Owner |
|---|---|---|
| Value | "whether customers will buy it or users will choose to use it" | Product manager |
| Usability | "whether users can figure out how to use it" | Product designer |
| Feasibility | "whether our engineers can build what we need with the time, skills and technology we have" | Tech lead |
| Business viability | "whether this solution also works for the various aspects of our business" | Product manager |

## 4. Discovery

A **discovery habit** is a recurring practice that gives a product team a clear feedback loop on its decisions about what to build: defining outcomes, customer interviewing, story mapping and assumption testing. [TT]

For AI products there is one more decision to get feedback on: is the AI output any good? Error analysis of customer traces, designing evals and running experiments to reduce errors provide that loop, which is why Torres calls evals a new discovery habit. [TT] (For eval practice, see [ai-agents.md](ai-agents.md), theme 11.)

## 5. How Anthropic runs product work with AI

**The planning assumption changed.** "The traditional product management playbook is built on the assumption that what's technologically possible at the start of a project is roughly what's possible at the end." With fast model progress, that no longer holds. [CW]

**Side quests.** "A side quest is a short self-directed experiment you run outside your official roadmap... an afternoon spent prototyping an idea." [CW]

**Demos over docs.** The Claude Code team replaced stand-ups with shared demos of new ideas, tested with internal users. "Because you can prototype in an afternoon, wrong bets are cheap." [CW]

**Do the simple thing.** "The simpler your implementation, the easier it is to swap in new capabilities when they arrive." [CW]

**Revisit with every model.** "Every model release is an implicit prompt to revisit what you've already built." User workarounds show where scaffolding should become a feature. [CW]

**Few non-negotiables.** "Identify the handful of true non-negotiables and let the rest go." [CW]

**Tools.** Cat Wu uses Claude.ai for strategy and brainstorming, Claude Code for prototypes, evals and scripts, and Cowork for knowledge work such as slides and task tracking. [CW]

**Edge cases during design.** Anthropic's Product Design team uses Claude Code for "mapping out error states, logic flows, and system statuses to identify edge cases during design rather than discovering them in development." [ATU]

**The AI-native SDLC.** Anthropic's playbook describes six stages, each leaving a versioned artifact the next one reads [SDLC]:

| Stage | What changes | Human role |
|---|---|---|
| Plan | The originator captures intent with Claude in `intent.md` | Product owner approves the intent |
| Design | Requirements and design collapse into one `spec.md`, guided by organizational skills | Product owner reviews the spec |
| Build | Plan mode produces `plan.md` before any code | Engineer approves the plan, reviews commits against it |
| Test | Sessions verify their own work; verification is made quantifiable | Code owners focus on intent and risk |
| Deploy | Claude reviews PRs for policy; the agent that wrote the code cannot approve it | Code owners approve; release managers authorize production |
| Maintain | Monitoring triggers Claude; findings re-enter the pipeline as new intent | On-call triages and approves fixes through normal gates |

Its governance has three layers: skills advise, hooks enforce deterministically, humans judge. [SDLC]
