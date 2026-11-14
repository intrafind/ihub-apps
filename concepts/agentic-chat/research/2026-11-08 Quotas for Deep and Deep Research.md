# Quotas for expensive agentic modes: market research and recommendation inputs for iHub

> How this note is used: the main concept adopts the counts, concurrency limits and per-run budgets from §4 in its §5.9, with two differences. It keeps iHub's existing calendar windows (the reset schedule of the token limits) instead of rolling windows, and it uses iHub's existing value convention (`-1` unlimited, `0` disabled). "Research" in this note is the Deep Research mode.

Research date: 2026-11-08. Every vendor page below was read on that day unless a note says otherwise. "Source date" is the date the page itself shows (last-updated, ms.date or publication date). Where a page shows no date, the column says "undated".

## Evidence markers

| Marker | Meaning |
|---|---|
| **[D]** | Documented: read directly on the vendor's own page. |
| **[D-s]** | Documented, but read from a search-engine excerpt of the vendor page. The fetch tool got HTTP 403 from help.openai.com and chatgpt.com, so every OpenAI help-center figure carries this marker. The wording is OpenAI's, but I could not open the page and check the context or the date. |
| **[S]** | Secondary source: a blog, tracker, news article or community post. |
| **[I]** | Inference: my own arithmetic or judgement. |
| **[U]** | Could not be verified. |

---

## 0. Key findings

1. **Discrete research modes still get count quotas, at about 15–50 runs per user per month in enterprise tiers.** Microsoft 365 Copilot allows 25 per user per month, shared between Researcher and Analyst [D]. Langdock allows 15 per user per rolling 30 days on its own keys [D]. Perplexity Enterprise Pro allows 50 per month and Enterprise Max 500 [D]. Gemini Enterprise allows 3 per day (Standard) or 10 per day (Plus) per licence, pooled across the organisation, with overage billed at $4.00 per query [D]. ChatGPT Edu allows 5 per rolling 24 h, after which runs cost credits [D-s].
2. **General-purpose assistants have moved from counts to compute budgets measured over two windows: a short rolling window (5 h) and a weekly window.** This applies to Claude, where Research has no separate quota and draws on the same limits as chat [D]; to the Gemini app since May 2026, where Deep Research is rated "High" relative cost [D]; to ChatGPT Work/Codex [D]; and to Langdock's fair-use and BYOK spend limits [D]. OpenAI no longer publishes deep-research counts for its consumer plans. The plans are labelled "Limited / Expanded / Maximum", and an in-product counter shows what is left [S].
3. **Credit-based enterprise platforms charge one deep-research run as roughly 5–50 chat turns:**
   - ChatGPT Business: deep research costs 50 credits per task, agent mode 30 credits per message, and a reasoning message 10 credits [D-s].
   - The implied credit value is about $0.04, which makes a deep-research task about $2 [I]. The arithmetic is in §2.2.
   - Glean: a typical Deep Research run cost about 33 FlexCredits (p90 about 144), against about 3–35 FlexCredits for a chat query [D]/[S].
4. **The vendor-documented cost per research task is $1–7.** Gemini Deep Research is about $1–3 per task (about 80 searches, 250k input and 60k output tokens), and Deep Research Max about $3–7 (about 160 searches, 900k input and 80k output tokens) [D]. My bottom-up model of iHub's loop design (§2.4) gives about $2.5–5 per Deep run and $5.7–8 per Research run on frontier models with prompt caching. Without caching, both are about 3–4× higher [I].
5. **Implementation patterns most products share:**
   - Quota is checked when a run starts, and a run that has started is allowed to finish (OpenAI Work, Glean, Perplexity) [D].
   - When quota runs out, the product falls back to a cheaper model or mode (Langdock fallback model, Gemini Flash-Lite, ChatGPT lightweight deep research in 2025) [D]/[S].
   - The remaining quota is visible to the user (ChatGPT counter, Langdock ring indicator, Glean banners at 75/90/100%) [D]/[S].
   - Admins set limits per group, and the highest applicable limit wins (Langdock) [D].
   - Hardly any product publishes a concurrency limit [U].

---

## 1. Published limits by product, mode and plan

### 1.1 Consumer and prosumer assistants

