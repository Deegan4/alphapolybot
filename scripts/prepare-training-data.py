#!/usr/bin/env python3
"""
Prepare training data for MLX LoRA fine-tuning.

Reads ChatML JSONL, validates format, splits 90/10 into train/valid sets.
Output goes to training/train.jsonl and training/valid.jsonl.

Usage:
    python scripts/prepare-training-data.py
    python scripts/prepare-training-data.py --input polytrader-training-2026-03-16.jsonl
    python scripts/prepare-training-data.py --input data.jsonl --output-dir training/
"""

import argparse
import glob
import json
import os
import random
import sys
from collections import Counter
from pathlib import Path

REQUIRED_ROLES = {"system", "user", "assistant"}

# Known assistant response schemas
SIGNAL_CONFIRM_KEYS = {"confirm", "confidence_adjustment", "reasoning"}
DIRECTION_KEYS = {"direction", "confidence", "reasoning"}
MARKET_KEYS = {"prediction", "confidence", "reasoning"}


def find_latest_training_file(project_dir: str) -> str | None:
    pattern = os.path.join(project_dir, "polytrader-training-*.jsonl")
    files = sorted(glob.glob(pattern), reverse=True)
    return files[0] if files else None


def detect_prompt_type(assistant_content: dict) -> str:
    keys = set(assistant_content.keys())
    if "confirm" in keys:
        return "signal-confirmation"
    elif "direction" in keys:
        return "direction"
    elif "prediction" in keys:
        return "market"
    return "unknown"


def validate_line(line_num: int, line: str) -> tuple[dict | None, list[str]]:
    errors = []

    try:
        data = json.loads(line)
    except json.JSONDecodeError as e:
        return None, [f"Line {line_num}: Invalid JSON: {e}"]

    if "messages" not in data:
        return None, [f"Line {line_num}: Missing 'messages' key"]

    messages = data["messages"]
    if not isinstance(messages, list) or len(messages) < 2:
        return None, [f"Line {line_num}: 'messages' must be an array with at least 2 elements"]

    roles = {m.get("role") for m in messages}
    missing = REQUIRED_ROLES - roles
    if missing:
        errors.append(f"Line {line_num}: Missing roles: {missing}")

    # Validate assistant response is parseable JSON
    for msg in messages:
        if msg.get("role") == "assistant":
            content = msg.get("content", "")
            try:
                parsed = json.loads(content)
                if not isinstance(parsed, dict):
                    errors.append(f"Line {line_num}: Assistant content is not a JSON object")
            except json.JSONDecodeError:
                errors.append(f"Line {line_num}: Assistant content is not valid JSON")

    return data, errors


def main():
    parser = argparse.ArgumentParser(description="Prepare training data for MLX fine-tuning")
    parser.add_argument("--input", "-i", help="Input JSONL file (default: most recent polytrader-training-*.jsonl)")
    parser.add_argument("--output-dir", "-o", default="training", help="Output directory (default: training/)")
    parser.add_argument("--split", type=float, default=0.9, help="Train/valid split ratio (default: 0.9)")
    parser.add_argument("--seed", type=int, default=42, help="Random seed (default: 42)")
    args = parser.parse_args()

    project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    # Find input file
    input_file = args.input
    if not input_file:
        input_file = find_latest_training_file(project_dir)
        if not input_file:
            print("Error: No polytrader-training-*.jsonl file found. Specify --input.", file=sys.stderr)
            sys.exit(1)

    if not os.path.isabs(input_file):
        input_file = os.path.join(project_dir, input_file)

    if not os.path.exists(input_file):
        print(f"Error: File not found: {input_file}", file=sys.stderr)
        sys.exit(1)

    print(f"Input: {input_file}")

    # Read and validate
    records = []
    all_errors = []
    prompt_types = Counter()

    with open(input_file, "r") as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            data, errors = validate_line(i, line)
            all_errors.extend(errors)
            if data:
                # Detect prompt type from assistant response
                for msg in data["messages"]:
                    if msg["role"] == "assistant":
                        try:
                            parsed = json.loads(msg["content"])
                            ptype = detect_prompt_type(parsed)
                            prompt_types[ptype] += 1
                        except (json.JSONDecodeError, AttributeError):
                            prompt_types["invalid"] += 1
                records.append(data)

    if all_errors:
        print(f"\nValidation errors ({len(all_errors)}):", file=sys.stderr)
        for err in all_errors[:20]:
            print(f"  {err}", file=sys.stderr)
        if len(all_errors) > 20:
            print(f"  ... and {len(all_errors) - 20} more", file=sys.stderr)

    if not records:
        print("Error: No valid records found.", file=sys.stderr)
        sys.exit(1)

    # Count confirm/veto for signal-confirmation type
    confirm_count = 0
    veto_count = 0
    for rec in records:
        for msg in rec["messages"]:
            if msg["role"] == "assistant":
                try:
                    parsed = json.loads(msg["content"])
                    if "confirm" in parsed:
                        if parsed["confirm"]:
                            confirm_count += 1
                        else:
                            veto_count += 1
                except (json.JSONDecodeError, KeyError):
                    pass

    # Shuffle and split
    random.seed(args.seed)
    random.shuffle(records)

    split_idx = int(len(records) * args.split)
    train_records = records[:split_idx]
    valid_records = records[split_idx:]

    # Create output directory
    output_dir = args.output_dir
    if not os.path.isabs(output_dir):
        output_dir = os.path.join(project_dir, output_dir)
    os.makedirs(output_dir, exist_ok=True)

    # Write files
    train_path = os.path.join(output_dir, "train.jsonl")
    valid_path = os.path.join(output_dir, "valid.jsonl")

    with open(train_path, "w") as f:
        for rec in train_records:
            f.write(json.dumps(rec) + "\n")

    with open(valid_path, "w") as f:
        for rec in valid_records:
            f.write(json.dumps(rec) + "\n")

    # Print stats
    print(f"\n{'=' * 50}")
    print(f"Training Data Preparation Complete")
    print(f"{'=' * 50}")
    print(f"Total records:    {len(records)}")
    print(f"Train set:        {len(train_records)} ({args.split * 100:.0f}%)")
    print(f"Valid set:        {len(valid_records)} ({(1 - args.split) * 100:.0f}%)")
    print(f"Validation errors: {len(all_errors)}")
    print(f"\nBy prompt type:")
    for ptype, count in prompt_types.most_common():
        print(f"  {ptype}: {count}")
    if confirm_count + veto_count > 0:
        total_signals = confirm_count + veto_count
        print(f"\nSignal confirmation breakdown:")
        print(f"  Confirm: {confirm_count} ({confirm_count / total_signals * 100:.1f}%)")
        print(f"  Veto:    {veto_count} ({veto_count / total_signals * 100:.1f}%)")
    print(f"\nOutput:")
    print(f"  {train_path}")
    print(f"  {valid_path}")


if __name__ == "__main__":
    main()
