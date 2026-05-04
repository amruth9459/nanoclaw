#!/bin/zsh
# EV Lease Deal Watch — daily crawler
# Hits Leasehackr Marketplace South + Signed Deals + manufacturer offer pages,
# logs new findings to groups/ev-lease/output/daily-watch-{YYYY-MM-DD}.md
#
# Buyer: Amruth — ZIP 30135, 24/15k preferred, ≥250mi range, current Blazer EV (GMF) ending Aug 2026.
# Schedule via launchd: ~/Library/LaunchAgents/com.nanoclaw.ev-lease-deal-watch.plist

set -eo pipefail

NANOCLAW_DIR="/Users/amrut/nanoclaw"
OUTPUT_DIR="$NANOCLAW_DIR/groups/ev-lease/output"
TODAY=$(date +%Y-%m-%d)
LOG_FILE="$OUTPUT_DIR/daily-watch-$TODAY.md"
RAW_DIR="$OUTPUT_DIR/raw/$TODAY"

mkdir -p "$RAW_DIR"

UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

fetch() {
  local url="$1"
  local out="$2"
  curl -sSL -A "$UA" --max-time 30 "$url" -o "$out" 2>/dev/null || echo "FETCH_FAILED: $url" >&2
}

# Source list — name|url (pipe-separated, one per line)
SOURCES="
leasehackr-pnd|https://pnd.leasehackr.com/
leasehackr-signed|https://signed.leasehackr.com/
lucid-offers|https://lucidmotors.com/offers
polestar-offers|https://www.polestar.com/us/offers/new/
tesla-current|https://www.tesla.com/current-offers
carsdirect-ev|https://www.carsdirect.com/deals-articles/best-green-car-deals
carsdirect-suv-300|https://www.carsdirect.com/deals-articles/best-suv-lease-deals-under-300
edmunds-prologue|https://forums.edmunds.com/discussion/74238/honda/prologue/2026-honda-prologue-lease-deals-incentives-rebates-and-prices
edmunds-lyriq|https://forums.edmunds.com/discussion/72441/cadillac/lyriq/2026-cadillac-lyriq-lease-deals-incentives-rebates-and-prices
edmunds-equinox-ev|https://forums.edmunds.com/discussion/74047/chevrolet/equinox-ev/2026-chevrolet-equinox-ev-lease-deals-incentives-rebates-and-prices
edmunds-i4|https://forums.edmunds.com/discussion/72447/bmw/i4/2026-bmw-i4-lease-deals-incentives-rebates-and-prices
edmunds-id4|https://forums.edmunds.com/discussion/72431/volkswagen/id4/2026-volkswagen-id4-lease-deals-incentives-rebates-and-prices
leasehackr-broker-south|https://forum.leasehackr.com/t/insight-auto-bmw-5-yrs-in-biz-most-trusted-rated-may-26-texas-south-national-specials/199474.json
leasehackr-signed-deals|https://forum.leasehackr.com/c/deals-and-tips/6.json
leasehackr-leads-from-lhers|https://forum.leasehackr.com/t/new-cars-for-sale-leads-from-lhers/439288.json
leasehackr-trophy-garage|https://forum.leasehackr.com/t/trophy-garage-2-photos/287289.json
carscom-zdx-aspec|https://www.cars.com/shopping/results/?make_model_list[]=acura-zdx&trim=A-Spec&stock_type=new&maximum_distance=all&zip=30135&sort=listed_date_high
carscom-prologue-2025|https://www.cars.com/shopping/results/?make_model_list[]=honda-prologue&year_max=2025&year_min=2025&stock_type=new&maximum_distance=all&zip=30135&sort=listed_date_high
carscom-lyriq-sport|https://www.cars.com/shopping/results/?make_model_list[]=cadillac-lyriq&trim=Sport&stock_type=new&maximum_distance=all&zip=30135&sort=listed_date_high
carscom-i4-2025|https://www.cars.com/shopping/results/?make_model_list[]=bmw-i4&year_max=2025&year_min=2025&stock_type=new&maximum_distance=all&zip=30135&sort=listed_date_high
carscom-ix-2025|https://www.cars.com/shopping/results/?make_model_list[]=bmw-ix&year_max=2025&year_min=2025&stock_type=new&maximum_distance=all&zip=30135&sort=listed_date_high
carscom-ex90-loaner|https://www.cars.com/shopping/results/?make_model_list[]=volvo-ex90&stock_type=new&maximum_distance=all&zip=30135&mileage_min=100&mileage_max=5000&sort=price_low
carscom-eqe-2025|https://www.cars.com/shopping/results/?make_model_list[]=mercedes_benz-eqe_class&year_max=2025&year_min=2025&stock_type=new&maximum_distance=all&zip=30135&sort=listed_date_high
carscom-lucid-air-pure|https://www.cars.com/shopping/results/?make_model_list[]=lucid-air&trim=Pure&stock_type=new&maximum_distance=all&zip=30135&sort=listed_date_high
acura-locator-zdx|https://www.acura.com/inventory/zdx?zipCode=30135&radius=500
honda-locator-prologue|https://automobiles.honda.com/tools/inventory-search?model=prologue&zipCode=30135&radius=500
cadillac-locator-lyriq|https://www.cadillac.com/find-my-inventory?model=lyriq&zip=30135
bmw-locator-i4|https://www.bmwusa.com/inventory.html#!/SR/i4/30135
volvo-locator-ex90|https://www.volvocars.com/us/cars/ex90-electric/inventory?zipCode=30135
swapalease-ev-national|https://www.swapalease.com/lease/search.aspx?fuel=electric&maxmopay=400&minmocount=18
leasetrader-ev-national|https://www.leasetrader.com/search-results?fuel=electric&max_payment=400
tesla-used-inventory|https://www.tesla.com/inventory/used/m3?zip=30135&range=300
tesla-used-modely|https://www.tesla.com/inventory/used/my?zip=30135&range=300
carvana-blazer-ev-valuation|https://www.carvana.com/sell-my-car
vroom-blazer-ev-valuation|https://www.vroom.com/sell
polestar-4-inventory|https://www.polestar.com/us/polestar-4/build/
lucid-gravity-inventory|https://lucidmotors.com/gravity
cadillac-vistiq-inventory|https://www.cadillac.com/electric-suvs/vistiq
sonic-automotive-news|https://www.sonicautomotive.com/about/newsroom
autonation-news|https://newsroom.autonation.com/
hertz-car-sales|https://www.hertzcarsales.com/
"