| Product | Mode | Plan | Limit | Window | When exceeded | Evidence | Source | Source date |
|---|---|---|---|---|---|---|---|---|
| ChatGPT | Deep research | Free / Go | "Limited". No count published. | Resets 30 days after first use. | Wait, or upgrade. | [S] | toolcolumn.com/learn/chatgpt-deep-research-limits-by-plan; sumibako.com/blog/chatgpt-limits | 2026-10-11; 2026-11-03 |
| ChatGPT | Deep research | Plus ($20) | "Expanded". No count published. Historical: 25/month (10 full + 15 lightweight), set in April 2025. | 30 days from first use. | In 2025, runs switched to the lightweight model once full runs were used up [S]. Today: wait. | [S] | toolcolumn (above); the-decoder.com (Apr 2025); aiplanfinder.com/chatgpt-usage-limits (still lists 25, verified 2026-01-15) | 2026-10-11 / 2025-04 |
| ChatGPT | Deep research | Pro ($100/$200/$500) | "Maximum". No count published. Historical (Pro $200): 250/month (125 full + 125 lightweight). | 30 days from first use. | Wait. | [S] | same as above | 2026-10 / 2025-04 |
| ChatGPT | Agent mode (legacy; replaced by ChatGPT Work) | Plus / Pro / Business & Enterprise | 40 / 400 / 40 messages per month. Business and Enterprise on flexible pricing pay 30 credits per message. Only the initial user-initiated request counts, and scheduled tasks count. | Monthly | The newest page version says agent mode is no longer available and points to ChatGPT Work. | [D-s] | help.openai.com/en/articles/11752874 | undated (several cached versions) |
| ChatGPT | ChatGPT Work + Codex (agentic) | Plus and Business Standard seat | Estimated local messages per 5 h: GPT-6 Astra 5–45, GPT-6.1 Sol 15–160, GPT-6.1 Terra 35–285, GPT-6 Luna 350–3,000. Weekly limits may also apply. | Rolling 5 h, plus weekly. | "If you reach your usage limits during an active turn, the agent will be able to continue working on that turn" (subject to fair use). After that, users can buy credits, switch to a lighter model, or use their own API key. | [D] | learn.chatgpt.com/docs/pricing | read 2026-11-08 (undated) |
| ChatGPT | Work + Codex | Pro tiers | "Pro plans currently have no five-hour limit". Weekly limits may apply. | Weekly | Buy credits. | [D] | learn.chatgpt.com/docs/pricing | undated |
| ChatGPT | Work + Codex | Business Premium seat ($125) | 5× the Standard allowance, with no 5 h limit. | Weekly | Workspace credits. | [S] | toolcolumn.com/learn/chatgpt-work-codex-limits-by-plan | 2026-11-06 |
| ChatGPT | Thinking | Plus | Up to 3,000 per week (raised from 200 in Aug 2025). | Weekly | "ChatGPT may continue with another available model". | [S] | aiplanfinder.com (verified 2026-07-29); sumibako.com | 2026-07-29 / 2026-11-03 |
| ChatGPT | Pro reasoning model | Pro $200 | A weekly GPT-6 Pro allowance (count not published). | Weekly | Falls back automatically to GPT-5.6 Thinking at medium effort. | [S] | sumibako.com (cites help.openai.com/en/articles/9793128) | 2026-11-03 |
| Claude | Research | Pro, Max, Ultra, Team, Enterprise | No separate quota. "Research is subject to the same limits as standard Claude conversations" and uses them up faster. Runs on Opus 5.5 whatever model the user picked. | 5 h session plus weekly. The weekly limit resets at a fixed time assigned to each account. | Blocked until reset. Usage credits ("extra usage") continue the work if the plan or admin has enabled them. | [D] | support.claude.com/en/articles/11088861; .../9797557; .../11049741 | undated ("updated over a week ago") |
| Claude | All usage, including Research and higher effort | Max 5x / 20x | "five times the Pro plan's usage every five hours and every week" (20x is analogous). There is a separate weekly limit for Fable. | 5 h plus weekly. | Usage credits, or wait. | [D] | support.claude.com/en/articles/11049741 | undated |
| Claude | Research run length | All paid | Up to 45 min; most runs take 5–15 min. | per run | — | [S] | maginative.com, getcoai.com (launch, 2025-05-01) | 2025-05 |
| Claude | Research on Pro (one user's report) | Pro | One run used 56% of a 5 h session. An earlier run failed after using 80% of the session. | per session | The run failed mid-way. | [S] (anecdote) | williamangel.net/blog/2026/05/20/... | 2026-05-20 |
| Gemini app | Every feature; Deep Research rated "High" relative cost | No plan / AI Plus / AI Pro / AI Ultra | Compute-based. Plus gets 2× standard, Pro 4×, Ultra 5× or 20× Pro. | "Your limit refreshes every 5 hours until you reach your weekly limit". | Subscribers can continue with Flash-Lite; you can also upgrade or wait. Without a plan, Deep Research "may be unavailable during periods of high demand". | [D] | support.google.com/gemini/answer/16275805 | undated (reflects the May 2026 change) |
| Gemini app | Changes after user complaints | all | Flash-Lite prompts are free. Only successful completions count. A single complex prompt on 3.1 Pro is capped. Deep Research got usage breakdowns and notifications. | — | — | [S] | thurrott.com (Josh Woodward post, 2026-05-29); 9to5google.com/2026/05/21/gemini-usage | 2026-05-29 / 2026-05-21 |
| Gemini app | Deep Research, legacy count limits | Free / Pro / Ultra | 5 per month / 20 per day / 200 per day (2025); Ultra 120 per day (2026 sources). | daily / monthly | Blocked until reset. | [S]. **[U]** whether counts still apply after the compute-based switch. | ai.zenken.co.jp (Mar 2026); googleworkspace.tscloud.co.jp (2026-07-23) | 2026-03 / 2026-07 |

### 1.2 Enterprise suites

| Product | Mode | Plan | Limit | Window | When exceeded | Evidence | Source | Source date |
|---|---|---|---|---|---|---|---|---|
| ChatGPT Business | Deep research | Business | Included per-seat allowance first (count not published), then the pooled workspace credit pool at 50 credits per task. Agent mode costs 30 credits per message; reasoning (medium and above) 10 credits per message; Instant is unlimited. | Credits are valid 12 months. Included limits follow the plan windows. | "If no credits are available in the workspace pool, the feature is blocked." Owners can set the overage limit to 0 to block credit use. | [D-s] | help.openai.com/en/articles/11481834 (rate card); .../11487671 (credits) | undated |
| ChatGPT Enterprise / Edu | Deep research | Flexible pricing | "do not have fixed rate limits". Usage draws on credits. | — | Credit pool, or pause. | [D-s] | help.openai.com/en/articles/11481834 | undated |
| ChatGPT Edu | Deep research | Edu | 5 queries per rolling 24 h, counted from first use. Then 50 credits per task. | Rolling 24 h | Credits. | [D-s] / [S] | rate card; toolcolumn | undated / 2026-10-11 |
| Microsoft 365 Copilot | Researcher (shared with Analyst) | M365 Copilot licence | "A maximum of 25 queries per user per month". The 25 are shared by Researcher and Analyst combined. | Monthly. A community answer says this is a calendar month [S]. | Not documented. There is no admin reporting for these agents. | [D] (limit); [S] (shared, calendar) | learn.microsoft.com/en-us/microsoft-365/copilot/faq-researcher; MS blog 2025-06-02; Northwestern KB | updated 2026-11-04 |
| Microsoft 365 Copilot | Researcher run length | — | Under 5 min for simple queries, 10–45 min for highly complex ones. | per run | — | [D] | same FAQ | 2026-11-04 |
| Microsoft 365 consumer | Researcher / Analyst | Personal, Family / Premium, Pro | Not available / "Extensive usage". | "within a specific time period" (not defined). | The user is notified. | [D] | support.microsoft.com, "AI credits and limits for Microsoft 365 subscriptions" | undated |
| Microsoft Copilot Studio | Custom agents, including reasoning models | Tenant capacity | Credits pooled per tenant. $200 per month buys a 25,000-credit pack; pay-as-you-go is about $0.01 per credit [S]. Reasoning models cost 10 credits per 1,000 billed tokens on top of the feature rate (2 for a generative answer, 5 for an agent action). Cache reads are not billed. No charge for M365 Copilot-licensed employee use, under fair use. | Monthly | "Enforcement is triggered when a tenant reaches 125% of their prepaid capacity". Agents are then blocked, "including in a conversation that's already in progress". Pay-as-you-go avoids the block. Admins can set monthly limits per agent. | [D] | learn.microsoft.com/en-us/microsoft-copilot-studio/requirements-messages-management | ms.date 2026-10-30 |
| Google Workspace (Gemini app) | Deep Research | Business Starter / Business Std & Plus, Enterprise Std & Plus / AI Expanded Access add-on | 5 per month / 20 per day / 30 per day. | daily or monthly, resetting at 12 AM PT. | Blocked until reset. | [S] (counts); [D] (per-user, no rollover, reset times) | googleworkspace.tscloud.co.jp/gemini/deep-research-limits; knowledge.workspace.google.com/.../about-ai-usage-limits ("Limits apply to each user and aren't shared") | 2026-07-23 / 2026-11-06 |
| Gemini Enterprise (Google Cloud) | Deep Research | Standard / Plus / EDU / EDU Pro / Frontline Worker | 3 / 10 / 1 / 10 / 1 per day per licence. The pool is licences × per-user quota, per project and location. | Per day | "exceeding the pooled quota limit restricts functionality" unless overages are enabled. Overage costs **$4.00 per query**. Google recommends setting a monthly spend limit. | [D] | docs.cloud.google.com/gemini/enterprise/docs/overages | undated |
| Perplexity | Research queries | Free / Pro / Max / Enterprise Pro / Enterprise Max | 1 per month / "Monthly limits (average use)" / "Monthly limits (advanced use)" / **50 per month** / **500 per month**. | Monthly | Not stated. | [D] | perplexity.ai/help-center/en/articles/11187416 | undated |
| Perplexity | Labs | Pro / Max, Enterprise Max | 50 per month / unlimited. | Monthly | — | [S] | Reddit quote of the help center; businesstoday.in (Max launch, 2025-07-04) | 2025–2026 |
| Perplexity Enterprise | Computer and premium compute | Enterprise | Credits: each member gets an individual monthly allocation, then can draw on the organisation's shared pool. Admins set caps per seat tier or per person. | Monthly, by billing or sign-up date. No rollover. | "In-progress Computer tasks will pause, not cancel". New tasks are blocked; paused tasks resume after the reset or a top-up. | [D] | perplexity.ai/help-center/en/articles/13901321 | undated |
| Mistral Vibe (formerly Le Chat) | Deep research | Pro / Team / Enterprise | Pro: "more extended thinking and deep research reports". Team: "Even higher limits". Enterprise: custom. **No numbers published.** | **[U]** | **[U]** | [D] (wording); [U] (numbers) | mistral.ai/pricing; help.mistral.ai/en/articles/268866 | read 2026-11-08 |

### 1.3 Enterprise AI platforms comparable to iHub

| Product | Mode | Plan | Limit | Window | When exceeded | Evidence | Source | Source date |
|---|---|---|---|---|---|---|---|---|
| Langdock | Deep Research | Standard workspaces on Langdock keys | **15 researches per user per rolling 30 days**. Runs also count toward session and weekly limits. A run takes 5–30 min. | Rolling 30 days | Not stated **[U]**. | [D] | docs.langdock.com/product/chat/deep-research | undated |
| Langdock | Deep Research | BYOK | "configure their own usage limits or remove limits entirely". BYOK needs a reasoning model and a fast reasoning model configured. | — | — | [D] | same | undated |
| Langdock | All chat and agents, including Deep Research | Cloud fair use | 5 h session (starts with the first message) plus a fixed weekly window (resets Monday). The amounts are not disclosed. | 5 h plus weekly | Requests go to a fallback model (GPT-6 Luna on Cloud, the configured model on BYOK). A workspace spend limit can trigger the fallback earlier. Usage shows in a ring next to the model picker and under Settings > Usage. | [D] | docs.langdock.com/en/using-langdock/models-and-limits/fair-usage-policy | Apr 2026 |
| Langdock | BYOK spend limits | BYOK | Monthly spend caps for the workspace and per user (Standard and Power user plans). The weekly limit is ¼ of the monthly; the session limit is ⅓ of the weekly, over 5 h. Session limits can be switched off. Groups: "Each user gets the highest limit that applies". Extra Usage budgets per person. Users can request more. Models without prices are not counted. | Monthly / weekly / 5 h | A notice above the input names the limit and its reset time; then the fallback model. | [D] | docs.langdock.com/en/admin/manage-usage/byok/usage-limits | Jun 2026 |
| Glean | Deep Research | Enterprise Flex, Universal Model Key | Billed as a Thinking Mode query: about 7 typical / 26 p90 FlexCredits on basic/standard models, about 35 / 120 on premium. | Monthly pool | — | [D] | docs.glean.com/glean-enterprise-flex-pricing | 2026-11-02 |
| Glean | Deep Research | Customer Key (BYOK) | Charged per run, but the rate has not been published since 2026-10-23. It was about 33 typical / 144 p90 FlexCredits. The monthly quota is kept. | — | — | [D] (no rate); [S] (former rate) | same; usagepricing.com/blueprint/activity/glean-2026-10-23-deep-research-rate-withdrawn | 2026-11-02 / 2026-10-23 |
| Glean | Usage limits (all billable use) | Enterprise Flex / Core | A default monthly limit per user, with individual overrides. Team and department limits are per member, not a shared budget. Agents can have a monthly limit. Units are FlexCredits or dollars. | Calendar month | With "Block usage" on: "Glean lets the in-flight action finish, then blocks subsequent billable usage". Basic chat continues. Admins get alerts at 50/75/90/100%, users at 75/90/100%. Users can "Request more". | [D] | docs.glean.com/administration/management/usage/set-usage-limits-and-alerts | undated |
| Dust | All usage, including Go Deep | Free / Pro / Max seat | 500 lifetime / 8,000 per month / 40,000 per month credits per seat. A pooled plan is available. Admins can set a personal spend limit, a group "Limit per member" and group budgets. Programmatic usage has its own monthly cap; 0 blocks it. | Monthly | "A user is only blocked when all available sources are exhausted". The user gets an in-app notification and can request an upgrade. Admins are emailed at a pool threshold and at 80% of the programmatic cap. | [D] | docs.dust.tt/.../credit-management | undated |
| LibreChat (open source) | All endpoints | self-hosted | A token-credit balance per user (1,000 credits = $0.001). Settings: `startBalance`, `autoRefillEnabled`, `refillIntervalValue/Unit`, `refillAmount`. Only prompt tokens are checked before a request, so the completion can push the balance negative. Admins manage balances with the `add-balance`, `set-balance` and `list-balances` CLI commands. Rate limits: `CONCURRENT_MESSAGE_MAX=2` (example value), `MESSAGE_USER_MAX=40` per `MESSAGE_USER_WINDOW=1` min. | Refill interval | The request is blocked. | [D] | librechat.ai/docs/configuration/token_usage; /dotenv | read 2026-11-08 |
| Open WebUI (open source) | — | self-hosted | No built-in per-user token or credit budget was found. Rate limiting is done with Filter Functions (community plugins) or a reverse proxy. | — | — | [S]; **[U]** that no native feature exists | docs.openwebui.com (filters page); fast.io guide | read 2026-11-08 |

---

## 2. Cost per task

### 2.1 Price inputs (USD per 1M tokens unless stated)

| Item | Price | Evidence | Source |
|---|---|---|---|
| Gemini 3.1 Pro (prompts ≤200k) | $2 input / $0.20 cached / $12 output (output includes thinking tokens) | [D] | aistudio.google.com/docs/pricing |
| Gemini 3.1 Pro (prompts >200k) | $4 / $0.40 / $18 | [D] | same |
| Google Search grounding (Gemini 3+) | 5,000 free per month, then **$14 per 1,000**. Default cap of 1,500 requests per day per project. | [D] | same |
| Gemini Deep Research agent | No separate price: tokens at list rates plus tool fees ("Search Grounding excluding retrieved tokens") | [D] | same |
| GPT-6 Astra (OpenAI's recommended model for research at `high`/`xhigh` effort) | $10 / $1 cached / $50 | [D] | developers.openai.com/api/docs/pricing; .../guides/tools-web-search |
| GPT-6.1 Sol | $2 / $0.10 / $10 | [D] | same |
| OpenAI web search tool | **$10 per 1,000 calls**, plus search content tokens at model rates | [D] | same |
| o3-deep-research | $10 / $2.50 / $40. **Shut down 2026-07-23.** | [D] | developers.openai.com/api/docs/models/o3-deep-research |
| Claude Opus 5.5 | $4 input / $0.20 cache hit / $20 output. 5-min cache writes cost $5. | [D] | platform.claude.com/docs/en/about-claude/pricing |
| Claude Sonnet 5.5 | $2 / $0.10 / $10 | [D] | same |
| Anthropic web search | **$10 per 1,000 searches**, plus result tokens. Failed searches are not billed. Web fetch costs only the tokens. | [D] | same |
| ChatGPT credits | Rate card: deep research 50 credits per task, agent 30 per message, reasoning 10 per message | [D-s] | help.openai.com/en/articles/11481834 |
| ChatGPT credit → USD | GPT-6 Astra input costs 250 credits per 1M tokens against $10 per 1M on the API, so 25 credits per dollar and **about $0.04 per credit**. A second secondary source derives the same figure from voice pricing. | [D] (credit rates) + [I] (division); [S] | learn.chatgpt.com/docs/pricing; justinmckelvey.com/blog/chatgpt-credits (2026-10-27) |
| Copilot Studio credit | $200 for 25,000 credits ($0.008 each); pay-as-you-go about $0.01 | [D] (pack, on microsoft.com); [S] (PAYG rate) | microsoft.com Copilot Studio pricing; several guides |

### 2.2 Vendor-published per-task figures

| Product | Cost per task | Evidence |
|---|---|---|
| Gemini Deep Research (API) | "~80 search queries, ~250k input tokens (~50-70% cached), and ~60k output tokens" gives "**~$1.00 - $3.00 per task**". Max research time is 60 min; "Most tasks should complete within 20 minutes". Background mode is required. | [D] aistudio.google.com/docs/deep-research |
| Gemini Deep Research Max (API) | "up to ~160 search queries, ~900k input tokens (~50-70% cached), and ~80k output tokens" gives "**~$3.00 - $7.00 per task**" | [D] same |
| Gemini Enterprise overage | **$4.00 per Deep Research query** beyond the pooled quota | [D] |
| ChatGPT Business deep research | 50 credits × about $0.04 = **about $2.00**. Agent message: 30 × $0.04 = about $1.20. | [D-s] rates, [I] USD |
| Glean Deep Research | About 33 FlexCredits typical, 144 at p90 (Customer Key, until Oct 2026). No dollar price per FlexCredit is published. | [S]/[D] |

### 2.3 Reproducing and transposing the Gemini profile (my arithmetic)

Formula: cost = uncached input × input price + cached input × cache price + output × output price + searches × search price. All results are **[I]**.

| Model (prices from 2.1) | DR standard profile (250k in, 60k out, 80 searches), 50% / 70% cached | DR Max profile (900k in, 80k out, 160 searches), 50% / 70% cached |
|---|---|---|
| Gemini 3.1 Pro, ≤200k rates | $2.12 / $2.03 (tokens $0.93–1.00 + search $1.12) | $4.19 / $3.87 (search $2.24) |
| Gemini 3.1 Pro, >200k rates | $2.75 / $2.57 | $5.66 / $5.01 |
| GPT-6 Astra + OpenAI search | $5.17 / $4.72 (output alone $3.00) | $10.55 / $8.93 |
| GPT-6.1 Sol or Claude Sonnet 5.5 | $1.66 / $1.57 | $3.35 / $3.00 |
| Claude Opus 5.5 | $2.53 / $2.33 | $5.09 / $4.41 |

Example row: Gemini standard at 50% cached = 125k × $2/1M ($0.25) + 125k × $0.20/1M ($0.025) + 60k × $12/1M ($0.72) + 80 × $14/1,000 ($1.12) = **$2.12**. This falls inside Google's stated $1–3, so the public token profile is a usable calibration point.

Two observations from the table [I]:
- On mid-priced models, search fees are 30–55% of the cost of a research run. A per-run search cap is therefore a direct cost lever.
- At OpenAI's top research model, output and reasoning tokens dominate the cost.

### 2.4 Bottom-up model for iHub's modes (all [I]; assumptions stated)

In an agent loop the whole context is sent again every round. Cumulative input = N·base + k·N(N+1)/2, where N is the number of rounds, base is the system prompt plus tools plus the user turn, and k is the tokens added per round (tool result plus model output).

The model assumes base = 10k and k = 2k. That gives 0.9M cumulative input at 25 rounds (final context 60k) and 4.26M at 60 rounds (final context 130k). With k = 3k, 60 rounds would give 6.09M cumulative input and a final context of 190k.

**Prompt caching is the single biggest lever on cost.** Only about base + k·N tokens are new: 130k of the 4.26M in the 60-round case. With a working prefix cache, roughly 97% of the input could therefore be cache reads. The table conservatively assumes 90%.

| Mode (assumptions) | Model | 90% cached | No caching |
|---|---|---|---|
| **Standard**: 25 rounds, 1k output per round, 15 searches | Sonnet 5.5 / GPT-6.1 Sol | $0.66 | $2.20 |
| | Opus 5.5 | $1.17 | $4.25 |
| | GPT-6 Astra | $3.11 | $10.40 |
| **Deep**: 60 rounds, 1.5k output per round (90k incl. reasoning), 40 searches | Sonnet 5.5 / GPT-6.1 Sol | **$2.54** | $9.82 |
| | Gemini 3.1 Pro | $3.26 | $10.16 |
| | Opus 5.5 | **$4.67** | $19.24 |
| | GPT-6 Astra | $12.99 | $47.50 |
| **Research**: lead with 30 rounds (1k output per round) plus 4 sub-agents with 30 rounds each (base 8k, 1.5k output per round), 120 searches; 5.9M cumulative input, 210k output | Opus 5.5 lead + Sonnet 5.5 sub-agents | **$5.67** | $17.88 |
| | Gemini 3.1 Pro throughout ($14/1k search) | $6.45 | $16.02 |
| | GPT-6 Astra lead + GPT-6.1 Sol sub-agents | **$8.20** | $26.16 |

Caveats:
- Cache writes are ignored (Anthropic charges 1.25× for 5-minute writes on top of the base input price). So is cache expiry: Anthropic's 5-minute cache can expire during slow tool calls; a 1-hour cache costs 2× on write.
- Reasoning effort `high`/`xhigh` can multiply output tokens.
- Gemini's documented Max run uses only about 900k cumulative input against my 5.9M. iHub's design, with 4 sub-agents of about 30 rounds each, is token-heavier than Google's agent. Context compaction and capping tool-result size bring it down.
- Ratios: Deep ≈ 3.8× Standard, Research ≈ 8.6× Standard. Anthropic reports about 4× chat for agents and about 15× for multi-agent [D, anthropic.com/engineering/multi-agent-research-system]. Those multipliers are relative to an average chat interaction, not to iHub's Standard mode, so they do not transfer one to one.

### 2.5 Comparators and capacity constraints

- **Platform resale is far more expensive than raw API cost.** Copilot Studio bills reasoning at 10 credits per 1,000 billed tokens. At about $0.01 per credit, that is $0.10 per 1,000 tokens, or $100 per 1M. A run with 400k billed (non-cache-read) tokens would cost about $40 [I]. Microsoft's own example: one message with a reasoning model costs 141 credits, or 461 credits with a cold cache [D].
- **Grounding quota caps research throughput.** The default Gemini Developer API limit of 1,500 grounding requests per project per day allows about 18 standard-profile runs (80 searches) or about 9 Max-profile runs (160 searches) per day per project [I from D]. An organisation-level concurrency and daily cap protects these shared provider quotas.
- **For internal vLLM, the marginal dollar cost is about zero, but capacity is finite.** The binding constraints are concurrent decode streams and prefill load. A Research run with 4 parallel sub-agents holds about 5 LLM loops for 30–60 min. Budgets for vLLM should therefore be expressed as concurrency and tokens, not money. Langdock does not count usage on models that have no prices configured [D]. I did not research vLLM throughput figures; measure them per deployment **[U]**.

---

## 3. How the quotas are implemented and shown

| Pattern | Who does it (evidence) | Note for iHub [I] |
|---|---|---|
| **Per user** (not pooled) | M365 Copilot 25 per user [D]; Workspace "Limits apply to each user and aren't shared" [D]; Langdock 15 per user [D]; Glean team limits are per member, "not a shared team budget" [D] | Predictable and fair. Matches what German admins expect from M365. |
| **Pooled per organisation** | Gemini Enterprise: pool = licences × per-user quota [D]; Copilot Studio credits pooled per tenant [D]; ChatGPT Business credits pooled after per-seat limits [D-s]; Glean FlexCredits pooled [D] | Use this for the organisation's money cap, not for per-user fairness. |
| **Hybrid: individual allocation, then shared pool** | Perplexity Enterprise [D]; ChatGPT Business [D-s]; Dust (seat credits, then pool) [D]; Langdock Extra Usage [D] | A good v2 option. |
| **Counts** vs **credits/compute** | Counts: Copilot, Langdock, Perplexity, Gemini Enterprise, ChatGPT Edu. Credits/compute: Claude, Gemini app, ChatGPT Work, Glean, Dust, LibreChat, Langdock BYOK. | Counts are easy to explain and need no model prices (which matters for vLLM). Credits are fairer across models. |
| **Rolling windows** | Langdock rolling 30 days [D]; ChatGPT "30 days from first use" [S]; ChatGPT Edu rolling 24 h [D-s]; 5 h rolling session (Claude, Gemini, Langdock, ChatGPT Work) [D] | Avoids a stampede at the start of each month, and "next run available on X" is simple to show. |
| **Calendar windows** | Glean calendar month [D]; Workspace resets 12 AM PT and on the 1st [D]; Copilot (calendar month, per a community answer) [S]; Claude weekly reset at a fixed time per account [D]; Langdock weekly resets Monday [D] | Simpler to reason about for finance; worse UX. |
| **Two windows (short + long)** | Claude, Gemini app, ChatGPT Work: 5 h + weekly [D]; Langdock: monthly → weekly (¼) → 5 h session (⅓ of weekly) [D] | Stops one afternoon from burning the whole month. |
| **Group/admin overrides** | Langdock: "highest limit that applies" across plan and groups, plus individual overrides [D]; Glean: per-user default, overrides, team and department per-member limits, agent limits [D]; Dust: group "Limit per member", group budgets [D]; Claude: per-member spend limits, premium vs standard seats [D-s]; Copilot Studio: per-agent monthly limits [D] | Fits iHub's group inheritance. |
| **Remaining quota shown to the user** | ChatGPT in-product counter [S]; Langdock ring next to the model picker plus Settings > Usage [D]; Claude Settings > Usage [D]; Gemini usage page and Deep Research notifications [S]; Glean usage page and banners [D] | Show it in the mode picker. |
| **Soft warnings** | Glean: users warned at 75/90/100%, admins at 50/75/90/100% [D]; Dust: admins emailed at 80% of the programmatic cap [D] | — |
| **Graceful degradation** | Langdock fallback model [D]; Gemini Flash-Lite for subscribers [D]; ChatGPT lightweight deep research (2025) [S]; Pro → Thinking fallback [S]; Glean basic chat continues [D] | Research → Deep → Standard, always explicit to the user. |
| **In-flight runs** | ChatGPT Work: the agent "will be able to continue working on that turn" [D]; Glean: "lets the in-flight action finish" [D]; Perplexity: tasks "pause, not cancel" [D]. Counter-example: Copilot Studio blocks agents mid-conversation at 125% [D]. | Check quota at start; never kill a started run for quota. |
| **Failed runs don't count** | Gemini: "quota is used only for successful completions" [S]; Anthropic: failed searches are not billed [D] | Refund system failures. |
| **Requests for more quota** | Langdock "Allow usage requests" [D]; Glean "Request more" [D]; Dust upgrade requests [D] | v2. |
| **Concurrency limits** | **No vendor publishes a per-user concurrency limit for deep research [U].** Google said it would document guidance for the Deep Research API (forum, no answer) [S]. LibreChat's example config sets `CONCURRENT_MESSAGE_MAX=2` [D]. | iHub has to decide this itself; see §4. |
| **BYOK exception** | Langdock: BYOK workspaces can change or remove limits [D]; Glean Customer Key still meters usage [D] | Allow "unlimited" counts on BYOK or internal models, but keep concurrency and per-run budgets. |

---

## 4. Recommendation inputs for iHub

Everything in this section is **[I]**, built on the documented anchors cited inline. The numbers are defaults that ship in config; admins change them per group.

### 4.1 Model: counts in v1, credits as an option later

- **v1: per-user run counts per mode, plus hard per-run budgets.** Counts need no model prices, which matters because internal vLLM has none; Langdock likewise skips models without prices [D]. Counts are what the closest enterprise competitors use (Copilot, Langdock, Gemini Enterprise, Perplexity Enterprise), and they are easy to explain to users and works councils.
- **v2 (optional): a cost-based budget.** When admins enter input and output prices per model, add a cost budget in currency per user and per organisation, as Langdock BYOK, Glean and Dust do [D]. This is the direction the market is moving.

### 4.2 Default quotas

| Setting | **Deep** | **Research** | Anchor / reasoning |
|---|---|---|---|
| Per-user long window | **40 runs per rolling 30 days** | **15 runs per rolling 30 days** | Research: Langdock 15 per rolling 30 days [D], the German competitor and the closest analogue. M365 Copilot allows 25 per month but shares them with Analyst [D]; ChatGPT gave Plus/Team 25 per month in 2025 [S]. Deep: ChatGPT agent mode allowed 40 per month on Plus and Business [D-s]. Deep costs about ½ of a Research run (§2.4). |
| Per-user short window (burst) | **10 per rolling 24 h** | **3 per rolling 24 h** | Two-window pattern from Claude, Gemini, ChatGPT Work and Langdock [D]. ChatGPT Edu allows 5 per rolling 24 h [D-s]; 3 keeps 15 per month from being used up in 3 days. |
| Power-user group | 120 per 30 d / 20 per 24 h | 50 per 30 d / 8 per 24 h | Research 50 matches Perplexity Enterprise Pro 50 per month [D]. Deep at 3× default parallels ChatGPT Pro's 10× of Plus for agent mode [D-s], scaled down. |
| `anonymous` group | **0 (disabled)** | **0 (disabled)** | A per-user quota cannot hold without a stable identity. Research also runs in the background and needs a recipient for the notification. iHub's `adminAuth` already treats anonymous as a separate identity. |
| Group resolution | Highest applicable limit across the user's resolved groups wins; per-user override; `0` = disabled; `null` = unlimited | same | Langdock's "highest limit that applies" [D]; fits iHub's `inherits` hierarchy. |
| BYOK / internal vLLM | Admin may set counts to unlimited; **concurrency and per-run budgets still apply** | same | Langdock BYOK [D]. GPU capacity and provider rate limits stay finite (§2.5). |

**What these defaults cost a heavy user per month** (computed from the §2.4 cached figures; it assumes the user uses the whole quota):
- Research: 15 × $5.7–8.2 ≈ **$85–125**.
- Deep: 40 × $2.5–4.7 ≈ **$100–190**.
- If every run hit its per-run ceiling (§4.4), the worst case is 15 × $12 + 40 × $5 = **$380**.

Average users will spend far less. I found **no published utilisation data [U]**, so measure actual usage for 30 days before tightening or loosening the defaults.

### 4.3 Concurrency

| Setting | Deep | Research | Reasoning |
|---|---|---|---|
| Per user | **2** running | **1** running (power users: 2) | No vendor publishes one [U]. LibreChat's example caps concurrent messages at 2 [D]. One Research run already fans out to 4–6 parallel loops. |
| Per organisation | **10** running; more are queued FIFO and shown "position n in queue" | **5** running (≈25–30 parallel LLM loops); queued beyond | Protects provider TPM/RPM limits and the grounding quota. Gemini's 1,500 grounding requests per day allow only about 9–18 research runs per project per day (§2.5). It also protects vLLM capacity. Admins should size these to their deployment. |
| Queue timeout | 10 min, then the run is rejected with a "try later" message | 60 min (background) | Research is a background job anyway. |

### 4.4 Per-run budgets (hard caps with a "wrap up" signal at 80%)

| Budget | Deep | Research | Anchor |
|---|---|---|---|
| Tool rounds | 60 | Lead 30; each sub-agent 30; at most 5 sub-agents | iHub design; Anthropic: comparisons need 2–4 sub-agents with 10–15 calls each, complex research >10 sub-agents [D] |
| Web searches | 60 | 160 | Gemini Max uses about 160 [D]. Search fees are 30–55% of the run cost on mid-priced models (§2.3). |
| Cumulative input tokens | 5M (context compaction above 150k) | 8M across all agents | §2.4: 4.3M for 60 rounds; 5.9M for lead + 4 × 30 rounds, with headroom |
| Output tokens (including reasoning) | 120k | 300k | §2.4: 90k / 210k, with headroom for `high` effort |
| Cost ceiling (only when model prices are configured) | **$5** | **$12** | §2.4: Deep $2.5–4.7 and Research $5.7–8.2 with caching on non-top-tier models. Gemini Max costs $3–7 [D]; the Gemini Enterprise overage price is $4 [D]. With top-tier models (GPT-6 Astra-class) the ceiling is reached and the run wraps up early. |
| Wall clock | **15 min** | **60 min** | Gemini DR: 60 min maximum, most runs under 20 min [D]; Copilot Researcher: 10–45 min [D]; Claude Research: up to 45 min [S]; Langdock: 5–30 min [D]; OpenAI's research example uses a 15 min timeout [D] |
| At the cap | Stop calling tools and synthesise from what has been gathered. Don't fail without output. | Same. The lead writes the report from the sub-agent results so far. | Avoids the failure mode in the Claude Pro anecdote, where a run burned the session and produced nothing [S]. |

### 4.5 Window and counting semantics

- **Rolling windows** (24 h and 30 d). The next free slot is the timestamp of the oldest counted run plus the window length. Langdock and ChatGPT both use rolling windows [D]/[S]. Avoid calendar months, which pile usage up at the start of the month.
- **Count at start. Refund automatically on a system or provider failure** before a result is produced (Gemini counts only successful completions [S]).
- **User cancellations count**, unless the run is cancelled before its first tool call (the clarification or planning phase). This prevents gaming the quota.
- **Check quota and the organisation budget before start**, including room for the per-run ceiling. **Once a run has started, it always finishes within its own budget**, even if the organisation cap is crossed meanwhile (ChatGPT Work, Glean, Perplexity [D]; avoid Copilot Studio's mid-conversation block).

### 4.6 Organisation-level money cap (optional, v1.5)

- Precedents: Gemini Enterprise recommends a monthly spend limit [D]; Langdock offers a workspace spend limit [D]; Claude Team/Enterprise has an organisation cap plus per-member caps [D-s]; Copilot Studio offers per-agent limits plus pay-as-you-go [D].
- Setting: `orgMonthlyBudget` in currency, computed from token usage × admin-entered model prices. Off by default for BYOK; on by default in SaaS, where IntraFind pays.
- Alerts to admins at 50/75/90/100% (Glean [D]).
- At 100%: block new Deep and Research runs; Standard and Quick stay available; in-flight runs finish.
- Sizing formula: active users × expected runs per user × cost per run from §2.4. Seed the expected-runs figure from 30 days of telemetry; there is no defensible published utilisation rate **[U]**.

### 4.7 User experience

- **Remaining quota in the mode picker**, for example "Research · 12 of 15 left · next on 14 Nov" (ChatGPT counter, Langdock ring [D]/[S]).
- **Warnings** when the user reaches 80% of a window and before their last run (Glean warns at 75/90/100% [D]).
- **Explicit fallback offers.** When Research is exhausted, offer "Run as Deep instead" (if Deep has quota left), then Standard. When Deep is exhausted, offer Standard. Never downgrade silently: Research produces a report artifact, while Deep produces a chat answer.
- **Background completion notice** for Research.

### 4.8 Points to raise with product, legal and the works council

- **German works councils.** Usage counters per user can count as technical monitoring of employees, which is subject to co-determination under BetrVG §87 (1) No. 6. To keep this manageable:
  - keep only the timestamps the windows need (30-day retention);
  - default admin views to aggregate figures;
  - document the purpose as capacity and cost control.

  This is general legal background, not researched in this task [I].
- **Data that could not be verified:**
  - current ChatGPT deep-research counts per plan (OpenAI no longer publishes them);
  - Mistral Vibe deep-research limits;
  - current Gemini app per-day Deep Research counts after the compute-based switch;
  - Workspace Deep Research counts on an official Google page;
  - Langdock's behaviour when the 15-run limit is reached;
  - any vendor's concurrency limits;
  - real-world utilisation rates.
