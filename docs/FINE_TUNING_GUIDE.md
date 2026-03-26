# Fine-Tuning Specialized Models for Construction Document Extraction

> Written: March 2026 | Context: Lexios construction document extraction platform
> Anti-hallucination notice: All costs, capabilities, and data requirements reflect verified March 2026 reality. Speculative claims are explicitly labeled.

## Executive Summary

### What Fine-Tuning Actually Achieves (vs. Prompt Engineering)

Fine-tuning adapts model weights to your specific task, while prompt engineering guides an unchanged model with instructions. The practical differences:

| Dimension | Prompt Engineering | Fine-Tuning |
|---|---|---|
| **Setup cost** | Hours | Weeks + labeled data |
| **Per-request cost** | Higher (longer prompts) | Lower (shorter prompts, smaller model) |
| **Accuracy ceiling** | Limited by model's pre-training | Can exceed base model on narrow tasks |
| **Maintenance** | Edit prompts | Retrain on new data |
| **Latency** | Higher (more tokens) | Lower (distilled behavior) |

Fine-tuning shines when you have a **narrow, well-defined task** with **consistent input/output formats** and enough labeled data to teach the pattern. It does NOT help when tasks are open-ended, data is sparse, or the base model already handles the task well with good prompts.

### Realistic ROI Analysis for 2026

For a construction document extraction system like Lexios:

- **Current approach** (Claude + prompt engineering): ~$1.80 per complex document, F1 ~0.23 overall
- **Fine-tuned open-source model** (after 6+ months investment): Potentially $0.05-0.20 per document, F1 improvement depends entirely on data quality
- **Break-even**: ~10,000-50,000 extractions depending on accuracy improvement achieved

**Honest assessment**: With Lexios's current corpus of 86 documents and 91 ground truths, fine-tuning a general LLM is premature. The data foundation isn't there yet. The priority should be growing the labeled dataset while continuing to improve prompt-based extraction.

### When to Fine-Tune vs. When Not To

**Fine-tune when:**
- You have 500+ high-quality labeled examples for your specific task
- The task is repetitive and well-defined (e.g., "extract all door schedules from this table format")
- Per-extraction cost matters (high volume)
- You need lower latency than API calls provide

