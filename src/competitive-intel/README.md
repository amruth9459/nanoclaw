# Competitive Intelligence Monitoring

Automated quarterly competitive intelligence check-ins for tracking competitor movements into the B2G (business-to-government) space.

## Architecture

```
src/competitive-intel/
├── types.ts           # Type definitions (signals, checks, reports)
├── persistence.ts     # SQLite schema + CRUD for audit trail
├── avoice-monitor.ts  # Core monitoring logic (detection, reports, alerts)
├── ipc-handler.ts     # IPC interface for container agents
├── index.ts           # Public API
├── README.md          # This file
└── __tests__/
    └── avoice-monitor.test.ts
```

### Data Flow

1. Container agent runs web searches for configured queries
2. Agent sends search results via IPC (`competitive_intel_check` type)
3. Host-side handler detects signals by matching trigger keywords
4. Signals are classified by severity (CRITICAL/HIGH/MEDIUM/LOW)
5. Report is generated comparing current state to baseline
6. If CRITICAL or HIGH signals found, WhatsApp alert is sent
7. All checks are logged to `competitive_intel_checks` table for audit

## Schedule Configuration

Quarterly reviews are configured via the scheduled task system. Create a task with:

```
schedule_type: cron
schedule_value: 0 9 27 3,6,9,12 *   # 9 AM on 27th of Mar/Jun/Sep/Dec
```

The task prompt should instruct the agent to:
1. Run web searches for the configured queries (`AVOICE_CONFIG.search_queries`)
2. Send results via `competitive_intel_check` IPC with `action: 'check'`
3. Forward any alert message to the main WhatsApp group

## IPC Actions

### `check` — Run a competitive intelligence check
```json
{
  "type": "competitive_intel_check",
  "action": "check",
  "check_type": "quarterly",
  "search_results": [
    {
      "query": "Avoice government",
      "snippets": [
        { "source": "techcrunch.com", "text": "..." }
      ]
    }
  ]
}
```

Returns: `{ status, check_id, signal_count, max_severity, alert_sent, alert_message, report_summary, recommended_actions }`

### `status` — Get current monitoring status
```json
{
  "type": "competitive_intel_check",
  "action": "status"
}
```

Returns: `{ competitor, next_review, is_review_due, baseline_status, last_check, stats }`

### `history` — Get past check results
```json
{
  "type": "competitive_intel_check",
  "action": "history",
  "limit": 10
}
```

### `config` — Get current monitoring configuration
```json
{
  "type": "competitive_intel_check",
  "action": "config"
}
```

## Manual Override

To run a check outside the quarterly schedule, use the `manual` check type:

```json
{
  "type": "competitive_intel_check",
  "action": "check",
  "check_type": "manual",
  "search_results": [...]
}
```

Or trigger from WhatsApp by asking the agent:
> @Andy Run a competitive intel check on Avoice

## Severity Classification

| Level | Trigger | Action |
|-------|---------|--------|
| CRITICAL | Plan review product launch, ICC partnership | Immediate escalation, accelerate partnerships |
| HIGH | Government customer pilot, B2G positioning | Escalate within 48 hours |
| MEDIUM | Compliance expansion, funding rounds | Note for quarterly review |
| LOW | General industry mentions | Continue monitoring |

## Database

Table: `competitive_intel_checks`

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| competitor | TEXT | Company name |
| check_type | TEXT | quarterly/manual/triggered |
| signals_found | TEXT | JSON array of signals |
| signal_count | INTEGER | Number of signals detected |
| max_severity | TEXT | Highest severity level |
| report | TEXT | Full formatted report |
| alert_sent | INTEGER | Whether WhatsApp alert was sent |
| checked_at | TEXT | ISO timestamp |