echo "Fetching $(date)..."
echo "$SOURCES" | while IFS='|' read -r name url; do
  [ -z "$name" ] && continue
  fetch "$url" "$RAW_DIR/$name.html"
done

# Build markdown header
cat > "$LOG_FILE" <<EOF
# EV Lease Deal Watch — $TODAY

Raw HTML: \`$RAW_DIR\`

## Buyer parameters
- ZIP 30135, 780 credit, current Blazer EV (GMF) ending Aug 2026
- 24/15k preferred, ≥250mi range, SUV/sedan, Tesla OK, loaner/demo OK
- Multi-state OK if exceptional
- Hyundai out unless exceptional
- Total budget: \$600 baseline / \$1,000 unicorn ceiling

## Snapshot of current programs

EOF

# Extract dollar/percent signals from each fetched file
extract_signals() {
  local file="$1"
  local label="$2"
  if [ -s "$file" ]; then
    local matches
    matches=$(grep -ioE '\$[0-9][0-9,]*/?(mo|month|monthly)?|[0-9]+% off|[0-9]+% residual|MF [.0-9]+' "$file" 2>/dev/null | sort -u | head -25 || true)
    if [ -n "$matches" ]; then
      printf "### %s\n\`\`\`\n%s\n\`\`\`\n\n" "$label" "$matches"
    fi
  fi
}

for key in lucid-offers polestar-offers tesla-current carsdirect-ev carsdirect-suv-300 leasehackr-pnd; do
  extract_signals "$RAW_DIR/$key.html" "$key" >> "$LOG_FILE"
done

# Footer with action guidance
cat >> "$LOG_FILE" <<EOF
---

## Action guidance
- Compare today's signals against \`MEMORY.md\` baselines
- If new lease cash > \$1k OR residual jumped 3+ pts OR % off MSRP > 15% → flag in \`output/alerts.md\`
- For nuanced reads (signed-deal post-mortems, broker-thread latest posts) hand to container agent — pass raw HTML in \`$RAW_DIR\` directly

_Generated by \`scripts/ev-lease-deal-watch.sh\` at $(date)_
EOF

echo "Done. Log: $LOG_FILE"
