#!/usr/bin/env python3
"""
Fine-tuning a document extraction model with LoRA/QLoRA.

This script demonstrates fine-tuning Mistral-7B for construction document
extraction using the PEFT (Parameter-Efficient Fine-Tuning) library.

Requirements:
    pip install torch>=2.1.0 transformers>=4.46.0 peft>=0.13.0 \
                trl>=0.12.0 bitsandbytes>=0.44.0 datasets>=3.0.0 \
                accelerate>=1.0.0

Hardware:
    - QLoRA (4-bit): 1x RTX 4090 (24GB) or 1x A100 40GB
    - LoRA (16-bit): 1x A100 40GB or better

Cost estimate (March 2026):
    - RTX 4090 cloud: $0.40-0.80/hr * 2-4 hrs = $1-3 per training run
    - A100 cloud:     $1.49-3.43/hr * 1-3 hrs = $2-10 per training run

Usage:
    # Prepare dataset first (see prepare_dataset())
    python fine_tune_example.py --mode prepare --data-dir ./data/lexios-train

    # Run training
    python fine_tune_example.py --mode train --data-dir ./data/lexios-train

    # Evaluate
    python fine_tune_example.py --mode eval --data-dir ./data/lexios-train \
        --adapter-path ./output/lexios-lora-adapter

    # Run inference
    python fine_tune_example.py --mode infer --adapter-path ./output/lexios-lora-adapter
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# 1. Dataset Preparation
# ---------------------------------------------------------------------------

# Example training data format for construction document extraction.
# Each example is an input (document text or description) paired with
# the expected structured extraction output.
EXAMPLE_TRAINING_DATA = [
    {
        "input": (
            "Extract all building elements from this door schedule:\n\n"
            "DOOR SCHEDULE - LEVEL 1\n"
            "Mark | Width | Height | Type | Material | Fire Rating | Hardware\n"
            "D101 | 3'-0\" | 7'-0\" | Single Flush | HM | 90 min | HS-1\n"
            "D102 | 6'-0\" | 7'-0\" | Double Flush | Wood | None | HS-3\n"
            "D103 | 3'-0\" | 7'-0\" | Single w/ Lite | HM | 20 min | HS-2\n"
        ),
        "output": json.dumps(
            {
                "page_type": "door_schedule",
                "zone": "Level 1",
                "elements": [
                    {
                        "category": "doors",
                        "tag": "D101",
                        "type": "Single Flush",
                        "width": "3'-0\"",
                        "height": "7'-0\"",
                        "material": "Hollow Metal",
                        "fire_rating": "90 min",
                        "hardware_set": "HS-1",
                    },
                    {
                        "category": "doors",
                        "tag": "D102",
                        "type": "Double Flush",
                        "width": "6'-0\"",
                        "height": "7'-0\"",
                        "material": "Wood",
                        "fire_rating": "None",
                        "hardware_set": "HS-3",
                    },
                    {
                        "category": "doors",
                        "tag": "D103",
                        "type": "Single w/ Lite",
                        "width": "3'-0\"",
                        "height": "7'-0\"",
                        "material": "Hollow Metal",
                        "fire_rating": "20 min",
                        "hardware_set": "HS-2",
                    },
                ],
                "metadata": {"total_elements": 3, "sheet_number": "A5.1"},
            },
            indent=2,
        ),
    },
    {
        "input": (
            "Extract all building elements from this window schedule:\n\n"
            "WINDOW SCHEDULE\n"
            "Mark | Width | Height | Type | Glazing | Frame\n"
            "W201 | 4'-0\" | 5'-0\" | Fixed | Double Low-E | Aluminum\n"
            "W202 | 3'-0\" | 4'-0\" | Casement | Double Low-E | Aluminum\n"
        ),
        "output": json.dumps(
            {
                "page_type": "window_schedule",
                "zone": "General",
                "elements": [
                    {
                        "category": "windows",
                        "tag": "W201",
                        "type": "Fixed",
                        "width": "4'-0\"",
                        "height": "5'-0\"",
                        "glazing": "Double Low-E",
                        "frame": "Aluminum",
                    },
                    {
                        "category": "windows",
                        "tag": "W202",
                        "type": "Casement",
                        "width": "3'-0\"",
                        "height": "4'-0\"",
                        "glazing": "Double Low-E",
                        "frame": "Aluminum",
                    },
                ],
                "metadata": {"total_elements": 2, "sheet_number": "A6.1"},
            },
            indent=2,
        ),
    },
    {
        "input": (
            "Extract all building elements from this room finish schedule:\n\n"
            "ROOM FINISH SCHEDULE - LEVEL 2\n"
            "Room # | Room Name | Floor | Base | North Wall | South Wall | Ceiling | Ceiling Ht\n"
            "201 | Office | VCT | Rubber | GWB-P | GWB-P | ACT | 9'-0\"\n"
            "202 | Conference | Carpet | Wood | GWB-P | GWB-WC | ACT | 9'-0\"\n"
            "203 | Restroom | CT | CT | CT | CT | GWB-P | 8'-0\"\n"
        ),
        "output": json.dumps(
            {
                "page_type": "room_finish_schedule",
                "zone": "Level 2",
                "elements": [
                    {
                        "category": "rooms",
                        "tag": "201",
                        "name": "Office",
                        "floor_finish": "VCT",
                        "base": "Rubber",
                        "wall_north": "GWB-P",
                        "wall_south": "GWB-P",
                        "ceiling": "ACT",
                        "ceiling_height": "9'-0\"",
                    },
                    {
                        "category": "rooms",
                        "tag": "202",
                        "name": "Conference",
                        "floor_finish": "Carpet",
                        "base": "Wood",
                        "wall_north": "GWB-P",
                        "wall_south": "GWB-WC",
                        "ceiling": "ACT",
                        "ceiling_height": "9'-0\"",
                    },
                    {
                        "category": "rooms",
                        "tag": "203",
                        "name": "Restroom",
                        "floor_finish": "CT",
                        "base": "CT",
                        "wall_north": "CT",
                        "wall_south": "CT",
                        "ceiling": "GWB-P",
                        "ceiling_height": "8'-0\"",
                    },
                ],
                "metadata": {"total_elements": 3, "sheet_number": "A7.1"},
            },
            indent=2,
        ),
    },
]

# System prompt that gets baked into the fine-tuned model's behavior.
# After fine-tuning, this can be shortened or removed, saving tokens per request.
SYSTEM_PROMPT = (
    "You are a construction document extraction assistant. "
    "Given a page from a construction document, extract all building elements "
    "into structured JSON. Include category, tag, type, dimensions, materials, "
    "and any other attributes present. Be precise with measurements and "
    "abbreviations. Output valid JSON only."
)


def prepare_dataset(data_dir: str) -> None:
    """
    Prepare training data in the format expected by TRL's SFTTrainer.

    Creates a JSONL file where each line is a conversation in the
    ChatML format that Mistral and most modern LLMs expect.

    In production, you would:
    1. Load your labeled construction documents from Label Studio export
    2. Convert each (document_page, extraction) pair into this format
    3. Split into train (80%), validation (10%), test (10%)
    """
    data_path = Path(data_dir)
    data_path.mkdir(parents=True, exist_ok=True)

    train_file = data_path / "train.jsonl"
    val_file = data_path / "val.jsonl"

    # In reality, you'd have 500-1000+ examples. This is a minimal demo.
    # WARNING: 3 examples is FAR too few for real fine-tuning.
    # You need at least 200 for any measurable improvement.
    examples = EXAMPLE_TRAINING_DATA

    # Convert to ChatML conversation format
    conversations = []
    for ex in examples:
        conv = {
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": ex["input"]},
                {"role": "assistant", "content": ex["output"]},
            ]
        }
        conversations.append(conv)

    # Write train split (in production: 80% of data)
    with open(train_file, "w") as f:
        for conv in conversations:
            f.write(json.dumps(conv) + "\n")

    # Write validation split (in production: 10% of data)
    # Here we reuse training data for demo purposes only.
    # NEVER do this in production — it defeats the purpose of validation.
    with open(val_file, "w") as f:
        for conv in conversations:
            f.write(json.dumps(conv) + "\n")

    print(f"Prepared {len(conversations)} training examples -> {train_file}")
    print(f"Prepared {len(conversations)} validation examples -> {val_file}")
    print()
    print("WARNING: This demo uses only 3 examples.")
    print("For real fine-tuning, you need 200-1000+ labeled examples.")
    print("See FINE_TUNING_GUIDE.md for data requirements.")


# ---------------------------------------------------------------------------
# 2. Training
# ---------------------------------------------------------------------------


def train(data_dir: str, output_dir: str = "./output/lexios-lora-adapter") -> None:
    """
    Fine-tune Mistral-7B with QLoRA for construction document extraction.

    This uses:
    - bitsandbytes: 4-bit quantization (NF4) to reduce memory from ~14GB to ~5GB
    - PEFT/LoRA: Only trains ~2% of parameters (rank-32 adapters)
    - TRL SFTTrainer: Handles ChatML formatting and training loop

    Total trainable params: ~67M out of 7B (~0.9%)
    Memory usage: ~12-16GB VRAM with QLoRA
    Training time: ~2-4 hours for 1000 examples on RTX 4090
    """
    import torch
    from datasets import load_dataset
    from peft import LoraConfig, TaskType, get_peft_model, prepare_model_for_kbit_training
    from transformers import (
        AutoModelForCausalLM,
        AutoTokenizer,
        BitsAndBytesConfig,
        TrainingArguments,
    )
    from trl import SFTTrainer

    # --- Model Selection ---
    # Mistral-7B-Instruct-v0.3 is a good balance of capability and cost.
    # Alternatives:
    #   - "Qwen/Qwen2.5-7B-Instruct" (Apache 2.0, strong structured output)
    #   - "meta-llama/Llama-3.1-8B-Instruct" (Llama license, largest ecosystem)
    #   - "mistralai/Mistral-Small-3.1-24B-Instruct-2503" (24B, better quality, needs more VRAM)
    model_name = "mistralai/Mistral-7B-Instruct-v0.3"

    print(f"Loading model: {model_name}")
    print(f"Training data: {data_dir}")
    print(f"Output: {output_dir}")

    # --- 4-bit Quantization Config ---
    # NF4 (NormalFloat4) is optimal for QLoRA — it's information-theoretically
    # optimal for normally distributed weights.
    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,  # Compute in bf16 for stability
        bnb_4bit_use_double_quant=True,  # Double quantization saves ~0.4 bits/param
    )

    # --- Load Model ---
    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        quantization_config=bnb_config,
        device_map="auto",  # Automatically place layers across available GPUs
        trust_remote_code=False,  # Don't execute arbitrary code from HuggingFace
        attn_implementation="flash_attention_2",  # Use FlashAttention-2 if available
    )

    # --- Load Tokenizer ---
    tokenizer = AutoTokenizer.from_pretrained(model_name)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
        tokenizer.pad_token_id = tokenizer.eos_token_id

    # --- Prepare for QLoRA Training ---
    model = prepare_model_for_kbit_training(model)

    # --- LoRA Configuration ---
    # r=32: Intermediate rank — good for domain-specific tasks where the model
    #        needs to learn new patterns (construction terminology, table formats).
    #        Use r=16 if you have <200 examples (less capacity = less overfitting).
    #        Use r=64 only if r=32 underperforms and you have >1000 examples.
    #
    # lora_alpha=64: Alpha = 2*r is a reliable default. The effective learning
    #                rate scales as alpha/r, so alpha=64, r=32 gives scale=2.
    #
    # target_modules: We adapt all linear layers in the attention and MLP blocks.
    #                 This is more expressive than just q/v projections and works
    #                 better for generation tasks.
    lora_config = LoraConfig(
        r=32,
        lora_alpha=64,
        lora_dropout=0.05,  # Light dropout — helps with small datasets
        target_modules=[
            "q_proj",
            "k_proj",
            "v_proj",
            "o_proj",
            "gate_proj",
            "up_proj",
            "down_proj",
        ],
        task_type=TaskType.CAUSAL_LM,
        bias="none",  # Don't train biases — negligible impact, saves memory
    )

    model = get_peft_model(model, lora_config)

    # Print trainable parameter count
    model.print_trainable_parameters()
    # Expected output: trainable params: ~67M || all params: ~7.2B || trainable: ~0.93%

    # --- Load Dataset ---
    dataset = load_dataset(
        "json",
        data_files={
            "train": os.path.join(data_dir, "train.jsonl"),
            "validation": os.path.join(data_dir, "val.jsonl"),
        },
    )

    # --- Training Arguments ---
    training_args = TrainingArguments(
        output_dir=output_dir,
        # --- Core Training ---
        num_train_epochs=3,  # 3 epochs for small dataset (<500 examples)
        per_device_train_batch_size=4,  # Fits in 24GB with QLoRA
        gradient_accumulation_steps=4,  # Effective batch size = 4 * 4 = 16
        # --- Learning Rate ---
        learning_rate=2e-4,  # Standard for LoRA — higher than full fine-tuning
        lr_scheduler_type="cosine",  # Cosine annealing works well for fine-tuning
        warmup_ratio=0.05,  # 5% warmup steps
        weight_decay=0.01,
        # --- Memory Optimization ---
        bf16=True,  # Use bfloat16 mixed precision
        gradient_checkpointing=True,  # Trade compute for memory
        optim="paged_adamw_8bit",  # 8-bit optimizer — saves ~2GB VRAM
        # --- Logging & Evaluation ---
        logging_steps=10,
        eval_strategy="steps",
        eval_steps=50,
        save_strategy="steps",
        save_steps=100,
        save_total_limit=3,  # Keep only last 3 checkpoints
        load_best_model_at_end=True,
        metric_for_best_model="eval_loss",
        greater_is_better=False,
        # --- Misc ---
        report_to="none",  # Set to "wandb" for experiment tracking
        dataloader_num_workers=4,
        seed=42,
        max_grad_norm=1.0,
    )

    # --- Trainer ---
    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        args=training_args,
        train_dataset=dataset["train"],
        eval_dataset=dataset["validation"],
        max_seq_length=4096,  # Construction tables can be long
    )

    # --- Train ---
    print("\nStarting training...")
    print(f"  Effective batch size: {training_args.per_device_train_batch_size * training_args.gradient_accumulation_steps}")
    print(f"  Learning rate: {training_args.learning_rate}")
    print(f"  LoRA rank: {lora_config.r}")
    print(f"  Epochs: {training_args.num_train_epochs}")
    print()

    train_result = trainer.train()

    # --- Save ---
    print(f"\nSaving adapter to {output_dir}")
    trainer.save_model(output_dir)
    tokenizer.save_pretrained(output_dir)

    # Save training metrics
    metrics = train_result.metrics
    metrics_file = os.path.join(output_dir, "training_metrics.json")
    with open(metrics_file, "w") as f:
        json.dump(metrics, f, indent=2)

    print(f"Training complete. Metrics saved to {metrics_file}")
    print(f"  Train loss: {metrics.get('train_loss', 'N/A'):.4f}")
    print(f"  Train runtime: {metrics.get('train_runtime', 0):.0f}s")


# ---------------------------------------------------------------------------
# 3. Evaluation
# ---------------------------------------------------------------------------


def evaluate_extraction(predicted: list[dict], ground_truth: list[dict]) -> dict[str, float]:
    """
    Compute element-level precision, recall, and F1 for construction extraction.

    Matches elements on (category, tag) pairs.
    This mirrors the Lexios eval.py methodology.
    """
    pred_keys = {(e.get("category", ""), e.get("tag", "")) for e in predicted}
    gt_keys = {(e.get("category", ""), e.get("tag", "")) for e in ground_truth}

    tp = len(pred_keys & gt_keys)
    fp = len(pred_keys - gt_keys)
    fn = len(gt_keys - pred_keys)

    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0

    return {
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "true_positives": tp,
        "false_positives": fp,
        "false_negatives": fn,
    }


def evaluate(data_dir: str, adapter_path: str) -> None:
    """
    Evaluate a fine-tuned model against the validation set.

    Loads the base model + LoRA adapter, runs inference on validation examples,
    and computes extraction F1 scores.
    """
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

    model_name = "mistralai/Mistral-7B-Instruct-v0.3"

    print(f"Loading base model: {model_name}")
    print(f"Loading adapter: {adapter_path}")

    # Load in 4-bit for evaluation too (saves memory)
    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
    )

    base_model = AutoModelForCausalLM.from_pretrained(
        model_name,
        quantization_config=bnb_config,
        device_map="auto",
    )

    model = PeftModel.from_pretrained(base_model, adapter_path)
    model.eval()

    tokenizer = AutoTokenizer.from_pretrained(adapter_path)

    # Load validation data
    val_file = os.path.join(data_dir, "val.jsonl")
    with open(val_file) as f:
        val_examples = [json.loads(line) for line in f]

    results = []
    for i, example in enumerate(val_examples):
        messages = example["messages"]
        user_msg = next(m["content"] for m in messages if m["role"] == "user")
        expected = next(m["content"] for m in messages if m["role"] == "assistant")

        # Format as chat
        prompt = tokenizer.apply_chat_template(
            [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            tokenize=False,
            add_generation_prompt=True,
        )

        inputs = tokenizer(prompt, return_tensors="pt").to(model.device)

        with torch.no_grad():
            outputs = model.generate(
                **inputs,
                max_new_tokens=2048,
                do_sample=False,  # Greedy decoding for evaluation
                temperature=1.0,
                pad_token_id=tokenizer.pad_token_id,
            )

        # Decode only the generated tokens
        generated = tokenizer.decode(
            outputs[0][inputs["input_ids"].shape[1] :],
            skip_special_tokens=True,
        )

        # Parse and compare
        try:
            pred_json = json.loads(generated)
            expected_json = json.loads(expected)

            pred_elements = pred_json.get("elements", [])
            expected_elements = expected_json.get("elements", [])

            metrics = evaluate_extraction(pred_elements, expected_elements)
            metrics["example_id"] = i
            metrics["valid_json"] = True
            results.append(metrics)

            print(f"  Example {i}: F1={metrics['f1']:.3f} "
                  f"(P={metrics['precision']:.3f}, R={metrics['recall']:.3f})")
        except json.JSONDecodeError:
            results.append({
                "example_id": i,
                "valid_json": False,
                "f1": 0.0,
                "precision": 0.0,
                "recall": 0.0,
            })
            print(f"  Example {i}: INVALID JSON output")

    # Aggregate metrics
    valid_results = [r for r in results if r.get("valid_json", False)]
    if valid_results:
        avg_f1 = sum(r["f1"] for r in valid_results) / len(valid_results)
        avg_precision = sum(r["precision"] for r in valid_results) / len(valid_results)
        avg_recall = sum(r["recall"] for r in valid_results) / len(valid_results)
        json_error_rate = 1 - len(valid_results) / len(results)

        print(f"\n--- Evaluation Summary ---")
        print(f"  Examples evaluated: {len(results)}")
        print(f"  Valid JSON outputs: {len(valid_results)}/{len(results)}")
        print(f"  JSON error rate: {json_error_rate:.1%}")
        print(f"  Average F1: {avg_f1:.4f}")
        print(f"  Average Precision: {avg_precision:.4f}")
        print(f"  Average Recall: {avg_recall:.4f}")

        # Save results
        eval_output = os.path.join(adapter_path, "eval_results.json")
        with open(eval_output, "w") as f:
            json.dump(
                {
                    "summary": {
                        "avg_f1": avg_f1,
                        "avg_precision": avg_precision,
                        "avg_recall": avg_recall,
                        "json_error_rate": json_error_rate,
                        "n_examples": len(results),
                    },
                    "per_example": results,
                },
                f,
                indent=2,
            )
        print(f"  Results saved to {eval_output}")
    else:
        print("\nNo valid results to aggregate.")


# ---------------------------------------------------------------------------
# 4. Inference
# ---------------------------------------------------------------------------


def infer(adapter_path: str, input_text: str | None = None) -> dict[str, Any]:
    """
    Run inference with the fine-tuned model.

    In production, you would serve this with vLLM:
        vllm serve mistralai/Mistral-7B-v0.3 \
            --enable-lora \
            --lora-modules lexios=./output/lexios-lora-adapter

    This function is for testing/debugging.
    """
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

    model_name = "mistralai/Mistral-7B-Instruct-v0.3"

    if input_text is None:
        input_text = (
            "Extract all building elements from this equipment schedule:\n\n"
            "MECHANICAL EQUIPMENT SCHEDULE\n"
            "Tag | Description | CFM | HP | Voltage\n"
            "AHU-1 | Air Handling Unit | 5000 | 7.5 | 480/3/60\n"
            "EF-1 | Exhaust Fan | 2000 | 1.5 | 120/1/60\n"
        )

    print(f"Loading model with adapter from {adapter_path}")

    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
    )

    base_model = AutoModelForCausalLM.from_pretrained(
        model_name,
        quantization_config=bnb_config,
        device_map="auto",
    )

    model = PeftModel.from_pretrained(base_model, adapter_path)
    model.eval()

    tokenizer = AutoTokenizer.from_pretrained(adapter_path)

    prompt = tokenizer.apply_chat_template(
        [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": input_text},
        ],
        tokenize=False,
        add_generation_prompt=True,
    )

    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)

    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            max_new_tokens=2048,
            do_sample=False,
            temperature=1.0,
            pad_token_id=tokenizer.pad_token_id,
        )

    generated = tokenizer.decode(
        outputs[0][inputs["input_ids"].shape[1] :],
        skip_special_tokens=True,
    )

    print("\n--- Input ---")
    print(input_text)
    print("\n--- Model Output ---")
    print(generated)

    try:
        result = json.loads(generated)
        print("\n--- Parsed JSON (valid) ---")
        print(json.dumps(result, indent=2))
        return result
    except json.JSONDecodeError:
        print("\n--- WARNING: Output is not valid JSON ---")
        return {"raw_output": generated, "valid_json": False}


# ---------------------------------------------------------------------------
# 5. Main
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fine-tune a model for construction document extraction",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Step 1: Prepare dataset
  python fine_tune_example.py --mode prepare --data-dir ./data/lexios-train

  # Step 2: Train (requires GPU)
  python fine_tune_example.py --mode train --data-dir ./data/lexios-train

  # Step 3: Evaluate
  python fine_tune_example.py --mode eval --data-dir ./data/lexios-train \\
      --adapter-path ./output/lexios-lora-adapter

  # Step 4: Inference
  python fine_tune_example.py --mode infer \\
      --adapter-path ./output/lexios-lora-adapter
        """,
    )

    parser.add_argument(
        "--mode",
        choices=["prepare", "train", "eval", "infer"],
        required=True,
        help="Operation mode",
    )
    parser.add_argument(
        "--data-dir",
        default="./data/lexios-train",
        help="Directory for training data (default: ./data/lexios-train)",
    )
    parser.add_argument(
        "--adapter-path",
        default="./output/lexios-lora-adapter",
        help="Path to LoRA adapter (default: ./output/lexios-lora-adapter)",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Output directory for trained adapter (default: same as --adapter-path)",
    )

    args = parser.parse_args()
    output_dir = args.output_dir or args.adapter_path

    if args.mode == "prepare":
        prepare_dataset(args.data_dir)
    elif args.mode == "train":
        train(args.data_dir, output_dir)
    elif args.mode == "eval":
        evaluate(args.data_dir, args.adapter_path)
    elif args.mode == "infer":
        infer(args.adapter_path)


if __name__ == "__main__":
    main()
