# CultureBridge

CultureBridge is a web application that helps newcomers and visitors explore places in a destination city (**Berlin** or **Toronto**) using the cultural interests they already know—artists, TV shows, movies, brands, and public figures—powered by Qloo's taste graph and an Amazon Bedrock tool-use agent.

**Live Demo:** [https://culturebridge-theta.vercel.app](https://culturebridge-theta.vercel.app)

Rather than relying on a language model to invent venue names or claim unverified cultural relationships, CultureBridge separates orchestration from deterministic screening and provenance checks:
- **Qloo's API** (`/search`, `/v2/insights`, `/v2/tags`) supplies entity resolution, cross-domain place discovery, and category metadata.
- **Amazon Bedrock** (via the Converse tool-use API) orchestrates anchor resolution, place discovery, tag lookup, and finalization within strict operational budgets.
- **Deterministic TypeScript code** screens every candidate place against configured rules (`validateEntity`), filters out flagged accommodations and transit hubs, scores category-tag evidence when a category filter is requested, assigns provenance-based labels, runs deterministic, rule-based explanation checks with safe template fallback, and falls back to a deterministic discovery pipeline if Bedrock times out or is unavailable.

---

## Supported Cities and Taste Profiles

### Destination Cities
CultureBridge currently supports two tested destination cities (`src/lib/input/presets.ts`):
- **Berlin, Germany** *(default)* — Neighborhoods across Mitte, Kreuzberg, Neukölln, and Friedrichshain.
- **Toronto, Canada** — Neighborhoods across Downtown, Queen West, Kensington, and the Annex.

### Taste Profiles (Persona Presets)
Users can start from three preset taste profiles or build a custom profile (`src/lib/input/presets.ts`):

| Profile | ID | Default | Seed Interests (`query` + Qloo entity type) |
| --- | --- | --- | --- |
| **Mumbai newcomer** | `mumbai-newcomer` | Yes | `Arijit Singh` (`urn:entity:artist`), `The Office` (`urn:entity:tv_show`), `Radiohead` (`urn:entity:artist`), `Zara` (`urn:entity:brand`) |
| **Art & indie** | `art-indie` | No | `Radiohead` (`urn:entity:artist`), `Björk` (`urn:entity:artist`), `A24` (`urn:entity:brand`) |
| **Food & fashion** | `food-fashion` | No | `The Bear` (`urn:entity:tv_show`), `Anthony Bourdain` (`urn:entity:person`), `Vogue` (`urn:entity:brand`), `Zara` (`urn:entity:brand`) |
| **Custom** | `custom` | No | Blank slate — add up to 5 custom interests |

### Supported Anchor Entity Types
- `urn:entity:artist` — Artist
- `urn:entity:tv_show` — TV show
- `urn:entity:movie` — Movie
- `urn:entity:brand` — Brand
- `urn:entity:person` — Person

Preset definitions store only `{ query, type }` seeds—never pre-baked Qloo entity IDs. Every interest must be resolved against Qloo search and explicitly confirmed by the user before a guide can be generated.

---

## User Journey

1. **Choose a destination and taste profile**  
   Select **Berlin** or **Toronto** and pick one of the three preset profiles (`Mumbai newcomer`, `Art & indie`, `Food & fashion`) or `Custom`.
2. **Search and explicitly confirm Qloo entities**  
   Each interest is looked up via `POST /api/anchors/search`, which performs type-aware entity resolution (`resolveEntityFromResults` in `src/lib/qloo/resolver.ts`). Filtering by requested entity type prevents common search ambiguities (for example, `Arijit Singh` returning a `person` record before the `artist` record, `Zara` returning retail `place` entities alongside the `brand`, or `The Office` returning multiple `tv_show` editions). Users review the returned candidates and explicitly confirm up to 5 interests (`MAX_TRUSTED_ANCHORS = 5`), or edit/remove unconfirmed entries.
3. **Generate the city guide**  
   Submitting confirmed interests sends a request to `POST /api/kit`. The server re-verifies every client-submitted `entityId` against Qloo `/search` before running discovery.
4. **Explore places, interactive map, and search-process trace**  
   - **Categorized recommendations**: Filter recommendations by Qloo place category, inspect query provenance (`How this place connected`—showing single-anchor ranks, combined-query attribution, or category-match provenance when a category filter was evaluated), and view available Qloo catalog details (address, neighborhood, website, phone, price level, additional categories, and supporting tags).
   - **Interactive city map**: Mappable places (with valid latitude and longitude) are plotted as numbered pins on a **Leaflet** map (`src/components/results-map.tsx`) with OpenStreetMap / CARTO tiles, synchronized with the recommendation list. Valid places lacking coordinates remain in the list and are marked as non-mappable.
   - **Search-process trace drawer**: A collapsible **"How these suggestions were found"** drawer (`src/components/agent-trace-drawer.tsx`) displays the step-by-step discovery trace, cache status (`Live search`, `Cached (24h)`, or `Live + cached`), fallback stages, and candidate screening counts (accepted, held for review, and rejected by reason).

---

## Architecture and Request Flow

```text
Client UI (StarterKitFlow)
  │
  ├─► POST /api/anchors/search ──► handleAnchorSearch()
  │     └─► Qloo /search + resolveEntityFromResults() (type-aware filtering & deduplication)
  │
  └─► POST /api/kit ─────────────► handleKitRequest()
        ├─► 1. Zod request validation (KitRequestSchema) & per-IP rate limiting (10 req / 60s)
        ├─► 2. 24h response cache lookup (collision-safe JSON tuple key)
        ├─► 3. Server-side confirmed-anchor verification (verifyConfirmedAnchors via Qloo /search)
        ├─► 4. Bedrock Agent loop (runAgent, 12s timeout, ≤12 tool calls, ≤25 Qloo outbound calls)
        │     ├─► resolve_anchor  ──► Qloo /search + resolveEntityFromResults()
        │     ├─► discover_places ──► Single-anchor + blended Qloo /v2/insights
        │     │                       + validateEntity() + assignLabel()
        │     │                       + 3-stage fallback chain (alt_tag → drop_tag → broaden)
        │     ├─► find_tags       ──► Qloo /v2/tags
        │     └─► finalize        ──► Trusted-state ID filtering + buildStructuredOutput()
        ├─► 5. Deterministic fallback (runFallback) if Bedrock fails or times out
        │     └─► discover() + validateEntity() + assignLabel() + buildStructuredOutput()
        └─► 6. Output schema verification (StructuredOutputSchema) & allowlisted trace projection
```

### Key Modules

- **`src/lib/qloo/` — Typed Qloo API Client & Entity Resolver**
  - Wraps `https://hackathon.api.qloo.com` endpoints: `/search`, `/v2/insights` (`filter.type=urn:entity:place`, `filter.location.query`, `signal.interests.entities`, `filter.tags`, `feature.explainability=true`), and `/v2/tags` (`filter.query`).
  - Enforces a 10-second per-request timeout, exponential backoff retries (`MAX_RETRIES = 2` on HTTP 429 and 5xx), `AbortSignal` cancellation propagation, a 24-hour in-memory cache, and Zod schema validation (`SearchResponseSchema`, `InsightsResponseSchema`, `TagsResponseSchema`).
- **`src/lib/validate/` — Deterministic Candidate Screening**
  - Evaluates candidate places returned by Qloo `/v2/insights`:
    - **Per-entity screening (`validateEntity`)**: Rejects missing names (`missing_name`), closed venues (`properties.is_closed === true` → `closed`), hotels and accommodations (`hotel_class`, `star_rating`, `check_in_time`, accommodation category tags, or `number_of_rooms` when no place-category tags exist → `hotel_accommodation`), and transit stations and airports (`transit_airport`). In `discover()`, repeated `entity_id` results across single-anchor and blended queries are merged via `candidateMap` before `validateEntity()` runs. *(Note: `src/lib/validate/validator.ts` also exports a standalone batch helper, `validateEntities()`, which adds `duplicate` rejection by `entity_id` or normalized name within 200 meters and is covered by unit tests, but the live `/api/kit` discovery path calls `validateEntity()` per unique `entity_id` inside `discover()` rather than `validateEntities()`.)*
    - **Category-tag evidence scoring (when a category filter is requested)**: When `requestedCategory` (`category_tag_id`) is passed to `validateEntity()`, `scoreCategoryEvidence()` scores `urn:tag:category:place:*` tags (`+2` primary category tag, `+1` second, `0` later, `-1` absent) and checks per-category conflict sets (`CATEGORY_CONFLICTS`, e.g., rejecting hair salons or wine stores tagged secondarily under `record_store` or `book_store` as `category_conflict`, and holding score `<= 0` candidates in `review` as `weak_category_evidence`). Broad unfiltered taste queries do not pass `requestedCategory`, so `categoryEvidence` is `null` and categories are read directly from Qloo's `urn:tag:category:place:*` tags.
    - **Mappability**: Checks coordinate presence and range separately (`mappable` boolean) so valid venues without coordinates are not discarded from the list.
- **`src/lib/discover/` & `src/lib/recommend/` — Provenance Tracking & Deterministic Labeling**
  - `discover()` executes individual **single-anchor** `/v2/insights` queries (up to 5 anchors) alongside a **blended** multi-anchor query, recording every query source and 0-based rank per candidate and ordering accepted places by best source rank and corroborating query count.
  - `assignLabel()` assigns one of three evidence labels in deterministic code (precedence: `connection` > `useful-place` > `exploratory`):
    - **`connection` (*Taste-graph result*)**: Accepted place returned in ranks `0–9` (top 10) of at least one single-anchor Qloo query.
    - **`useful-place` (*Useful place*)**: Accepted place with positive category-tag evidence and practical venue details (`address`, `phone`, or `website` in Qloo's catalog), without single-anchor top-10 provenance.
    - **`exploratory` (*Exploratory*)**: Accepted place surfaced only through a blended multi-anchor query, a fallback stage, or rank `10+` without single-anchor top-10 provenance.
- **`src/lib/bedrock/` & `src/lib/agent/` — Bounded Bedrock Agent & Category Fallback Chain**
  - Uses `@aws-sdk/client-bedrock-runtime` (`ConverseCommand`), defaulting to `us.anthropic.claude-haiku-4-5-20251001-v1:0` when `BEDROCK_MODEL_ID` is not set.
  - Enforces a **trust boundary** (`TrustedState`): the model cannot alter the target city, pass unconfirmed/untrusted anchor IDs to `discover_places`, or include unaccepted entity IDs in `finalize`.
  - When a category-filtered query yields zero accepted places (or uses a known empty tag such as `urn:tag:category:place:coffee`), `executeFallbackChain` runs up to three recovery stages:
    1. `alt_tag`: Queries `/v2/tags` for alternative `urn:tag:category:place:*` tags and retries discovery.
    2. `drop_tag`: Drops the category tag filter and runs an unfiltered query with the same anchors.
    3. `broaden`: Broadens the unfiltered query across all confirmed anchors.
- **`src/lib/output/` — Output Schema Validation, Rule-Based Explanation Checks & Public Trace Projection**
  - `buildStructuredOutput()` builds recommendations from trusted records only, generates deterministic summary text, and validates the response against `StructuredOutputSchema`.
  - `verifyExplanation()` performs deterministic, rule-based pattern checks on explanation text—blocking fabricated percentages (`\d+%`), confidence/probability claims, unsupported single-anchor claims, and opening-hours claims when venue evidence is absent—and falls back to deterministic templates if any check fails (it does not perform independent third-party factual verification).
  - `projectPublicTrace()` produces an allowlisted step-by-step trace for the UI while stripping API keys, internal URLs, raw upstream error payloads, and unverified model text.

---

## Implemented Features

- Two-step guided setup with city selection (`Berlin`, `Toronto`), three persona presets (`Mumbai newcomer`, `Art & indie`, `Food & fashion`), and a `Custom` profile mode.
- Live type-aware Qloo entity search (`POST /api/anchors/search`) with explicit user confirmation and disambiguation for up to 5 cultural anchors.
- Server-side re-verification of confirmed anchors (`verifyConfirmedAnchors`) before agent execution.
- Bedrock Converse tool-calling agent with hard limits (12 tool calls, 25 non-cached Qloo outbound calls, 10 Converse turns, per-operation and request-wide deadlines).
- Automatic graceful degradation to deterministic Qloo discovery (`runFallback`) when Bedrock fails, times out, or is not configured.
- Multi-stage category fallback (`alt_tag` → `drop_tag` → `broaden`).
- Deterministic candidate screening (`validateEntity`) for closed venues, flagged accommodations, transit/airports, and—when a category tag is explicitly requested—category-conflict and category-evidence scoring, plus `entity_id` deduplication across queries in `discover()`. *(A standalone batch helper `validateEntities()` with 200m name-proximity deduplication is also implemented and unit-tested in `src/lib/validate/validator.ts`, though not invoked in the live `/api/kit` path.)*
- Deterministic recommendation labeling (`Taste-graph result`, `Useful place`, `Exploratory`) and rule-based explanation checks with safe template fallback.
- Category filter pills, venue detail cards, interactive Leaflet + OpenStreetMap/CARTO map with synchronized selection, collapsible search-process trace drawer, and light/dark theme toggle.
- Offline unit test suite (399 tests across 135 suites) backed by curated Qloo fixtures (`src/test/fixtures/`), plus opt-in live smoke tests for Qloo and Bedrock.

---

## Prerequisites & Local Installation

### Prerequisites
- **Node.js** 20+ and **npm**
- A **Qloo API key** (`QLOO_API_KEY`) with access to `https://hackathon.api.qloo.com`
- *(Optional for deterministic fallback mode, required for live Bedrock agent mode)* **AWS credentials** (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`) with `bedrock:InvokeModel` permission for your configured `BEDROCK_MODEL_ID`

### Installation Steps

1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```

2. Copy the environment variable template to `.env` (or `.env.local`) and fill in your credentials:
   ```bash
   cp .env.example .env
   ```

3. Start the local development server:
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Commands Reference

All commands below match the scripts defined in `package.json` and `tsconfig.json`:

| Task | Command | Notes |
| --- | --- | --- |
| Install dependencies | `npm install` | Installs packages from `package-lock.json` |
| Start development server | `npm run dev` | Runs `next dev` at `http://localhost:3000` |
| Run unit tests (offline) | `npm test` | Runs `node --import tsx --test src/test/**/*.test.ts` using curated fixtures (no API keys required) |
| Run live smoke tests | `npm run test:smoke` | Runs `SMOKE=1 node --import tsx --test src/test/**/*.smoke.ts` against live Qloo and Bedrock APIs (requires valid env vars) |
| Run ESLint | `npm run lint` | Runs `eslint` across the repository |
| Run TypeScript type check | `npx tsc --noEmit` | Validates TypeScript types without emitting files |
| Build for production | `npm run build` | Runs `next build` |
| Start production server | `npm start` | Runs `next start` after `npm run build` |

---

## Environment Variables

Configure these variables in `.env` or `.env.local` for local development, and in your Vercel project settings for deployment (see `.env.example`):

| Variable | Required | Safe Placeholder / Example | Purpose |
| --- | --- | --- | --- |
| `QLOO_API_KEY` | **Required** (for live lookups & discovery) | `your_qloo_api_key_here` | Server-side API key sent in the `X-Api-Key` header to `https://hackathon.api.qloo.com`. Never exposed to the browser. |
| `AWS_REGION` | **Required for Bedrock agent** | `your_aws_region_here` (e.g. `us-east-1`) | AWS region used by `@aws-sdk/client-bedrock-runtime`. If unset or unreachable, `/api/kit` falls back to deterministic Qloo discovery. |
| `AWS_ACCESS_KEY_ID` | **Required for Bedrock agent** | `your_aws_access_key_here` | AWS IAM access key ID with permission to invoke the configured Bedrock model. |
| `AWS_SECRET_ACCESS_KEY` | **Required for Bedrock agent** | `your_aws_secret_key_here` | AWS IAM secret access key paired with `AWS_ACCESS_KEY_ID`. |
| `BEDROCK_MODEL_ID` | Optional (has default) | `your_bedrock_model_id_here` | Bedrock model or inference profile ID for Converse tool use. Defaults to `us.anthropic.claude-haiku-4-5-20251001-v1:0` in `src/lib/bedrock/client.ts` if omitted. |

> **Security note:** Never commit `.env` or `.env.local` to version control. All Qloo and AWS calls execute strictly in server-side route handlers (`/api/anchors/search`, `/api/kit`, `/api/discover`).

---

## Deploying to Vercel

1. Push the audited repository to GitHub and import the repository in [Vercel](https://vercel.com), or link an existing Vercel project.
2. In the Vercel dashboard under **Project Settings → Environment Variables**, add:
   - `QLOO_API_KEY`
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`
   - `AWS_REGION`
   - `BEDROCK_MODEL_ID`
3. Deploy the `main` branch.
   - `src/app/api/kit/route.ts` exports `export const maxDuration = 30;` to accommodate anchor verification, the 12-second Bedrock agent window, and deterministic fallback within Vercel's serverless execution limits.

---

## Known Limitations & Provenance Honesty

- **Query provenance vs. verified cultural relationship**:  
  When a place carries the **Taste-graph result** (`connection`) badge, it means Qloo's `/v2/insights` endpoint returned that place within the top 10 results when queried with that specific confirmed entity as a taste signal, and the place passed deterministic screening. **It is a statement of search provenance, not proof of a real-world affiliation, ownership, endorsement, or cultural connection** between the artist/show/brand and the venue.
- **Multi-anchor blends**:  
  Places surfaced only in a combined multi-anchor query cannot be attributed to a single interest unless a separate single-anchor query independently returned the place in its top 10. Combined-only results are labeled **Exploratory**.
- **Catalog metadata & operating status**:  
  CultureBridge relies on Qloo's catalog metadata for addresses, neighborhoods, websites, phone numbers, coordinates, and `is_closed` flags. Qloo's catalog does not provide verified live opening hours or real-time operating status for every venue, and missing fields are explicitly displayed as unavailable rather than guessed by the model.
- **Category-conflict screening scope**:  
  Deterministic category-conflict scoring (`scoreCategoryEvidence`) runs only when a category tag is explicitly requested (`category_tag_id`). Broad unfiltered taste queries do not evaluate `scoreCategoryEvidence()` (`categoryEvidence: null`) and instead display categories directly from Qloo's returned `urn:tag:category:place:*` tags without independent third-party verification of every tag in Qloo's catalog.
- **Deduplication scope in `/api/kit`**:  
  The live discovery path (`discover()` in `src/lib/discover/discovery.ts`) deduplicates candidates across single-anchor and blended queries by `entity_id` and screens each unique candidate via `validateEntity()`. The 200-meter normalized-name proximity deduplication (`validateEntities()` in `src/lib/validate/validator.ts`) is an exported, unit-tested batch helper that is not called in the live `/api/kit` request flow.
- **Rule-based explanation checks**:  
  `verifyExplanation()` enforces deterministic pattern rules (blocking percentages, confidence claims, unsupported single-anchor attribution, and opening-hours claims when venue contact/address evidence is absent) and falls back to a deterministic template if violated; it is not a general-purpose fact-checker.
- **Instance-local caching and rate limiting**:  
  Response caching (24-hour TTL) and per-IP sliding-window rate limiters (`10 req/min` on `/api/kit`, `30 req/min` on `/api/anchors/search`) are stored in-memory per server instance rather than in a distributed store.

---

## Acknowledgements & Licence

### External Services & Open-Source Libraries
- **[Qloo Taste AI API](https://www.qloo.com/)** — Cross-domain entity resolution, taste-graph place insights, and category tags.
- **[Amazon Bedrock](https://aws.amazon.com/bedrock/)** (`@aws-sdk/client-bedrock-runtime`) — Converse API tool-use orchestration.
- **[Next.js](https://nextjs.org/) & [React](https://react.dev/)** — Application framework and UI rendering.
- **[Leaflet](https://leafletjs.com/), [OpenStreetMap](https://www.openstreetmap.org/copyright), & [CARTO](https://carto.com/attributions)** — Interactive map rendering and map tiles.
- **[Zod](https://zod.dev/)** — Runtime request, response, and output schema validation.
- **[Tailwind CSS](https://tailwindcss.com/)** — Styling and responsive layout.

### Licence
This project's source code is licensed under the **MIT License** — see [`LICENSE`](./LICENSE) for details. Third-party dependencies and external APIs remain subject to their own respective licenses and terms of service.
