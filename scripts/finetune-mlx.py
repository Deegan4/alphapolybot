#!/usr/bin/env python3
"""
MLX QLoRA fine-tuning for AlphaPolyBot's Polymarket trading model.

Runs LoRA fine-tuning on a 4-bit quantized LLaMA 3.1 8B model using MLX.
Designed for Apple Silicon Macs with 16GB RAM (~6-8GB peak usage).

Usage:
    python scripts/finetune-mlx.py
    python scripts/finetune-mlx.py --base-model mlx-community/Meta-Llama-3.1-8B-Instruct-4bit
    python scripts/finetune-mlx.py --iters 2000 --batch-size 1 --resume
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path


DEFAULT_BASE_MODEL = "mlx-community/Meta-Llama-3.1-8B-Instruct-4bit"
DEFAULT_ITERS = 1500
DEFAULT_BATCH_SIZE = 2
DEFAULT_LORA_RANK = 8
DEFAULT_LORA_LAYERS = 16
DEFAULT_LR = 1e-5


def check_dependencies():
    """Verify MLX is installed."""
    try:
        import mlx
        import mlx_lm
        print(f"MLX version: {mlx.__version__}")
        return True
    except ImportError:
        print("Error: MLX not installed. Run:", file=sys.stderr)
        print("  pip3 install -r scripts/requirements-finetune.txt", file=sys.stderr)
        return False


def check_disk_space(path: str, required_gb: float = 15.0) -> bool:
    """Warn if insufficient disk space for model download + training."""
    stat = os.statvfs(path)
    available_gb = (stat.f_bavail * stat.f_frsize) / (1024 ** 3)
    if available_gb < required_gb:
        print(f"Warning: Only {available_gb:.1f}GB free. Fine-tuning needs ~{required_gb:.0f}GB for:", file=sys.stderr)
        print(f"  - Base model download (~4-8GB)", file=sys.stderr)
        print(f"  - LoRA adapters (~100MB)", file=sys.stderr)
        print(f"  - Fused model (~8GB, during export)", file=sys.stderr)
        return False
    print(f"Disk space: {available_gb:.1f}GB available (need ~{required_gb:.0f}GB)")
    return True


def check_training_data(data_dir: str) -> bool:
    """Verify train.jsonl and valid.jsonl exist."""
    train_path = os.path.join(data_dir, "train.jsonl")
    valid_path = os.path.join(data_dir, "valid.jsonl")

    if not os.path.exists(train_path):
        print(f"Error: {train_path} not found. Run prepare-training-data.py first.", file=sys.stderr)
        return False

    if not os.path.exists(valid_path):
        print(f"Error: {valid_path} not found. Run prepare-training-data.py first.", file=sys.stderr)
        return False

    # Count lines
    with open(train_path) as f:
        train_count = sum(1 for line in f if line.strip())
    with open(valid_path) as f:
        valid_count = sum(1 for line in f if line.strip())

    print(f"Training data: {train_count} train, {valid_count} valid samples")

    if train_count < 50:
        print(f"Warning: Only {train_count} training samples. Recommend 200+ for meaningful fine-tuning.", file=sys.stderr)

    return True


def sanity_check_base_model(model_path: str) -> bool:
    """Generate a test response from the base model to verify it works."""
    print("\nSanity check: generating test response from base model...")
    try:
        from mlx_lm import load, generate

        model, tokenizer = load(model_path)

        test_prompt = 'Predict this market outcome. Respond ONLY with JSON.\n\nQ: "Will BTC be above $100k tomorrow?"\n- Yes: 62%\n- No: 38%\n\n{"prediction":"yes|no","confidence":0-100,"reasoning":"1 sentence"}'

        messages = [
            {"role": "system", "content": "You are a quantitative trading analyst. Output ONLY valid JSON."},
            {"role": "user", "content": test_prompt},
        ]

        prompt = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        response = generate(model, tokenizer, prompt=prompt, max_tokens=128, temp=0.15)

        print(f"  Base model response: {response[:200]}")

        # Try to parse as JSON
        try:
            parsed = json.loads(response.strip())
            print(f"  Valid JSON output: {list(parsed.keys())}")
            return True
        except json.JSONDecodeError:
            print("  Warning: Base model did not produce valid JSON. Training will teach it the format.")
            return True  # Still proceed — that's what training is for

    except Exception as e:
        print(f"  Sanity check failed: {e}", file=sys.stderr)
        print("  Proceeding with training anyway...", file=sys.stderr)
        return True


def run_lora_training(
    base_model: str,
    data_dir: str,
    output_dir: str,
    iters: int,
    batch_size: int,
    lora_rank: int,
    lora_layers: int,
    learning_rate: float,
    resume: bool,
) -> bool:
    """Run MLX LoRA fine-tuning via CLI."""

    cmd = [
        sys.executable, "-m", "mlx_lm.lora",
        "--model", base_model,
        "--data", data_dir,
        "--train",
        "--batch-size", str(batch_size),
        "--lora-layers", str(lora_layers),
        "--lora-rank", str(lora_rank),
        "--iters", str(iters),
        "--learning-rate", str(learning_rate),
        "--adapter-path", output_dir,
        "--val-batches", "25",
        "--steps-per-eval", "100",
        "--steps-per-report", "10",
        "--save-every", "500",
    ]

    if resume and os.path.exists(os.path.join(output_dir, "adapters.safetensors")):
        cmd.append("--resume-adapter-file")
        cmd.append(os.path.join(output_dir, "adapters.safetensors"))
        print(f"Resuming from checkpoint in {output_dir}")

    print(f"\nRunning: {' '.join(cmd)}\n")
    start_time = time.time()

    result = subprocess.run(cmd, cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

    elapsed = time.time() - start_time
    minutes = elapsed / 60

    if result.returncode == 0:
        print(f"\nTraining completed in {minutes:.1f} minutes")
        adapter_path = os.path.join(output_dir, "adapters.safetensors")
        if os.path.exists(adapter_path):
            size_mb = os.path.getsize(adapter_path) / (1024 * 1024)
            print(f"Adapter size: {size_mb:.1f}MB")
        return True
    else:
        print(f"\nTraining failed after {minutes:.1f} minutes (exit code {result.returncode})", file=sys.stderr)
        return False


def main():
    parser = argparse.ArgumentParser(description="MLX QLoRA fine-tuning for AlphaPolyBot")
    parser.add_argument("--base-model", default=DEFAULT_BASE_MODEL,
                        help=f"HuggingFace model ID or local path (default: {DEFAULT_BASE_MODEL})")
    parser.add_argument("--data-dir", default="training",
                        help="Directory with train.jsonl/valid.jsonl (default: training/)")
    parser.add_argument("--output-dir", default="training/adapters",
                        help="Output directory for LoRA adapters (default: training/adapters/)")
    parser.add_argument("--iters", type=int, default=DEFAULT_ITERS,
                        help=f"Training iterations (default: {DEFAULT_ITERS})")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE,
                        help=f"Batch size (default: {DEFAULT_BATCH_SIZE}, use 1 if OOM)")
    parser.add_argument("--lora-rank", type=int, default=DEFAULT_LORA_RANK,
                        help=f"LoRA rank (default: {DEFAULT_LORA_RANK})")
    parser.add_argument("--lora-layers", type=int, default=DEFAULT_LORA_LAYERS,
                        help=f"Number of LoRA layers (default: {DEFAULT_LORA_LAYERS})")
    parser.add_argument("--learning-rate", type=float, default=DEFAULT_LR,
                        help=f"Learning rate (default: {DEFAULT_LR})")
    parser.add_argument("--resume", action="store_true",
                        help="Resume training from existing checkpoint")
    parser.add_argument("--skip-sanity-check", action="store_true",
                        help="Skip base model sanity check")
    args = parser.parse_args()

    project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    # Resolve relative paths
    data_dir = args.data_dir if os.path.isabs(args.data_dir) else os.path.join(project_dir, args.data_dir)
    output_dir = args.output_dir if os.path.isabs(args.output_dir) else os.path.join(project_dir, args.output_dir)

    print("=" * 50)
    print("AlphaPolyBot MLX QLoRA Fine-Tuning")
    print("=" * 50)
    print(f"Base model:    {args.base_model}")
    print(f"Data dir:      {data_dir}")
    print(f"Output dir:    {output_dir}")
    print(f"Iterations:    {args.iters}")
    print(f"Batch size:    {args.batch_size}")
    print(f"LoRA rank:     {args.lora_rank}")
    print(f"LoRA layers:   {args.lora_layers}")
    print(f"Learning rate: {args.learning_rate}")
    print(f"Resume:        {args.resume}")

    # Pre-flight checks
    if not check_dependencies():
        sys.exit(1)

    check_disk_space(project_dir)

    if not check_training_data(data_dir):
        sys.exit(1)

    # Create output directory
    os.makedirs(output_dir, exist_ok=True)

    # Sanity check base model
    if not args.skip_sanity_check and not args.resume:
        sanity_check_base_model(args.base_model)

    # Run training
    success = run_lora_training(
        base_model=args.base_model,
        data_dir=data_dir,
        output_dir=output_dir,
        iters=args.iters,
        batch_size=args.batch_size,
        lora_rank=args.lora_rank,
        lora_layers=args.lora_layers,
        learning_rate=args.learning_rate,
        resume=args.resume,
    )

    if success:
        print(f"\nNext step: bash scripts/export-to-ollama.sh")
    else:
        print(f"\nTraining failed. Try --batch-size 1 if OOM, or --resume to continue from checkpoint.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
