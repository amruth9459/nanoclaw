---
name: batch
description: Process multiple files, tasks, or operations in parallel or sequence — batch process documents, run operations on multiple files, parallelize independent tasks, and orchestrate complex multi-step workflows. Use for bulk operations and data processing.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task
---

# Batch Processing Skill

This skill helps process multiple items efficiently through parallelization, batching, and workflow orchestration.

## When to Use This Skill

Activate this skill when:
- Processing multiple files or documents
- Running the same operation on many items
- Orchestrating multi-step workflows
- Parallelizing independent tasks
- Bulk data transformations
- Mass file operations (rename, convert, validate)
- Running tests on multiple files
- Generating reports for multiple entities

## Batch Processing Strategies

### 1. Parallel Processing
Process independent items simultaneously for speed:
```bash
# Process multiple PDFs in parallel
for file in *.pdf; do
  ocr "$file" > "${file%.pdf}.txt" &
done
wait  # Wait for all background jobs to complete
```

### 2. Sequential Processing
Process items one at a time when order matters or resources are limited:
```bash
# Process files sequentially
for file in *.pdf; do
  echo "Processing $file..."
  ocr "$file" > "${file%.pdf}.txt"
done
```

### 3. Chunked Processing
Break large batches into smaller chunks:
```bash
# Process in chunks of 10
files=(*.pdf)
for ((i=0; i<${#files[@]}; i+=10)); do
  chunk=("${files[@]:i:10}")
  echo "Processing chunk $((i/10 + 1))..."
  for file in "${chunk[@]}"; do
    ocr "$file" > "${file%.pdf}.txt" &
  done
  wait
done
```

## Common Batch Operations

### Bulk File Conversion
```bash
# Convert all PNGs to JPG
for png in *.png; do
  convert "$png" "${png%.png}.jpg"
done

# Convert all markdown to HTML
for md in *.md; do
  pandoc "$md" -o "${md%.md}.html"
done
```

### Bulk Validation
```bash
# Validate all JSON files
for json in *.json; do
  if jq empty "$json" 2>/dev/null; then
    echo "✓ $json: valid"
  else
    echo "✗ $json: invalid"
  fi
done
```

### Bulk Testing
```bash
# Run tests on all TypeScript files
for ts in src/**/*.test.ts; do
  echo "Testing $ts..."
  npx vitest run "$ts"
done
```

### Bulk Rename
```bash
# Rename files with pattern
for file in IMG_*.jpg; do
  newname="${file/IMG_/photo-}"
  mv "$file" "$newname"
done
```

## Multi-Step Workflows

### Document Processing Pipeline
```bash
#!/bin/bash
# 1. Find all PDFs
pdfs=($(find . -name "*.pdf"))

# 2. Extract text
for pdf in "${pdfs[@]}"; do
  pdftotext "$pdf" "${pdf%.pdf}.txt" &
done
wait

# 3. Analyze text
for txt in *.txt; do
  word_count=$(wc -w < "$txt")
  echo "$txt: $word_count words"
done

# 4. Generate summary report
{
  echo "# Document Processing Report"
  echo "Total documents: ${#pdfs[@]}"
  echo ""
  echo "## Files Processed"
  for pdf in "${pdfs[@]}"; do
    echo "- $pdf"
  done
} > report.md
```

### Code Quality Batch Audit
```bash
#!/bin/bash
# Run multiple checks on all TypeScript files

files=(src/**/*.ts)

echo "Running ESLint..."
npx eslint "${files[@]}" > eslint-report.txt

echo "Running TypeScript compiler..."
npx tsc --noEmit > tsc-report.txt

echo "Running Prettier check..."
npx prettier --check "${files[@]}" > prettier-report.txt

echo "Running tests..."
npx vitest run > test-report.txt

# Combine reports
{
  echo "# Code Quality Report"
  echo ""
  echo "## ESLint"
  cat eslint-report.txt
  echo ""
  echo "## TypeScript"
  cat tsc-report.txt
  echo ""
  echo "## Prettier"
  cat prettier-report.txt
  echo ""
  echo "## Tests"
  cat test-report.txt
} > quality-report.md
```

## Parallelization Patterns

### Using Task Tool for Agent Parallelization
```typescript
// Process multiple independent tasks in parallel
Task({
  subagent_type: "general-purpose",
  description: "Process document A",
  prompt: "Extract data from document-a.pdf",
});

Task({
  subagent_type: "general-purpose",
  description: "Process document B",
  prompt: "Extract data from document-b.pdf",
});

Task({
  subagent_type: "general-purpose",
  description: "Process document C",
  prompt: "Extract data from document-c.pdf",
});
```

### Using xargs for Parallel Execution
```bash
# Process up to 4 files in parallel
find . -name "*.pdf" | xargs -P 4 -I {} ocr {}
```

### Using GNU Parallel
```bash
# Process all PDFs with 8 parallel jobs
parallel -j 8 ocr ::: *.pdf
```

## Error Handling in Batch Processing

