# Tech News Aggregator

A Next.js application that aggregates tech news from multiple sources (Hacker News, Reddit, Lobsters, dev.to) and generates AI-powered summaries using Claude.

## Features

- **Multi-source aggregation**: Scrapes news from Hacker News, Reddit (11 subreddits), Lobsters, and dev.to
- **AI-powered summaries**: Uses Claude to deduplicate, categorize, and generate summaries with sentiment analysis
- **Category filtering**: AI/ML, Development, Infrastructure, Career, and Other categories
- **7-day archive**: Browse news from the past week with day navigation
- **Hotness scoring**: Stories ranked by engagement (upvotes + comments) across sources
- **Dark/light mode**: Automatically follows system theme preference
- **Static site generation**: Deploys to GitHub Pages with no server required

## Tech Stack

- **Runtime**: [Bun](https://bun.sh)
- **Framework**: Next.js 15 (App Router, static export)
- **Language**: TypeScript
- **Styling**: TailwindCSS + shadcn/ui components
- **AI**: Claude via [@anthropic-ai/sdk](https://www.npmjs.com/package/@anthropic-ai/sdk)

## Prerequisites

- [Bun](https://bun.sh) (latest version)
- Anthropic API key for Claude access

## Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd tech-news-aggregator
   ```

2. Install dependencies:
   ```bash
   bun install
   ```

3. Create environment variables:
   ```bash
   # Create .env.local file
   echo "ANTHROPIC_API_KEY=your-api-key-here" > .env.local
   ```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key for Claude access |

## Usage

### Running the Pipeline

Generate a daily digest by running the pipeline script:

```bash
bun run pipeline
```

This will:
1. Scrape all sources (Hacker News, Reddit, Lobsters, dev.to)
2. Process with Claude (deduplicate and categorize)
3. Generate summaries and sentiment analysis
4. Output a JSON file to `data/YYYY-MM-DD.json`

To generate a digest for a specific date:

```bash
bun run scripts/run-pipeline.ts --date 2026-01-15
```

**Exit codes:**
- `0` - Success
- `1` - Partial failure (some sources failed, but digest was generated)
- `2` - Critical failure (no data collected or processing failed)

### Development Server

Start the development server with Turbopack:

```bash
bun run dev
```

The site will be available at [http://localhost:3000](http://localhost:3000).

### Building for Production

Build the static site:

```bash
bun run build
```

The output will be in the `out/` directory, ready for deployment.

### Preview Production Build

```bash
bun run start
```

## Development Commands

| Command | Description |
|---------|-------------|
| `bun run dev` | Start development server with Turbopack |
| `bun run build` | Build static site for production |
| `bun run start` | Start production server |
| `bun run lint` | Run ESLint |
| `bun run typecheck` | Run TypeScript type checking |
| `bun run pipeline` | Run the news aggregation pipeline |

## Project Structure

```
tech-news-aggregator/
├── data/                    # Generated daily digest JSON files
│   └── YYYY-MM-DD.json      # Daily digest data
├── scripts/
│   └── run-pipeline.ts      # Main pipeline orchestration script
├── src/
│   ├── app/                 # Next.js App Router pages
│   │   ├── layout.tsx       # Root layout with theme detection
│   │   ├── page.tsx         # Home page (today's digest)
│   │   └── [date]/          # Dynamic date routes
│   │       └── page.tsx     # Date-specific digest page
│   ├── components/
│   │   ├── ui/              # shadcn/ui base components
│   │   └── news/            # News-specific components
│   │       ├── news-card.tsx        # News item card (collapsed/expanded)
│   │       ├── category-filter.tsx  # Category filter chips
│   │       └── day-navigation.tsx   # 7-day navigation
│   ├── lib/
│   │   ├── claude/          # Claude AI integration
│   │   │   └── processor.ts # Deduplication, categorization, summaries
│   │   ├── digest/          # Digest generation
│   │   ├── scrapers/        # Source scrapers
│   │   │   ├── hackernews.ts
│   │   │   ├── reddit.ts
│   │   │   ├── lobsters.ts
│   │   │   ├── devto.ts
│   │   │   └── orchestrator.ts
│   │   ├── data.ts          # Data loading utilities
│   │   ├── hotness.ts       # Hotness score calculation
│   │   └── utils.ts         # General utilities
│   └── types/
│       └── news.ts          # TypeScript type definitions
├── .github/
│   └── workflows/
│       └── deploy.yml       # GitHub Pages deployment workflow
├── next.config.js           # Next.js configuration (static export)
├── tailwind.config.ts       # TailwindCSS configuration
└── tsconfig.json            # TypeScript configuration
```

## Data Schema

Daily digest JSON files follow this structure:

```typescript
interface DailyDigest {
  date: string;           // YYYY-MM-DD
  generated_at: string;   // ISO timestamp
  item_count: number;     // Number of items
  items: NewsItem[];      // News items sorted by hotness
}

interface NewsItem {
  id: string;
  slug: string;
  title: string;
  url: string;
  category: 'ai-ml' | 'development' | 'infrastructure' | 'career' | 'other';
  sources: Source[];
  hotness_score: number;
  summary: string;
  analysis: {
    extended_summary: string;
    sentiment: string;
  };
}

interface Source {
  name: 'hackernews' | 'reddit' | 'lobsters' | 'devto';
  url: string;
  points?: number;
  upvotes?: number;
  comments: number;
  subreddit?: string;  // Only for Reddit sources
}
```

## Deployment

### GitHub Pages (Automated)

The project includes a GitHub Actions workflow that automatically deploys to GitHub Pages when changes are pushed to the `data/` directory.

The workflow:
1. Triggers on push to `data/**` on main/master branch
2. Installs dependencies with Bun
3. Runs lint and type check
4. Builds the static site
5. Deploys to GitHub Pages

### Manual Deployment

For other hosting providers:

1. Build the static site:
   ```bash
   bun run build
   ```

2. Deploy the `out/` directory to your hosting provider.

## News Sources

| Source | Description | Criteria |
|--------|-------------|----------|
| Hacker News | Top stories | Top 25 by points (excludes Show/Ask/Jobs) |
| Reddit | Tech subreddits | Top 25 per subreddit with 100+ upvotes |
| Lobsters | Tech news | Top 25 by score |
| dev.to | Developer articles | Top 25 by reactions |

**Reddit subreddits monitored:**
- r/programming, r/webdev, r/machinelearning, r/netsec, r/devops
- r/singularity, r/coding, r/artificial, r/startups
- r/cscareerquestions, r/experienceddevs

## Hotness Algorithm

Stories are ranked using the formula:
```
hotness_score = (upvotes * 0.5) + (comments * 0.5)
```

Scores are normalized across sources to ensure fair comparison.

## License

MIT
