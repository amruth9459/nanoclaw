# Model QA Analysis — Hugging Face "Build Small" Hackathon 2026

**Subject of audit:** The *Build Small* hackathon as a structured experiment in Small Language Model (SLM) capability, deployment, and evaluation, contextualized against 2026 SLM benchmark and calibration research.

**Audit type:** Independent Model QA review — experimental-design soundness, benchmark methodology, calibration rigor, efficiency/cost validation, and claim-to-source provenance.

**Prepared by:** Model QA Specialist (specialized) · NanoClaw Auto-Dispatch
**Audit date:** 2026-06-07
**Hackathon status at audit time:** **In progress** (hack window June 5–15, 2026; winners not yet announced)
**Audit classification:** Documentation + secondary-evidence review (no first-party model artifacts available; no submissions evaluable yet)

---

## 1. Executive Summary

### 1.1 What was audited

The *Build Small* hackathon is a community competition that constrains participants to language models of **≤ 32 billion total parameters**, deployed as **Gradio applications on Hugging Face Spaces**, split across two tracks: a **practical** track ("🏡 Backyard AI" — solve a real problem for a specific person) and a **whimsical** track ("🍄 An Adventure in Thousand Token Wood" — build something delightful where the AI is load-bearing). The prize pool is **$48,000+** in cash plus physical hardware (2× NVIDIA RTX 5080 GPUs) and compute credits. ([Build Small Hackathon](https://huggingface.co/build-small-hackathon))

This report treats the hackathon as an *experiment*: a hypothesis ("sub-32B models can solve real and delightful problems when deployed thoughtfully") tested across ~179 in-progress submissions. It audits the experiment's design, then grounds the audit in the 2026 SLM evidence base — benchmark studies, calibration research, and cost/efficiency analyses — to assess whether the experiment's implicit claims are supported.

### 1.2 Objectives

1. Validate the experimental design (constraints, deployment methodology, track separation, evaluation criteria).
2. Verify the SLM capability claims circulating around the event against primary and aggregator sources.
3. Review the dominant 2026 SLM benchmark methodology for statistical soundness.
4. Assess calibration rigor — a dimension the hackathon does **not** require but which materially affects whether "it works" claims are trustworthy.
5. Validate the efficiency/cost thesis that motivates building small.
6. Surface provenance gaps where widely-repeated numbers are mis-attributed to the wrong source.

### 1.3 Key findings from 2026 SLM research

- **SLM viability is real and measurable.** SmolLM3-3B (3B params) outperforms Llama-3.2-3B and Qwen2.5-3B and sits at the Pareto front near 4B-class models (Qwen3-4B, Gemma 3 4B) on a 12-benchmark win-rate comparison. ([SmolLM3 blog](https://huggingface.co/blog/smollm3))
- **Sub-4B models now post strong reasoning scores.** Gemma 3 4B reaches **89.2% on GSM8K**; Phi-4-mini (3.8B) reaches **83.7% on ARC-Challenge** (10-shot) — the highest in its class. ([llm-stats Gemma 3 4B vs Phi-4-mini](https://llm-stats.com/models/compare/gemma-3-4b-it-vs-phi-4-mini); [Phi-4-Mini Technical Report](https://arxiv.org/pdf/2503.01743))
- **Cost efficiency is the headline result.** SLMs deliver ≈**100×** (up to **180×** at enterprise scale) inference cost reduction versus LLMs, with 10–20× latency improvements. ([SLM vs LLM](https://labelyourdata.com/articles/llm-fine-tuning/slm-vs-llm))
- **Calibration is the silent risk.** Across the 2026 literature, instruction-tuned/RLHF models are systematically **over**confident while base models stay better calibrated — a failure mode the hackathon's judging does not test for. ([Uncertainty Quantification & Confidence Calibration Survey, SIGKDD 2025](https://dl.acm.org/doi/10.1145/3711896.3736569))

### 1.4 Overall assessment

> **SOUND WITH FINDINGS.**

The experimental *framing* is sound: the parameter cap is unambiguous, the deployment target is uniform and reproducible, and the two-track split cleanly separates utility from delight. The supporting SLM evidence base is strong and largely corroborates the capability and cost claims.

However, the experiment is **not yet evaluable** (no winners, no outcomes — the hack window is open until June 15, 2026), its evaluation rubric is **qualitative and judge-mediated rather than metrics-based**, and it includes **no calibration or reliability validation** despite calibration being the dominant 2026 reliability concern for the exact model class in scope. Several capability numbers in circulation are **correct but mis-sourced**. These do not invalidate the experiment; they bound what conclusions can be drawn from it. Findings are catalogued in §7.

---

## 2. Experimental Design Assessment

### 2.1 Constraint validation — the 32B parameter limit

| Property | Assessment |
|---|---|
| **Stated constraint** | "≤ 32 billion parameters (total)" ([source](https://huggingface.co/build-small-hackathon)) |
| **Clarity** | ✅ Unambiguous threshold; "total" disambiguates MoE active-vs-total counts |
| **Enforceability** | ⚠️ Self-reported. No automated parameter-count gate is described; relies on honest disclosure ("honest fit between problem and small-model constraint" is itself a judging criterion) |
| **Edge case — MoE** | ✅ "Total" wording correctly captures sparse models (e.g., a 30B-A3B MoE counts as 30B, not 3B active) |
| **Sub-cap incentive** | ✅ A dedicated **"Tiny Titan"** award (best ≤4B model, $1,500) creates a gradient *within* the cap, rewarding extra constraint |

**Verdict:** The constraint is well-specified and reinforced by a secondary incentive. The only weakness is enforcement: parameter count is verified socially, not programmatically. For a community event this is acceptable; for a rigorous benchmark it would be a validity threat.

### 2.2 Deployment methodology — Gradio on Hugging Face Spaces

- **Uniform target.** Every entry must ship as a Gradio app on a HF Space ([source](https://huggingface.co/build-small-hackathon)). This is a genuine strength for reproducibility: a single runtime, public URLs, and a shared org (1,778 members, 179 Spaces in progress at audit time) make every artifact independently inspectable.
- **Confound:** "Polish of the Gradio app" is an explicit judging criterion in *both* tracks. Deployment quality is therefore **entangled with model quality** in the score. A weak model behind a polished UI can outscore a strong model behind a rough one. This is intentional (the event rewards shipping, not raw benchmarks) but it means scores are **not** a clean signal of model capability.
- **Local/offline path supported.** Optional merit badges ("🔌 Off the Grid" — no cloud APIs; "🦙 Llama Champion" — llama.cpp runtime) push toward on-device inference, which aligns with the SLM efficiency thesis (§6).

### 2.3 Track separation — practical vs whimsical

| | Practical track | Whimsical track |
|---|---|---|
| **Official name** | 🏡 Backyard AI | 🍄 An Adventure in Thousand Token Wood |
| **Goal** | Measurably improve a specific real person's day | Build something delightful; AI is load-bearing |
| **Distinct criteria** | Problem is specific & real; the person actually used it; honest model-fit | Genuinely delightful; AI load-bearing; originality |
| **Shared criterion** | Polish of the Gradio app | Polish of the Gradio app |

**Verdict:** ✅ The separation is clean and the per-track criteria are genuinely different (utility/adoption evidence vs delight/originality). This is good experimental hygiene — it prevents a single leaderboard from forcing incommensurable submissions into one ranking.

> **QA note on naming:** The dispatch brief refers to the tracks as "Practical" and "Whimsical." The hackathon's official names are "Backyard AI" and "An Adventure in Thousand Token Wood." The mapping is faithful, but downstream readers should expect the official names in primary materials.

### 2.4 Evaluation criteria — explicit vs implied

This is the experiment's central methodological soft spot.

- **What is explicit:** Four qualitative criteria per track (specificity/reality, actual usage, model-fit honesty, UI polish on the practical side; delight, AI-as-load-bearing, originality, UI polish on the whimsical side).
- **What is implied/absent:** No quantitative accuracy threshold, no held-out test set, no latency/cost target, no calibration or safety check, no inter-rater reliability protocol disclosed. "The person actually used it" is the closest thing to an empirical outcome metric, and it is binary and self-reported.

**Verdict:** The rubric is appropriate for a *creativity-and-shipping* competition but is **not** a metrics-based model evaluation. Treating hackathon placement as evidence of model quality would be a category error (see Finding F-3, §7).

---

## 3. Model Performance Analysis

The hackathon's model menu spans the strongest sub-32B options of 2026. Below, each headline claim is verified against sources, with a **confidence** rating and any provenance caveat.

### 3.1 SmolLM3-3B — 3B params, beats Llama-3.2-3B & Qwen2.5-3B

- **Claim:** 3B model competitive with 4B-class models across 12 benchmarks; outperforms Llama-3.2-3B and Qwen2.5-3B.
- **Verification:** ✅ **Confirmed.** Hugging Face's announcement presents a **12-benchmark win-rate** chart on which SmolLM3 sits essentially on the same line as Qwen3-4B and Gemma 3 4B while using ~1B fewer parameters, and explicitly outperforms Llama-3.2-3B-Instruct and Qwen2.5-3B-Instruct. Architecture: decoder-only, GQA + NoPE, 11.2T training tokens, 64K context (→128K via YaRN), native 6 languages, dual-mode (`/think`, `/no_think`) reasoning. ([SmolLM3 blog](https://huggingface.co/blog/smollm3))
- **Confidence:** High.
- **⚠️ Provenance caveat:** The dispatch cited `smollm3.com` for the "12-benchmark" claim. That page lists only **6** benchmarks (HellaSwag 75.2, ARC-C 62.8, MMLU 55.7, GSM8K 45.2, HumanEval 29.4, MGSM 38.9) and makes **no** direct head-to-head comparison to Llama-3.2-3B/Qwen2.5-3B. The **canonical** source for the 12-benchmark win-rate and the head-to-head claim is `huggingface.co/blog/smollm3`, not `smollm3.com`. Cite the blog. ([smollm3.com](https://smollm3.com/) vs [SmolLM3 blog](https://huggingface.co/blog/smollm3))

### 3.2 Gemma 3 4B — 89.2% on GSM8K

- **Claim:** Gemma 3 4B scores 89.2% on GSM8K math reasoning.
- **Verification:** ✅ **Confirmed** across aggregators: GSM8K 89.2%, IFEval 90.2%, MATH 75.6%, HumanEval 71.3%, 128K context, multimodal (text+image). ([llm-stats](https://llm-stats.com/models/compare/gemma-3-4b-it-vs-phi-4-mini); [SLM leaderboard](https://awesomeagents.ai/leaderboards/small-language-model-leaderboard/))
- **Confidence:** High (figure consistent across multiple aggregators).
- **⚠️ Provenance caveat (important):** The dispatch attributed Gemma-class numbers to arXiv **2604.07035**. That paper studies **Gemma 4** (E2B/E4B/26B-A4B MoE variants), **not Gemma 3**, and reports much lower GSM8K (best 0.680 on 100-example subsets — see §4). The **89.2% GSM8K figure belongs to Gemma 3 4B-IT** and must **not** be sourced to 2604.07035. Mixing the two is a real attribution error.

### 3.3 Phi-4-mini — 3.8B, 83.7% on ARC-Challenge (highest in class)

- **Claim:** Phi-4-mini (3.8B) scores 83.7% on ARC-C, the highest in its size class.
- **Verification:** ✅ **Confirmed against the primary source.** Microsoft's official **Phi-4-Mini Technical Report** lists ARC-C (10-shot) = **83.7** for Phi-4-mini 3.8B; the report states Phi-4-mini "outperforms similar size models and is on-par with models 2× larger." Also: GSM8K 88.6, BoolQ 81.2, OpenBookQA 79.2, PIQA 77.6. 128K context, MIT license. ([Phi-4-Mini Technical Report, arXiv 2503.01743](https://arxiv.org/pdf/2503.01743))
- **Confidence:** High (primary-source verified; "highest in class" corroborated by an independent leaderboard).
- **Note:** ARC-C 83.7 is a **10-shot** result. The benchmark study in §4 evaluates a *different* variant (`Phi-4-mini-reasoning`) under zero/CoT/few-shot CoT and gets different numbers — do not conflate model variant or shot count.

### 3.4 Qwen3.5-4B — 262K native context, extensible to 1M+

- **Claim:** Qwen3.5-4B supports 262K native context, extensible to 1M+ tokens.
- **Verification:** ⚠️ **Partially confirmed / under-sourced.** The Qwen3.5 family does advertise 262K native context with YaRN extension toward 1M; aggregators confirm **262K** for the Qwen3.5 line (the BentoML survey lists Qwen3.5-**0.8B** at 262K) and the broader Qwen3.5 docs describe 1M-token extension. However, I could not pin the **262K-for-the-4B-variant-specifically** to a primary Qwen model card within this audit — the directly-citable 262K figure I found is for the 0.8B variant. ([Best Open-Source SLMs 2026, BentoML](https://www.bentoml.com/blog/the-best-open-source-small-language-models))
- **Confidence:** Medium. The context-length *breakthrough* is real (Finding F-6); the exact "4B at 262K" attribution should be confirmed against the Qwen3.5-4B model card before publication.

### 3.5 Tiny Aya — 3.35B, 70+ languages (multilingual)

- **Claim:** Cohere's Tiny Aya, 3.35B params, covers 70+ languages.
- **Verification:** ✅ **Confirmed.** Tiny Aya is a 3.35B multilingual family with 4 regional variants (global / water=Euro+APAC / fire=South Asian / earth=West Asian+African), covering **70+ languages**, available in PyTorch and GGUF. ([Build Small with Cohere](https://huggingface.co/blog/CohereLabs/build-small-hackathon-with-cohere-models))
- **Confidence:** High.
- **Note:** Cohere's guide provides **no benchmark numbers** — only capability and integration claims. Multilingual *coverage* (70+ languages) is an availability claim, not a measured-quality claim; per-language quality is unverified.

### 3.6 Cohere Transcribe — 2B, ASR for 14 languages

- **Claim:** Cohere Transcribe, 2B params, ASR across 14 languages.
- **Verification:** ✅ **Confirmed.** 2B dedicated ASR model; 14 languages (Arabic, Chinese, Dutch, English, French, German, Greek, Italian, Japanese, Korean, Polish, Portuguese, Spanish, Vietnamese); Apache 2.0; punctuation control + long-form chunking. ([Build Small with Cohere](https://huggingface.co/blog/CohereLabs/build-small-hackathon-with-cohere-models))
- **Confidence:** High.
- **Note:** Combining Tiny Aya (3.35B) + Transcribe (2B) = **5.35B total**, well under the 32B cap — a sanctioned multilingual-voice-assistant recipe.

### 3.7 Capability summary

| Model | Params | Headline metric | Source confidence | Provenance flag |
|---|---|---|---|---|
| SmolLM3-3B | 3.0B | Beats Llama-3.2-3B & Qwen2.5-3B (12-bench win-rate) | High | Cite HF blog, **not** smollm3.com |
| Gemma 3 4B | 4.0B | GSM8K **89.2%** | High | Belongs to Gemma **3**, not the Gemma **4** arXiv paper |
| Phi-4-mini | 3.8B | ARC-C **83.7%** (10-shot), class-best | High | Primary-source verified (2503.01743) |
| Qwen3.5-4B | 4B | 262K ctx → 1M+ | Medium | 262K confirmed for 0.8B; verify 4B card |
| Tiny Aya | 3.35B | 70+ languages | High | Coverage, not measured quality |
| Cohere Transcribe | 2B | ASR, 14 languages | High | — |

---

## 4. Benchmark Methodology Review

The dominant 2026 reference study for this model class is **"Gemma 4, Phi-4, and Qwen3: Accuracy–Efficiency Tradeoffs in Dense and MoE Reasoning Language Models"** ([arXiv 2604.07035v1](https://arxiv.org/html/2604.07035v1)). The dispatch brief draws its methodology description from this paper; here it is audited directly.

### 4.1 Design as reported

- **Models (7):** Phi-4-mini-reasoning (3.8B), Qwen3-8B (8.0B), Phi-4-reasoning (14.0B) [dense]; Gemma-4-E2B (5.0B/2.0B active), Gemma-4-E4B (8.0B/4.0B), Gemma-4-26B-A4B (26.0B/3.8B), Qwen3-30B-A3B (30.0B/3.0B) [MoE].
- **Datasets (4):** ARC-Challenge, GSM8K, Math Level 1–3, TruthfulQA MC1 — **100 examples each**.
- **Prompting strategies (3):** zero-shot, CoT, few-shot CoT.
- **Scale:** 7 × 4 × 3 × 100 = **8,400 evaluations**. ✅ Matches the dispatch's stated count.
- **Metrics:** accuracy with **95% CIs**, mean latency (s), peak VRAM (GB), FLOPs-per-token, tokens/sec.
- **Statistics:** McNemar matched-pair tests — **181 of 252** comparisons significant at p<0.05.

### 4.2 Headline results

- **Best overall:** Gemma-4-E4B + few-shot CoT → **0.675 weighted accuracy** at 14.89 GB VRAM, 5.46s latency.
- **Per task:** ARC-C → Gemma-4-26B-A4B (0.960); GSM8K → Gemma-4-26B-A4B few-shot CoT (0.680), Phi-4-reasoning under plain CoT (0.670); Math L1–L3 → Gemma-4-E4B (0.490); TruthfulQA MC1 → Phi-4-reasoning few-shot CoT (1.000).
- **Critical nuance:** *"Few-shot chain-of-thought was not uniformly beneficial."* Phi-4-reasoning **collapsed from 0.670 → 0.110 on GSM8K** under few-shot conditions — the largest strategy spread observed.

### 4.3 Methodology assessment

| Dimension | Assessment |
|---|---|
| Statistical reporting | ✅ Strong — 95% CIs + McNemar paired tests is above the norm for model-comparison blog-grade work |
| Prompt-strategy coverage | ✅ Good — three strategies expose prompt-sensitivity (the Phi-4 collapse is a valuable negative result) |
| **Sample size** | ⚠️ **100 examples/benchmark.** Small. At n=100 a 95% CI on a proportion is roughly ±6–10 points; many headline gaps fall within overlapping CIs. Rankings should be read as *indicative*, not definitive |
| **Variant/version hygiene** | ⚠️ Paper covers **Gemma 4** and **Phi-4-mini-reasoning / Phi-4-reasoning** — distinct from the **Gemma 3 4B** and **Phi-4-mini-instruct** whose 89.2%/83.7% numbers circulate elsewhere. Cross-citing these is the most common error in SLM write-ups (Findings F-7, F-8) |
| **Quantization** | ⚠️ The study specifies **no quantization** (no Q4_K_M). The "Q4_K_M as production default" claim in the dispatch is a **deployment convention**, not a finding of this paper. Do not attribute it here (Finding F-9) |
| Prompt-sensitivity | ✅ Explicitly surfaced; the few-shot-CoT collapse is the study's most actionable insight for hackathon builders |

**Verdict:** The benchmark methodology is **methodologically sound but statistically modest** (n=100). Its most valuable contribution is the demonstration that prompting strategy can swing a strong model by **>0.55 absolute accuracy** — a direct, practical warning for hackathon participants who pick a prompt template once and never test alternatives.

---

## 5. Calibration Analysis

Calibration — whether a model's stated/implied confidence matches its actual accuracy — is **absent from the hackathon rubric** yet is the dominant 2026 reliability theme for sub-32B instruction-tuned models. This section grounds Finding F-2.

### 5.1 What the 2026 literature establishes

- **Instruction tuning / RLHF degrades calibration.** Base LLMs are generally well-calibrated on factual questions via token-level log-probs; **alignment training induces overconfidence.** This holds across PPO and DPO alike, indicating it is a structural consequence of optimizing toward human-preference signals, not an artifact of one method. ([Confidence Calibration in LLMs](https://www.emergentmind.com/topics/confidence-calibration-in-llms); [UQ & Calibration Survey, SIGKDD 2025](https://dl.acm.org/doi/10.1145/3711896.3736569))
- **Base models stay better calibrated** — exploited by "base-model anchoring" methods that proxy a post-trained model's confidence through its base distribution. ([Survey](https://dl.acm.org/doi/10.1145/3711896.3736569))
- **Verbalized confidence is severely overconfident and discretized.** RLHF-tuned models predominantly emit verbal confidence in the **80–100%** band regardless of true accuracy, with ECE reaching **0.30+** on knowledge-intensive tasks — the discretization (round numbers, narrow band) is itself an artifact that hides real uncertainty. ([Confidence Calibration in LLMs](https://www.emergentmind.com/topics/confidence-calibration-in-llms))
- **Consistency-based methods beat post-hoc approaches.** Sampling N generations and scoring agreement (e.g., modal-answer proportion over N=10 at temperature 1) yields better calibration than directly verbalized confidence or post-hoc scaling, and needs **no access to internal token probabilities** — making it usable on any hosted model. ([Calibrating LLMs with Sample Consistency, arXiv 2402.13904](https://arxiv.org/abs/2402.13904))

### 5.2 Why this matters for *this* hackathon

Every sponsor-recommended model in §3 is an **instruction-tuned** chat model — precisely the class shown to be overconfident. In the "🏡 Backyard AI" track, a tool that confidently gives a neighbor a wrong dosage, legal step, or financial figure is a **reliability failure even if the demo looks great.** Because the rubric rewards "polish" and "the person actually used it" but never tests whether the model *knows when it's wrong*, the experiment cannot distinguish a calibrated helper from a confident-but-wrong one.

### 5.3 Assessment

| Dimension | Assessment |
|---|---|
| Calibration in rubric | ❌ Not required, not measured |
| Model class in scope | ⚠️ All instruction-tuned → all in the high-overconfidence regime |
| Mitigation available | ✅ Consistency-based confidence is cheap, model-agnostic, and Gradio-compatible |
| **Verdict** | **MEDIUM finding (F-2):** an avoidable reliability gap, with an off-the-shelf mitigation participants are not prompted to use |

**Recommendation:** Add an optional **"Well-Calibrated" merit badge** mirroring the existing badge system — award entries that surface a consistency-based confidence signal (e.g., "I'm unsure" when N-sample agreement is low). This converts a latent risk into a rewarded behavior at near-zero rubric cost.

---

## 6. Efficiency & Cost Analysis

The economic case is the experiment's strongest empirically-supported premise.

### 6.1 Cost

- **Inference:** For a workload of 1M business conversations/month (500–1000 tokens each way), LLMs cost **$15,000–$75,000/month** vs **$150–$800/month** for SLMs — a ≈**100×** reduction, rising to **≈180×** at enterprise query volumes. ([SLM vs LLM](https://labelyourdata.com/articles/llm-fine-tuning/slm-vs-llm))
- **Training/tuning:** LLM training exceeds $100M (Gemini Ultra reported ≈$191M); SLMs fine-tune on a single GPU at a fraction of that. ([same](https://labelyourdata.com/articles/llm-fine-tuning/slm-vs-llm))

### 6.2 Latency & deployment

| Task | SLM | LLM |
|---|---|---|
| Real-time chatbot | 50 ms | 800 ms |
| Code completion | 80 ms | 900 ms |
| Edge IoT | 30 ms | Not feasible |

SLMs (1–15B) run on a **single GPU/CPU, edge devices, or on-prem**; LLMs (100B–1T+) require multi-GPU/TPU clusters and cloud APIs. ([SLM vs LLM](https://labelyourdata.com/articles/llm-fine-tuning/slm-vs-llm))

### 6.3 Quantization

**Q4_K_M** 4-bit quantization is the de-facto production default for running these models on consumer GPUs / edge hardware via the GGUF/llama.cpp stack — and the hackathon's "🦙 Llama Champion" badge explicitly rewards the llama.cpp runtime, aligning the event with this deployment reality. ([Best Open-Source SLMs 2026](https://www.bentoml.com/blog/the-best-open-source-small-language-models)) **Caveat (F-9):** Q4_K_M is a community/deployment convention; it is **not** a finding of the §4 benchmark paper, which ran unquantized.

### 6.4 Assessment

The efficiency thesis is **validated and well-sourced** (Finding F-5, INFO). The hackathon's design — small models, Gradio Spaces, optional local/llama.cpp paths, and a "Tiny Titan" sub-4B award — is **coherently aligned** with this thesis. This is the experiment's most defensible claim.

---

## 7. Findings Summary Table

Severity legend: **High** = blocks/limits valid conclusions · **Medium** = material gap, mitigable · **Low** = supports the thesis, minor caveat · **Info** = corroborated context. Findings F-1…F-6 are the core dispatch findings; F-7…F-9 are provenance issues this audit surfaced.

| ID | Finding | Severity | Domain | Evidence (source) | Recommendation |
|---|---|---|---|---|---|
| **F-1** | **Hackathon ongoing — no final results.** Hack window June 5–15, 2026; winners not announced; no submission outcomes evaluable. Any "what won / what works" conclusion is premature. | **High** | Design | [Build Small Hackathon](https://huggingface.co/build-small-hackathon) | Scope all conclusions as *design-level*; re-audit after winners announced. Do not cite placement as model-quality evidence. |
| **F-2** | **Insufficient calibration testing.** All sponsor models are instruction-tuned (overconfidence-prone), yet the rubric mandates no calibration/reliability check. | **Medium** | Calibration | [Calibration Survey (SIGKDD 2025)](https://dl.acm.org/doi/10.1145/3711896.3736569); [Confidence Calibration in LLMs](https://www.emergentmind.com/topics/confidence-calibration-in-llms) | Add optional "Well-Calibrated" badge; recommend consistency-based confidence (N-sample agreement). |
| **F-3** | **No standardized evaluation framework.** Judging is qualitative (specificity, adoption, delight, UI polish) with no held-out set, accuracy threshold, latency/cost target, or inter-rater protocol. | **Medium** | Design | [Build Small Hackathon](https://huggingface.co/build-small-hackathon) | Publish a lightweight scoring rubric with weights + ≥2 raters per entry; keep qualitative criteria but anchor them. |
| **F-4** | **Impressive SLM performance.** SmolLM3-3B competitive with 4B-class models on a 12-benchmark win-rate; broad sub-4B viability. | **Low** | Performance | [SmolLM3 blog](https://huggingface.co/blog/smollm3) | Cite the HF blog (not smollm3.com) for the 12-benchmark claim; treat as supporting evidence, not proof of hackathon success. |
| **F-5** | **Cost efficiency validated.** ≈100× (up to 180×) cheaper inference vs LLMs; 10–20× lower latency; single-GPU/edge deployable. | **Info** | Efficiency | [SLM vs LLM](https://labelyourdata.com/articles/llm-fine-tuning/slm-vs-llm) | Use as the experiment's core motivating premise; well-supported. |
| **F-6** | **Context-length breakthrough.** Qwen3.5 line supports 262K native context, extensible toward 1M+ via YaRN. | **Info** | Performance | [Best Open-Source SLMs 2026](https://www.bentoml.com/blog/the-best-open-source-small-language-models) | Verify "262K for the 4B variant" against the Qwen3.5-4B model card; 262K confirmed for 0.8B in source. |
| **F-7** | **Mis-sourced Gemma number.** The 89.2% GSM8K belongs to **Gemma 3 4B-IT**, but is being attributed to arXiv 2604.07035, which studies **Gemma 4** (MoE) and reports GSM8K ≤0.680 on 100-ex subsets. | **Medium** | Performance | [llm-stats](https://llm-stats.com/models/compare/gemma-3-4b-it-vs-phi-4-mini); [arXiv 2604.07035](https://arxiv.org/html/2604.07035v1) | Attribute 89.2% to Gemma 3 4B aggregator/model card; reserve 2604.07035 for Gemma **4** results only. |
| **F-8** | **Variant/shot-count conflation.** Phi-4-mini ARC-C 83.7% is **10-shot** from the official Phi-4-Mini report; the §4 study tests a different variant (`Phi-4-mini-reasoning`) under different shots. | **Low** | Performance | [Phi-4-Mini Tech Report](https://arxiv.org/pdf/2503.01743); [arXiv 2604.07035](https://arxiv.org/html/2604.07035v1) | State variant + shot count alongside every figure; don't cross-cite the two Phi sources. |
| **F-9** | **Quantization mis-attribution.** "Q4_K_M as production default" is a deployment convention, **not** a result of the §4 benchmark paper (which ran unquantized). | **Low** | Efficiency | [Best Open-Source SLMs 2026](https://www.bentoml.com/blog/the-best-open-source-small-language-models); [arXiv 2604.07035](https://arxiv.org/html/2604.07035v1) | Cite Q4_K_M as a community/llama.cpp convention; don't credit it to the benchmark study. |

---

## 8. Recommendations

**For the hackathon organizers (to strengthen the experiment):**
1. Add a lightweight, weighted scoring rubric and require ≥2 independent raters per submission with a disclosed tie-break (addresses F-3).
2. Introduce an optional **"Well-Calibrated"** merit badge rewarding consistency-based confidence signals (addresses F-2).
3. Require each submission's README to disclose exact model + parameter count + quantization, enabling automated cap verification (strengthens §2.1).

**For participants (to maximize real-world reliability):**
1. Test ≥2 prompting strategies per task — the §4 study shows a single strategy can swing accuracy by >0.55 (Phi-4-reasoning GSM8K 0.670→0.110).
2. Add a cheap consistency check (sample N=10, surface "unsure" on low agreement) before claiming "it works."
3. For "Backyard AI" tools touching health/legal/financial advice, gate confident outputs behind a calibration signal.

**For anyone citing this domain (provenance hygiene):**
1. Cite SmolLM3's 12-benchmark claim to `huggingface.co/blog/smollm3`, not `smollm3.com` (F-4).
2. Keep **Gemma 3** (89.2% GSM8K, dense) and **Gemma 4** (arXiv 2604.07035, MoE) strictly separate (F-7).
3. Always state model **variant + shot count + quantization** next to a benchmark number (F-8, F-9).

---

## 9. Audit Scope & Limitations

- **No first-party artifacts.** No model weights, eval logs, or submission code were available to this audit. Findings rest on the hackathon's published rules, sponsor docs, and the cited 2026 literature.
- **Outcome-blind.** Because the event is in progress (F-1), this is a *design* audit, not an *outcomes* audit. A follow-up after June 15, 2026 should re-score submissions against the criteria in §2.4.
- **Aggregator dependence.** Some capability numbers (Gemma 3 4B GSM8K) are corroborated via comparison aggregators rather than a single primary model card; primary-card confirmation is recommended before high-stakes citation.
- **Gated source.** The SIGKDD 2025 calibration survey ([10.1145/3711896.3736569](https://dl.acm.org/doi/10.1145/3711896.3736569)) returned HTTP 403 to automated fetch; its findings here are reconstructed from the surrounding peer-reviewed/arXiv literature, which is in strong agreement.

---

## 10. Sources

**Hackathon (primary):**
- [Build Small Hackathon](https://huggingface.co/build-small-hackathon) — rules, tracks, prizes, timeline, status
- [Build Small with Cohere Models](https://huggingface.co/blog/CohereLabs/build-small-hackathon-with-cohere-models) — Tiny Aya, Cohere Transcribe

**Model capability:**
- [SmolLM3 blog (Hugging Face)](https://huggingface.co/blog/smollm3) — 12-benchmark win-rate, architecture (canonical)
- [smollm3.com](https://smollm3.com/) — secondary spec page (6 benchmarks)
- [Phi-4-Mini Technical Report (arXiv 2503.01743)](https://arxiv.org/pdf/2503.01743) — ARC-C 83.7 (10-shot), primary
- [llm-stats — Gemma 3 4B vs Phi-4-mini](https://llm-stats.com/models/compare/gemma-3-4b-it-vs-phi-4-mini) — Gemma 3 4B GSM8K 89.2
- [Small Language Model Leaderboard](https://awesomeagents.ai/leaderboards/small-language-model-leaderboard/) — class-best corroboration
- [Best Open-Source SLMs 2026 (BentoML)](https://www.bentoml.com/blog/the-best-open-source-small-language-models) — Qwen3.5 262K context, Q4_K_M convention

**Benchmark methodology:**
- [Gemma 4, Phi-4, Qwen3: Accuracy–Efficiency Tradeoffs (arXiv 2604.07035v1)](https://arxiv.org/html/2604.07035v1) — 8,400-eval study (MoE/dense, Gemma **4**)

**Calibration:**
- [Uncertainty Quantification & Confidence Calibration Survey, SIGKDD 2025 (10.1145/3711896.3736569)](https://dl.acm.org/doi/10.1145/3711896.3736569) — instruction-tuning degrades calibration
- [Confidence Calibration in LLMs (EmergentMind)](https://www.emergentmind.com/topics/confidence-calibration-in-llms) — verbal-confidence 80–100% band, ECE 0.30+
- [Calibrating LLMs with Sample Consistency (arXiv 2402.13904)](https://arxiv.org/abs/2402.13904) — consistency beats post-hoc

**Efficiency & cost:**
- [SLM vs LLM Trade-offs (Label Your Data)](https://labelyourdata.com/articles/llm-fine-tuning/slm-vs-llm) — 100×/180× cost, latency, deployment

---

*Audit prepared by Model QA Specialist (specialized) for NanoClaw Auto-Dispatch. This is an independent QA review; it does not represent the hackathon organizers, sponsors, or model vendors. All quantitative claims are attributed to the linked sources; where a number could not be confirmed against a primary source, confidence is marked and a verification step is recommended.*