### Continue on Error
```bash
# Keep processing even if some items fail
for file in *.json; do
  if ! validate "$file"; then
    echo "Failed: $file" >> errors.log
  fi
done
```

### Stop on First Error
```bash
# Stop immediately if any item fails
set -e  # Exit on error
for file in *.json; do
  validate "$file"
done
```

### Retry Failed Items
```bash
# Track failed items and retry
failed=()
for file in *.pdf; do
  if ! process "$file"; then
    failed+=("$file")
  fi
done

# Retry failed items
echo "Retrying ${#failed[@]} failed items..."
for file in "${failed[@]}"; do
  process "$file" || echo "Still failed: $file"
done
```

## Progress Tracking

### Simple Progress Counter
```bash
total=${#files[@]}
current=0

for file in "${files[@]}"; do
  ((current++))
  echo "[$current/$total] Processing $file..."
  process "$file"
done
```

### Progress with ETA
```bash
start_time=$(date +%s)
total=${#files[@]}
current=0

for file in "${files[@]}"; do
  ((current++))

  # Calculate ETA
  elapsed=$(($(date +%s) - start_time))
  if [ $current -gt 0 ]; then
    avg_time=$((elapsed / current))
    remaining=$((total - current))
    eta=$((avg_time * remaining))
    echo "[$current/$total] $file (ETA: ${eta}s)"
  fi

  process "$file"
done
```

## Batching Best Practices

### 1. Determine Optimal Batch Size
- **Small batches (1-10 items)**: Quick feedback, easier debugging
- **Medium batches (10-100 items)**: Balance speed and control
- **Large batches (100+ items)**: Maximum throughput, harder to debug

### 2. Resource Considerations
```bash
# Limit parallel jobs based on CPU cores
num_cores=$(nproc)
max_parallel=$((num_cores - 1))  # Leave one core free

# Process with resource limit
parallel -j "$max_parallel" process ::: *.pdf
```

### 3. Logging and Monitoring
```bash
# Log all operations
exec > >(tee batch-process.log)
exec 2>&1

echo "Started: $(date)"
for file in *.pdf; do
  echo "Processing: $file"
  process "$file"
done
echo "Completed: $(date)"
```

### 4. Resumable Batch Processing
```bash
# Create checkpoint file
processed_file=".processed.txt"
touch "$processed_file"

for file in *.pdf; do
  # Skip if already processed
  if grep -q "^$file$" "$processed_file"; then
    echo "Skipping $file (already processed)"
    continue
  fi

  # Process and checkpoint
  if process "$file"; then
    echo "$file" >> "$processed_file"
  fi
done
```

## Example: Batch Document Analysis

### Extract Data from Multiple PDFs
```bash
#!/bin/bash

# Find all PDFs
pdfs=($(find /workspace/media -name "*.pdf"))
echo "Found ${#pdfs[@]} PDFs to process"

# Process in parallel (4 at a time)
counter=0
for pdf in "${pdfs[@]}"; do
  ((counter++))
  basename=$(basename "$pdf" .pdf)

  # Extract text
  echo "[$counter/${#pdfs[@]}] Extracting text from $basename..."
  ocr "$pdf" > "/tmp/${basename}.txt" &

  # Limit to 4 parallel processes
  if (( counter % 4 == 0 )); then
    wait
  fi
done
wait

# Analyze extracted text
for txt in /tmp/*.txt; do
  word_count=$(wc -w < "$txt")
  line_count=$(wc -l < "$txt")
  echo "$(basename "$txt"): $word_count words, $line_count lines"
done
```

## Example: Bulk Code Refactoring

### Rename Function Across Multiple Files
```bash
#!/bin/bash

# Find all TypeScript files
files=($(find src -name "*.ts"))

old_name="getUserData"
new_name="fetchUserData"

echo "Replacing '$old_name' with '$new_name' in ${#files[@]} files..."

for file in "${files[@]}"; do
  if grep -q "$old_name" "$file"; then
    sed -i "s/$old_name/$new_name/g" "$file"
    echo "Updated: $file"
  fi
done

echo "Refactoring complete!"
```

## Output Format

When completing batch operations, provide:
1. **Summary**: Total items processed, successes, failures
2. **Results**: Key outcomes or findings
3. **Errors**: List of failed items (if any)
4. **Logs**: Location of detailed logs
5. **Next Steps**: Recommendations or follow-up actions

### Example Output
```
# Batch Processing Complete

## Summary
- Total files: 45
- Successful: 43
- Failed: 2
- Duration: 2m 34s

## Failed Items
- document-17.pdf (OCR timeout)
- scan-029.pdf (corrupted file)

## Results
Results saved to: /workspace/group/batch-results/
Logs: batch-process.log

## Next Steps
1. Review failed items manually
2. Re-run with higher timeout for large files
```

## Notes

- **Test on small batch first**: Verify logic before full run
- **Monitor resources**: CPU, memory, disk I/O
- **Use checkpointing**: Enable resuming for long batches
- **Log everything**: Debug failures easily
- **Validate output**: Check results after completion
- **Clean up**: Remove temp files and intermediate data
