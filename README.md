# outreach-cli

Terminal-driven cold-outreach toolkit: scrape leads from Google Maps, then contact them over WhatsApp (Baileys) or email (Gmail SMTP) with built-in anti-ban safety.

## Workflows

| Command | What it does |
|---|---|
| `/scrape "<query>" <n> [--whatsapp] [--mail]` | Google Maps scraper (vendored engine in `workflows/scraper/engine`). Pulls phones, then looks up emails on each business website without any API key. |
| `/whatsapp` | Sends the proposal to `leads/whatsapp/numbers.yaml` via Baileys, with typing simulation, random delays, batch breaks and a circuit breaker. |
| `/mail` | Sends the proposal to `leads/mail/emails.yaml` via Gmail SMTP. |
| `/status` | Shows lead counts and progress. |

Scraped phone numbers are classified (Pakistan/UAE): mobiles go to `leads/whatsapp/numbers.yaml`, landlines to `leads/landline/numbers.yaml`.

## Setup

```bash
npm install
./setup_scraper.sh          # Python venv + scraper dependencies
cp leads/whatsapp/numbers.example.yaml leads/whatsapp/numbers.yaml
cp leads/mail/emails.example.yaml leads/mail/emails.yaml
# edit config/settings.yaml (SMTP user / app password, rate limits, paths)
node main.js
```

Tunables (delays, daily limits, circuit breaker, paths) live in `config/settings.yaml`.

## Not in the repo (git-ignored)

WhatsApp session (`workflows/whatsapp/auth_info/`), real lead lists, scraper output, reports, error logs, `.env`, `node_modules`, `.venv`, `node_runtime`.

## Notes

`workflows/scraper/engine` is a vendored third-party Google Maps scraper (see its `LICENSE`) with local patches for the current Google Maps response format.
Use responsibly: respect WhatsApp/Gmail terms, local anti-spam laws and opt-outs.