**Don't fine-tune when:**
- You have fewer than 200 labeled examples (you'll overfit)
- The task requires broad reasoning (e.g., "understand this construction drawing")
- Document formats vary wildly with no dominant pattern
- A good prompt already achieves >90% of your target accuracy

---

## Prerequisites & Reality Check

### Data Requirements (Actual Numbers)

These numbers come from published benchmarks and practitioner reports, not theoretical minimums.

#### Text Extraction (e.g., pulling entities from spec sheets)
- **Minimum viable**: 200-500 labeled input/output pairs
- **Recommended**: 1,000-2,000 pairs for production quality
- **Diminishing returns**: Beyond 5,000 pairs, gains are marginal unless distribution shifts

Source: [Particula, "How Much Data Do You Need to Fine-Tune an LLM in 2026"](https://particula.tech/blog/how-much-data-fine-tune-llm) — LoRA fine-tuning on 280 examples achieved 94% accuracy for invoice classification. But construction documents are more complex than invoices.

#### Table Extraction (e.g., door/window schedules)
- **Minimum viable**: 300-800 labeled table examples (input image/text + structured output)
- **Recommended**: 1,500-3,000 for diverse table formats
- **Critical factor**: Table format diversity matters more than raw count. 500 examples of 50 different table layouts beats 2,000 examples of 5 layouts.

#### Document Classification (e.g., "is this a floor plan, elevation, or schedule?")
- **Minimum viable**: 50-100 examples per class (with LoRA)
- **Recommended**: 200-500 per class
- **Note**: Classification is the easiest fine-tuning task. Start here.

#### Vision-Language Tasks (e.g., extracting from drawings)
- **Minimum viable**: 500-1,000 image-text pairs
- **Recommended**: 2,000-5,000 pairs
- **Critical caveat**: Construction drawings (vector PDFs, CAD exports) are fundamentally different from the scanned documents these models were pre-trained on. Expect to need the upper end of these ranges.

### What "Good" Labeled Data Means

Bad labels produce bad models. Period.

**Requirements for quality labeled data:**
1. **Consistent schema**: Every example follows the exact same output format
2. **Complete extraction**: No missing fields — if a door exists, it's labeled
3. **Verified by domain expert**: A construction professional reviewed each label
4. **Edge cases included**: Partially visible tables, rotated text, multi-page spans
5. **Inter-annotator agreement**: At least 2 people label a subset; agreement >85% (Cohen's kappa >0.7)

**Cost to label (realistic estimates):**
- Simple classification: 1-2 minutes per example → ~$1-2/example with contract annotators
- Entity extraction: 5-15 minutes per example → ~$5-10/example
- Complex table extraction: 15-30 minutes per example → ~$10-20/example
- Construction domain expert review: $50-100/hour, reviewing 10-20 examples/hour

**Total labeling cost for a viable dataset (1,000 extraction examples):**
- Annotation: $5,000-$20,000
- Expert review: $2,500-$5,000
- Tool licenses (Label Studio is free, but Prodigy costs ~$490): ~$500
- **Total: $8,000-$25,500**

### Compute Requirements (Real 2026 Costs)

All prices verified as of March 2026.

#### Training Time and Cost

| Model Size | Method | GPU | Time (1K examples) | Cloud Cost |
|---|---|---|---|---|
| 7-8B (Mistral, LLaMA 3) | QLoRA | 1x RTX 4090 (24GB) | 2-4 hours | $1-3 |
| 7-8B | LoRA | 1x A100 40GB | 1-3 hours | $3-10 |
| 13B | QLoRA | 1x RTX 4090 (24GB) | 4-8 hours | $3-6 |
| 70B | QLoRA | 1x A100 80GB | 12-24 hours | $36-72 |
| 70B | LoRA | 2x A100 80GB | 8-16 hours | $48-96 |

Sources:
- [RunPod LoRA/QLoRA Guide](https://www.runpod.io/articles/guides/how-to-fine-tune-large-language-models-on-a-budget) — RTX 4090 at $0.40-0.80/hr
- [Spheron GPU Pricing Comparison 2026](https://www.spheron.network/blog/gpu-cloud-pricing-comparison-2026/)
- [Jarvislabs A100 Pricing](https://docs.jarvislabs.ai/blog/a100-price) — A100 80GB at $1.49-3.43/hr

#### Cloud GPU Rates (March 2026, On-Demand)

| GPU | AWS | GCP | Neo-Clouds (RunPod, Lambda, Jarvislabs) |
|---|---|---|---|
| A100 40GB | ~$3.40/hr | ~$3.28/hr | $1.49-2.00/hr |
| A100 80GB | ~$3.43/hr | ~$3.40/hr | $1.49-2.49/hr |
| H100 80GB | ~$3.90/hr | ~$3.00/hr | $1.49-2.69/hr |
| RTX 4090 24GB | N/A | N/A | $0.40-0.80/hr |

Source: [IntuitionLabs H100 Pricing Comparison](https://intuitionlabs.ai/articles/h100-rental-prices-cloud-comparison), [AWS EC2 Pricing](https://aws.amazon.com/ec2/pricing/on-demand/)

#### Total Budget Needed

**Minimum viable fine-tuning project:**
- Labeling: $8,000-$25,500 (1,000 examples)
- Compute (training): $50-200 (multiple training runs)
- Compute (evaluation): $20-50
- Engineering time: 2-4 weeks of ML engineer → $5,000-$20,000
- **Total: $13,000-$46,000**

**This is the real cost. Anyone quoting $500 for a "fine-tuning project" is either using a trivially small dataset or ignoring labeling and engineering costs.**

### Technology Landscape (March 2026)

#### What Models CAN Be Fine-Tuned Today

**API-based fine-tuning (managed):**
| Provider | Models Available | Status |
|---|---|---|
| OpenAI | GPT-4o, GPT-4o-mini, GPT-4.1 (being deprecated in favor of GPT-5.x) | GA, production-ready |
| Anthropic (via Bedrock) | Claude 3 Haiku only | GA, limited to Bedrock |
| Anthropic (native API) | None | Not available as of March 2026 |
| Google | Gemini 1.5 Flash, Gemini 1.5 Pro (via Vertex AI) | GA |

Sources: [OpenAI Pricing](https://platform.openai.com/docs/pricing), [AWS Bedrock Claude Fine-Tuning](https://aws.amazon.com/blogs/aws/fine-tuning-for-anthropics-claude-3-haiku-model-in-amazon-bedrock-is-now-generally-available/)

**Open-source (self-hosted):**
| Model | Sizes | License | Fine-Tuning Ecosystem |
|---|---|---|---|
| LLaMA 3.x | 8B, 70B, 405B | Llama Community License | Excellent (Axolotl, TRL, Unsloth) |
| LLaMA 3.2-Vision | 11B, 90B | Llama Community License | Good (multimodal fine-tuning supported) |
| Mistral / Mistral Small 3 | 7B, 24B | Apache 2.0 | Excellent |
| Mistral Pixtral | 12B | Apache 2.0 | Good (vision-language) |
| Qwen 2.5 | 0.5B-72B | Apache 2.0 | Excellent (LLaMA-Factory, Axolotl) |
| Qwen 2.5-VL | 7B, 72B | Apache 2.0 | Good (vision-language) |

Sources: [HuggingFace Open-Source LLM Blog](https://huggingface.co/blog/daya-shankar/open-source-llms), [Elephas Best Open Source Models 2026](https://elephas.app/blog/best-open-source-ai-models)

**Document-specific models:**
| Model | Task | Status |
|---|---|---|
| LayoutLMv3 | Document layout + entity extraction | Mature, well-documented fine-tuning |
| Donut | OCR-free document understanding | Stable, good for structured docs |
| Pix2Struct | Screenshot/document parsing | Works but hyperparameter-sensitive |

Sources: [LayoutLMv3 on HuggingFace](https://huggingface.co/microsoft/layoutlmv3-base), [HuggingFace Donut Docs](https://huggingface.co/docs/transformers/en/model_doc/donut)

#### Production-Ready vs. Research-Only

**Production-ready (March 2026):**
- OpenAI GPT-4o/4o-mini fine-tuning
- LoRA/QLoRA on LLaMA 3, Mistral, Qwen (with vLLM serving)
- LayoutLMv3 fine-tuning for document entity extraction
- Donut fine-tuning for structured document parsing

**Usable but requires ML expertise:**
- Vision-language model fine-tuning (LLaMA 3.2-Vision, Qwen 2.5-VL)
- Multi-task fine-tuning pipelines
- Reinforcement fine-tuning (OpenAI RLHF)

**Research-only / not ready:**
- Fine-tuning Claude models beyond Haiku (not available)
- End-to-end construction drawing understanding (no pre-trained model exists)
- Automated annotation for construction documents (still manual)

---

## Step 1: Build a Labeled Dataset

### For Lexios Construction Extraction

#### Input-Output Pair Structure

Each training example needs:
1. **Input**: The document content (text, image, or both)
2. **Output**: The structured extraction you want

```json
{
  "id": "holabird-page-7",
  "source_file": "holabird-sports-center.pdf",
  "page": 7,
  "input_type": "pdf_page_image",
  "input_text": "[OCR text of the page, if using text-based model]",
  "input_image_path": "dataset/images/holabird-page-7.png",
  "task": "table_extraction",
  "output": {
    "page_type": "door_schedule",
    "zone": "Level 1 - East Wing",
    "elements": [
      {
        "category": "doors",
        "tag": "D101",
        "type": "Single Flush",
        "width": "3'-0\"",
        "height": "7'-0\"",
        "material": "Hollow Metal",
        "fire_rating": "90 min",
        "hardware_set": "HS-1"
      },
      {
        "category": "doors",
        "tag": "D102",
        "type": "Double Flush",
        "width": "6'-0\"",
        "height": "7'-0\"",
        "material": "Wood",
        "fire_rating": "None",
        "hardware_set": "HS-3"
      }
    ],
    "metadata": {
      "total_elements": 2,
      "sheet_number": "A5.1",
      "revision": "Rev 2"
    }
  }
}
```

#### Annotation Tools That Work

1. **Label Studio** (free, open-source): Best for text + bounding box annotation. Supports custom labeling interfaces. Export to JSON. Self-hosted. URL: https://labelstud.io/
2. **Prodigy** (~$490 one-time): Built by the spaCy team. Fast annotation with active learning. Good for iterative labeling.
3. **CVAT** (free, open-source): Best for image/vision annotation with bounding boxes and polygons. Good for construction drawing annotation.

For Lexios specifically, Label Studio with a custom annotation interface for construction elements is recommended. You can define a labeling config that matches your extraction schema.

#### Quality Assurance Process

1. **Schema validation**: Every output must pass a JSON schema check before entering the dataset
2. **Dual annotation**: At least 20% of examples labeled by 2 annotators independently
3. **Expert review**: A construction professional reviews all labels
4. **Automated checks**:
   - No empty extractions (if a page has content, extraction shouldn't be empty)
   - Tag format validation (D101, W203, etc.)
   - Dimensional value format checks (X'-Y" format)
5. **Version control**: Dataset versioned in git (or DVC for large files)

#### Inter-Annotator Agreement Targets

| Task | Minimum Kappa | Target Kappa |
|---|---|---|
| Document classification | 0.80 | 0.90+ |
| Entity extraction (text) | 0.70 | 0.85+ |
| Table structure recognition | 0.65 | 0.80+ |
| Drawing element identification | 0.60 | 0.75+ |

If agreement is below 0.60, your annotation guidelines are ambiguous — fix them before collecting more data.

---

## Step 2: Choose Your Fine-Tuning Approach

### Option A: API-Based Fine-Tuning

#### OpenAI GPT-4o / GPT-4o-mini Fine-Tuning

**Status (March 2026):** Generally available. GPT-4o is being deprecated in favor of GPT-5.x, but fine-tuning APIs remain functional.

**Costs:**
- Training: $25/M tokens (GPT-4o), $3/M tokens (GPT-4o-mini)
- Inference: $3.75/$15 per M tokens input/output (fine-tuned GPT-4o)
- 1,000 training examples × ~2K tokens each × 4 epochs = ~8M tokens → **$200 (GPT-4o) or $24 (GPT-4o-mini)**

Source: [OpenAI Pricing](https://platform.openai.com/docs/pricing), [FinetuneDB Cost Calculator](https://finetunedb.com/blog/how-much-does-it-cost-to-finetune-gpt-4o/)

**Pros:**
- Simplest setup (upload JSONL, click train)
- No GPU management
- High baseline capability

**Cons:**
- No vision fine-tuning for GPT-4o (text only as of March 2026)
- Data leaves your infrastructure (privacy concern for client documents)
- Vendor lock-in
- Ongoing per-token costs that scale with volume

**Best for:** Text-based extraction tasks where privacy isn't a constraint and volume is moderate (<100K extractions/month).

#### Anthropic Claude Fine-Tuning

**Status (March 2026):** Only Claude 3 Haiku available for fine-tuning, only through Amazon Bedrock. No native API fine-tuning. No fine-tuning for Claude 4.x or newer models.

Source: [AWS Blog — Claude 3 Haiku Fine-Tuning GA](https://aws.amazon.com/blogs/aws/fine-tuning-for-anthropics-claude-3-haiku-model-in-amazon-bedrock-is-now-generally-available/)

**Honest assessment:** Claude fine-tuning is not a viable path for Lexios in March 2026. The only available model (Claude 3 Haiku) is outdated, and fine-tuning is locked to Bedrock. Anthropic's newer, more capable models cannot be fine-tuned.

**Reported results:** SK Telecom saw 73% increase in positive feedback and 37% KPI improvement with fine-tuned Claude 3 Haiku. Fine-tuned Haiku outperformed base Claude 3.5 Sonnet by 9.9% on F1. These are real but domain-specific results.

### Option B: Open-Source Models (Recommended for Lexios)

#### Best Candidates for Construction Document Extraction

**For text-based extraction:**
1. **Mistral 7B / Mistral Small 3 (24B)** — Apache 2.0 license, excellent fine-tuning ecosystem
2. **Qwen 2.5-7B** — Apache 2.0, strong structured output capabilities
3. **LLaMA 3-8B** — Largest ecosystem, but Llama Community License has restrictions

**For vision-language extraction (reading drawings/images):**
1. **Qwen 2.5-VL-7B** — Best open-source vision-language model at 7B scale
2. **LLaMA 3.2-Vision-11B** — Good multimodal capabilities
3. **Mistral Pixtral 12B** — Charts and PDF comprehension

#### LoRA / QLoRA for Parameter-Efficient Fine-Tuning

LoRA (Low-Rank Adaptation) adds small trainable matrices to frozen model weights. QLoRA adds 4-bit quantization on top, reducing memory by ~4x.

**Why LoRA/QLoRA for Lexios:**
- Small dataset (we're starting with hundreds, not millions of examples) — LoRA reduces overfitting risk
- Budget-friendly — training runs cost $1-100 instead of $500-2,000
- Fast iteration — try different configs in hours, not days
- Quality: LoRA recovers 90-95% of full fine-tuning quality; QLoRA is within 1-2% of LoRA

See `docs/examples/fine_tune_example.py` for a complete, runnable implementation.

### Option C: Domain-Specific Pre-trained Models

#### LayoutLMv3 (Microsoft)

**What it is:** A multimodal Transformer pre-trained on document images with text, layout (bounding boxes), and visual features.

**Best for:** Entity extraction from structured documents — forms, tables, invoices. Exactly the kind of structured data in construction schedules.

**Fine-tuning requirements:**
- Input: Document image + OCR text + bounding boxes
- Batch size: 32, learning rate: 2e-4
- Training data: 200-500 examples for good results on structured documents
- GPU: Single RTX 4090 is sufficient

**Published results:**
- Form understanding: F1 > 0.90 on standard benchmarks (FUNSD, CORD)
- Layout analysis: mAP > 0.95 on PubLayNet
- Healthcare documents: F1 = 0.75 for patient data extraction after fine-tuning

Source: [LayoutLMv3 Paper](https://arxiv.org/pdf/2204.08387), [Fine-tune LayoutLMv3 Guide](https://mr-amit.medium.com/fine-tune-layoutlmv3-with-your-custom-data-7435f6069677)

**Limitation for Lexios:** LayoutLMv3 excels at structured documents (schedules, forms) but struggles with vector drawings and CAD-exported PDFs. No published results on construction-specific documents.

#### Donut (OCR-Free Document Understanding)

**What it is:** An end-to-end model that takes a document image and outputs structured text — no OCR step needed.

**Best for:** Documents where OCR is unreliable (handwritten notes, low-quality scans, unusual fonts).

**Fine-tuning results (verified):**
- 100% classification accuracy on patent vs. datasheet task
- Edit distance 0.116 after 75 minutes of training on ~250 documents
- 1.3 seconds per document extraction

Source: [Towards Data Science — OCR-Free Document Extraction with Transformers](https://towardsdatascience.com/ocr-free-document-data-extraction-with-transformers-1-2-b5a826bc2ac3/)

**When to use over general LLMs:** When you need fast, cheap extraction from high-volume structured documents. Donut runs on a single GPU and extracts in ~1 second per page vs. $0.01-0.10 per API call to an LLM.

---

## Step 3: Training Pipeline

### Practical Implementation

See `docs/examples/fine_tune_example.py` for the complete runnable script. Key architecture decisions:

```python
# Core stack (all production-ready, March 2026):
# - transformers >= 4.46.0
# - peft >= 0.13.0 (LoRA/QLoRA)
# - trl >= 0.12.0 (SFTTrainer)
# - bitsandbytes >= 0.44.0 (4-bit quantization)
# - datasets >= 3.0.0

# LoRA configuration for document extraction
from peft import LoraConfig

lora_config = LoraConfig(
    r=32,                    # Rank 32 for domain-specific tasks
    lora_alpha=64,           # Alpha = 2*r is a common starting point
    lora_dropout=0.05,       # Light dropout for small datasets
    target_modules=[         # Target attention layers
        "q_proj", "k_proj", "v_proj", "o_proj",
        "gate_proj", "up_proj", "down_proj"
    ],
    task_type="CAUSAL_LM",
    bias="none",
)
```

### Hyperparameter Tuning

**Learning rate:**
- Start: 2e-4 for LoRA (higher than full fine-tuning because fewer params update)
- Schedule: Cosine annealing with warmup (5-10% of steps)
- If loss spikes: reduce to 1e-4 or 5e-5

**Batch size:**
- Effective batch size 16-32 works well for document tasks
- Use gradient accumulation if GPU memory is limited
- Larger batch = more stable training but slower convergence

**Epochs:**
- Small dataset (<500 examples): 3-5 epochs with early stopping
- Medium dataset (500-2000): 2-3 epochs
- Large dataset (>2000): 1-2 epochs
- **Watch for overfitting**: If validation loss increases while training loss decreases, stop immediately

**Rank (r) for LoRA:**
- r=16: Good starting point, minimal overhead
- r=32: Recommended for domain-specific tasks (construction is a significant domain shift)
- r=64: Use only if r=32 underperforms and you have >1000 examples
- Higher rank = more trainable parameters = better capacity but higher overfitting risk

Source: [Introl Fine-Tuning Infrastructure Guide](https://introl.com/blog/fine-tuning-infrastructure-lora-qlora-peft-scale-guide-2025)

### Evaluation Metrics

#### Standard Metrics
- **Precision**: Of all elements the model extracted, how many were correct?
- **Recall**: Of all elements that exist, how many did the model find?
- **F1**: Harmonic mean of precision and recall — the primary metric

#### Construction-Domain Metrics

For Lexios specifically, define these custom metrics:

```python
def element_f1(predicted: list, ground_truth: list) -> dict:
    """
    Element-level F1 for construction extraction.
    Matches on (category, tag) pairs. Partial credit for
    correct category but wrong attributes.
    """
    pred_set = {(e["category"], e.get("tag", "")) for e in predicted}
    gt_set = {(e["category"], e.get("tag", "")) for e in ground_truth}

    tp = len(pred_set & gt_set)
    fp = len(pred_set - gt_set)
    fn = len(gt_set - pred_set)

    precision = tp / (tp + fp) if (tp + fp) > 0 else 0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0

    return {"precision": precision, "recall": recall, "f1": f1}
```

#### Per-Category Breakdown

Track F1 separately for each extraction category. From Lexios eval baseline:

| Category | Current F1 (prompt engineering) | Target F1 (fine-tuned) |
|---|---|---|
| Schedule/Admin | 0.781 | 0.85-0.90 |
| Structural | 0.233 | 0.50-0.70 |
| Architectural | 0.185 | 0.40-0.60 |
| MEP | 0.047 | 0.20-0.40 |

**Honest note**: These targets assume 1,000+ labeled examples per category. With current data, improvement is uncertain.

#### Production Readiness Criteria

A fine-tuned model is production-ready when:
1. F1 on held-out test set exceeds the prompt-engineering baseline by >10%
2. No category regresses more than 5% compared to baseline
3. Latency is within 2x of the base model
4. The model handles adversarial inputs without catastrophic output (e.g., no JSON parse errors)
5. Performance is stable across 3 independent evaluation runs

---

## Step 4: Deployment & Monitoring

### Model Serving

#### vLLM (Recommended, March 2026)

vLLM is the production default for LLM inference serving. TGI entered maintenance mode in December 2025.

Source: [PremAI LLM Inference Servers Compared 2026](https://blog.premai.io/llm-inference-servers-compared-vllm-vs-tgi-vs-sglang-vs-triton-2026/)

```bash
# Serve a LoRA-adapted model with vLLM
pip install vllm>=0.7.0

vllm serve mistralai/Mistral-7B-v0.3 \
  --enable-lora \
  --lora-modules lexios-extract=./output/lexios-lora-adapter \
  --max-loras 4 \
  --max-lora-rank 32 \
  --gpu-memory-utilization 0.90
```

**Performance expectations (7B model, single A100):**
- Throughput: 500-2,000 tokens/second
- Latency (time to first token): 50-200ms
- Concurrent requests: 16-64 depending on sequence length

#### Cost Per 1,000 Requests

Assuming average extraction = 2K input tokens + 1K output tokens:

| Serving Option | Cost per 1K Requests | Notes |
|---|---|---|
| OpenAI GPT-4o-mini (fine-tuned) | $0.90-$1.80 | Managed, no infra |
| Self-hosted 7B (A100, vLLM) | $0.10-$0.30 | Includes GPU rental |
| Self-hosted 7B (RTX 4090, vLLM) | $0.03-$0.10 | Cheapest option |
| OpenAI GPT-4o (fine-tuned) | $10-$20 | Expensive at scale |

Source: [OpenAI Pricing](https://platform.openai.com/docs/pricing), GPU costs from providers above

### Continuous Evaluation

#### A/B Testing Against Base Model

Run both models on every incoming document for the first 2-4 weeks:

```python
import random

def extract_document(doc):
    # Send to both models, return fine-tuned result
    base_result = call_base_model(doc)
    finetuned_result = call_finetuned_model(doc)

    # Log both for comparison
    log_comparison(doc.id, base_result, finetuned_result)

    # Serve fine-tuned result (or base if fine-tuned fails)
    return finetuned_result if finetuned_result.valid else base_result
```

#### Performance Drift Detection

Monitor these metrics weekly:
- **Average F1 on sampled extractions** (manually verify 20-50 per week)
- **JSON parse error rate** (should be <1%)
- **Empty extraction rate** (should match document type distribution)
- **Latency P95** (should remain stable)

**When to retrain:**
- F1 drops >5% over 4 weeks
- New document types appear that weren't in training data
- Extraction error rate exceeds 10%

---

## Limitations & Trade-offs (Honest Assessment)

### What Fine-Tuning CANNOT Solve

1. **Insufficient training data → garbage model.** If you fine-tune on 50 examples, you'll get a model that memorizes those 50 examples and fails on everything else. This is not a theoretical concern — it's the most common failure mode.

2. **Wrong model architecture for task → fine-tuning won't fix it.** A text-only LLM cannot learn to read construction drawings from fine-tuning alone. It needs vision capabilities in its architecture. You can't fine-tune understanding into a model that can't see.

3. **Unsolved research problems → no amount of data helps.** Extracting 3D spatial relationships from 2D floor plans is an active research problem. Fine-tuning a model on labeled examples won't suddenly solve spatial reasoning that the model architecture doesn't support.

4. **Distribution shift → model breaks silently.** A model fine-tuned on residential construction documents will perform poorly on commercial or industrial documents without additional training data from those domains.

5. **Data quality ceiling.** Your model's accuracy is bounded by your label quality. If annotators disagree on 20% of labels, your model cannot exceed ~80% accuracy no matter how much data you have.

### Lexios-Specific Realities

**Current state (March 2026):**
- Corpus: 86 documents, 91 ground truths, 27,968 elements, 33 categories
- Overall F1 (prompt engineering): 0.227
- Only 57 of 86 documents scored (29 skipped — no extraction produced)
- Best category: Schedule/Admin at F1 = 0.781
- Worst category: MEP at F1 = 0.047

**Gap analysis:**
| Requirement | Current | Needed for Fine-Tuning | Gap |
|---|---|---|---|
| Labeled examples | 91 ground truths | 500-1,000 minimum | 5-10x more needed |
| Category coverage | 33 categories | 33 categories (good) | Schema exists |
| Document diversity | 86 documents | 200-500 documents | 2-5x more needed |
| Format diversity | PDF, IFC, DXF | Same | Adequate |
| Annotation consistency | Varies | Inter-annotator kappa >0.7 | Unknown, needs measurement |

**Bottom line:** Lexios needs **5-10x more labeled data** before fine-tuning is viable. The extraction schema is well-defined (33 categories), which is a strength. The immediate priority should be building the dataset, not training models.

### Alternative Approaches If Fine-Tuning Isn't Viable Yet

1. **Better prompt engineering**: Lexios's current F1 of 0.227 has significant room for improvement through better prompts alone. Construction-specific few-shot examples, chain-of-thought extraction, and page-type-specific prompts could reach F1 0.4-0.5.

2. **Retrieval-Augmented Generation (RAG)**: Index successful extractions and retrieve similar examples as context for new documents. This gives the model "experience" without fine-tuning.

3. **Hybrid pipeline**: Use LayoutLMv3 (fine-tuned on even 200 examples) for table/schedule extraction, and Claude for complex reasoning tasks. Different models for different page types.

4. **Active learning**: Use model uncertainty to prioritize which documents to label next. Label the documents the model is most confused about — this gives you maximum data efficiency.

---

## Recommended Path for Lexios (2026)

### Immediate (0-3 months): Build the Foundation

**Goal: Grow dataset from 91 to 300+ labeled examples**

1. **Standardize annotation schema** — Create a Label Studio project with Lexios's 33-category taxonomy
2. **Label high-value documents first** — Focus on schedules and admin pages (F1 already at 0.78, easiest to improve)
3. **Measure inter-annotator agreement** — Have 2 people label 30 documents, compute kappa
4. **Improve prompt engineering** — Target F1 0.35-0.45 overall with better prompts
5. **Collect 100+ high-quality examples** — Prioritize diversity of document types and sources
6. **Implement eval pipeline** — Automated F1 scoring on every prompt change

**Cost estimate:** $2,000-$5,000 (annotation tools + contractor time)
**Expected outcome:** F1 improvement from 0.227 → 0.35-0.45 (prompt engineering alone)

### Medium-Term (3-6 months): First Fine-Tuning Experiments

**Goal: LoRA fine-tune on 500-1,000 examples, A/B test against base model**

1. **Reach 500 labeled examples** across all document types
2. **Fine-tune LayoutLMv3** on schedule/table pages (easiest win)
3. **Fine-tune Mistral 7B / Qwen 2.5-7B** with LoRA for text extraction
4. **A/B test**: Run fine-tuned model alongside Claude, compare F1 and cost
5. **Measure actual improvement** — If F1 gain <5%, fine-tuning ROI is negative

**Cost estimate:** $10,000-$25,000 (labeling + compute + engineering)
**Expected outcome:** F1 improvement to 0.45-0.65 for fine-tuned model on schedule pages. Mixed results on drawing pages.

### Long-Term (6-12 months): Scale If ROI Is Positive

**Goal: 5,000+ examples, production fine-tuned model**

1. **Scale dataset** to 2,000-5,000 examples if medium-term results are positive
2. **Evaluate vision-language models** (Qwen 2.5-VL, LLaMA 3.2-Vision) for drawing pages
3. **Build continuous training pipeline** — Retrain monthly on new labeled data
4. **Deploy** fine-tuned model with vLLM, monitor drift
5. **Consider domain pre-training** — Continue pre-training on unlabeled construction documents before fine-tuning (requires significant compute)

**Cost estimate:** $30,000-$80,000 (labeling at scale + compute + engineering)
**Expected outcome:** F1 0.60-0.80 on structured documents, 0.30-0.50 on drawings

### Decision Gates

- **After month 3**: If labeled dataset <200 examples or prompt engineering F1 <0.30, pause fine-tuning plans and focus on data collection
- **After month 6**: If fine-tuned model F1 < base model F1 + 5%, fine-tuning is not justified — invest in better prompt engineering and RAG instead
- **After month 9**: If serving cost savings don't offset labeling + training investment, consider fine-tuning only for the highest-volume document types

---

## Cost-Benefit Analysis

### Total Investment Required

#### Labeling
- 1,000 examples at $10-20/example: **$10,000-$20,000**
- Domain expert review (100 hrs at $75/hr): **$7,500**
- Annotation tools: **$500**
- **Subtotal: $18,000-$28,000**

#### Compute
- Training (10 experimental runs + final): **$200-$500**
- Evaluation and benchmarking: **$100-$200**
- Serving (monthly, single GPU): **$500-$1,500/month**
- **Subtotal: $800-$2,200 + ongoing serving**

#### Engineering
- ML engineer (3-4 weeks): **$8,000-$20,000**
- Data pipeline development: **$3,000-$5,000**
- Integration and testing: **$2,000-$4,000**
- **Subtotal: $13,000-$29,000**

#### Total First-Year Cost
- **$32,000-$59,000** upfront + **$6,000-$18,000** annual serving

### Expected Returns

| Metric | Base Model (Claude) | Fine-Tuned (projected) |
|---|---|---|
| F1 (overall) | 0.227 | 0.45-0.65 (honest range) |
| Cost per extraction | ~$1.80 | ~$0.05-$0.20 |
| Latency per page | 5-15 seconds | 1-3 seconds |
| Monthly cost at 10K docs | $18,000 | $500-$2,000 |

### Break-Even Analysis

**Assumptions:**
- Cost savings per extraction: $1.60 (from $1.80 to $0.20)
- Total investment: $45,000 (midpoint)

**Break-even: ~28,000 extractions**

At 100 documents/day (each averaging 10 pages): break-even in ~28 days of production use.
At 10 documents/day: break-even in ~280 days.

**Important caveat:** This assumes the fine-tuned model achieves acceptable quality. If F1 doesn't improve enough, the cost savings are worthless because you still need human review on every extraction.

---

## References & Further Reading

### Papers (2024-2026)

1. Huang et al., "LayoutLMv3: Pre-training for Document AI with Unified Text and Image Masking" (ACMMM 2022, still the foundation). [arXiv:2204.08387](https://arxiv.org/pdf/2204.08387)
2. Kim et al., "OCR-Free Document Understanding Transformer (Donut)" (ECCV 2022, widely adopted). [HuggingFace Donut](https://huggingface.co/docs/transformers/en/model_doc/donut)
3. Lee et al., "Pix2Struct: Screenshot Parsing as Pretraining for Visual Language Understanding" (ICML 2023). [arXiv:2210.03347](https://arxiv.org/html/2210.03347)
4. Hu et al., "LoRA: Low-Rank Adaptation of Large Language Models" (ICLR 2022, foundational for efficient fine-tuning). [GitHub: microsoft/LoRA](https://github.com/microsoft/LoRA)
5. Dettmers et al., "QLoRA: Efficient Finetuning of Quantized LLMs" (NeurIPS 2023). [GitHub: artidoro/qlora](https://github.com/artidoro/qlora)
6. Luo et al., "LayoutLLM: Layout Instruction Tuning with Large Language Models for Document Understanding" (2024). [arXiv:2404.05225](https://arxiv.org/html/2404.05225v1)

### Practical Guides

- [Fine-tune LayoutLMv3 with Custom Data (2024)](https://mr-amit.medium.com/fine-tune-layoutlmv3-with-your-custom-data-7435f6069677)
- [OCR-Free Document Data Extraction with Transformers (Jan 2025)](https://towardsdatascience.com/ocr-free-document-data-extraction-with-transformers-1-2-b5a826bc2ac3/)
- [LLM Fine-Tuning Complete Guide 2025](https://tensorblue.com/blog/llm-fine-tuning-complete-guide-tutorial-2025)
- [Introl: Fine-Tuning Infrastructure — LoRA, QLoRA, and PEFT at Scale](https://introl.com/blog/fine-tuning-infrastructure-lora-qlora-peft-scale-guide-2025)
- [How Much Data Do You Need to Fine-Tune an LLM in 2026?](https://particula.tech/blog/how-much-data-fine-tune-llm)

### Working Code Repositories

- [HuggingFace PEFT (LoRA/QLoRA)](https://github.com/huggingface/peft)
- [HuggingFace TRL (SFTTrainer)](https://github.com/huggingface/trl)
- [Axolotl (Streamlined Fine-Tuning)](https://github.com/axolotl-ai-cloud/axolotl)
- [Unsloth (2x Faster Fine-Tuning)](https://github.com/unslothai/unsloth)
- [vLLM (Inference Server)](https://github.com/vllm-project/vllm)
- [Label Studio (Annotation)](https://github.com/HumanSignal/label-studio)

### Pricing References (March 2026)

- [OpenAI API Pricing](https://platform.openai.com/docs/pricing)
- [IntuitionLabs H100 Rental Prices Compared](https://intuitionlabs.ai/articles/h100-rental-prices-cloud-comparison)
- [Spheron GPU Cloud Pricing Comparison 2026](https://www.spheron.network/blog/gpu-cloud-pricing-comparison-2026/)
- [AWS EC2 On-Demand Pricing](https://aws.amazon.com/ec2/pricing/on-demand/)
- [Jarvislabs A100 Pricing](https://docs.jarvislabs.ai/blog/a100-price)
- [LLM Fine-Tuning Pricing Comparison](https://pricepertoken.com/fine-tuning)
