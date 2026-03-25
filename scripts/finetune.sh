#!/bin/bash
# AlphaPolyBot MLX Fine-Tuning Pipeline
#
# Single command to: prepare data → QLoRA fine-tune → export to Ollama → validate
#
# Usage:
#   bash scripts/finetune.sh                         # Full pipeline
#   RESUME=1 bash scripts/finetune.sh                # Resume interrupted training
#   BASE_MODEL=my/model bash scripts/finetune.sh     # Custom base model
#   DATA_FILE=custom.jsonl bash scripts/finetune.sh   # Custom training data
#   MODEL_NAME=polytrader-v3 bash scripts/finetune.sh # Custom output model name
#
# Requirements: Python 3.10+, Apple Silicon Mac, ~15GB free disk space
# Install deps: pip3 install -r scripts/requirements-finetune.txt

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TRAINING_DIR="$PROJECT_DIR/training"

# Configurable via env vars
BASE_MODEL="${BASE_MODEL:-mlx-community/Meta-Llama-3.1-8B-Instruct-4bit}"
DATA_FILE="${DATA_FILE:-}"
MODEL_NAME="${MODEL_NAME:-polytrader-v2}"
RESUME="${RESUME:-}"
SKIP_VALIDATE="${SKIP_VALIDATE:-}"
ITERS="${ITERS:-1500}"
BATCH_SIZE="${BATCH_SIZE:-2}"

echo "======================================================"
echo "  AlphaPolyBot MLX Fine-Tuning Pipeline"
echo "======================================================"
echo ""
echo "Base model:    $BASE_MODEL"
echo "Model name:    $MODEL_NAME"
echo "Iterations:    $ITERS"
echo "Batch size:    $BATCH_SIZE"
echo "Resume:        ${RESUME:-no}"
echo ""

# ----- Step 0: Check Python + MLX dependencies -----
echo "=== Step 0: Checking dependencies ==="

if ! command -v python3 &> /dev/null; then
    echo "Error: python3 not found"
    exit 1
fi

python3 -c "import mlx_lm" 2>/dev/null || {
    echo "MLX not installed. Installing dependencies..."
    pip3 install -r "$SCRIPT_DIR/requirements-finetune.txt"
}

# Check disk space
AVAILABLE_GB=$(python3 -c "import os; s = os.statvfs('$PROJECT_DIR'); print(f'{(s.f_bavail * s.f_frsize) / (1024**3):.1f}')")
echo "Disk space: ${AVAILABLE_GB}GB available"
if python3 -c "exit(0 if float('$AVAILABLE_GB') >= 15 else 1)" 2>/dev/null; then
    echo "  OK"
else
    echo "  Warning: <15GB free. Pipeline needs ~15GB for base model + GGUF artifacts."
    read -p "  Continue anyway? [y/N] " -n 1 -r
    echo
    [[ $REPLY =~ ^[Yy]$ ]] || exit 1
fi
echo ""

# ----- Step 1: Prepare training data -----
echo "=== Step 1: Preparing training data ==="

PREP_ARGS=("--output-dir" "$TRAINING_DIR")
if [ -n "$DATA_FILE" ]; then
    PREP_ARGS+=("--input" "$DATA_FILE")
fi

python3 "$SCRIPT_DIR/prepare-training-data.py" "${PREP_ARGS[@]}"
echo ""

# ----- Step 2: Fine-tune with MLX QLoRA -----
echo "=== Step 2: Running LoRA fine-tuning ==="
echo "  This will take ~30-60 minutes on Apple Silicon."
echo ""

FINETUNE_ARGS=(
    "--base-model" "$BASE_MODEL"
    "--data-dir" "$TRAINING_DIR"
    "--output-dir" "$TRAINING_DIR/adapters"
    "--iters" "$ITERS"
    "--batch-size" "$BATCH_SIZE"
)

if [ -n "$RESUME" ]; then
    FINETUNE_ARGS+=("--resume")
fi

python3 "$SCRIPT_DIR/finetune-mlx.py" "${FINETUNE_ARGS[@]}"
echo ""

# ----- Step 3: Export to Ollama -----
echo "=== Step 3: Exporting to Ollama ==="

BASE_MODEL="$BASE_MODEL" \
TRAINING_DIR="$TRAINING_DIR" \
ADAPTER_DIR="$TRAINING_DIR/adapters" \
FUSED_DIR="$TRAINING_DIR/fused" \
bash "$SCRIPT_DIR/export-to-ollama.sh" "$MODEL_NAME"
echo ""

# ----- Step 4: Validate -----
if [ -z "$SKIP_VALIDATE" ]; then
    echo "=== Step 4: Validating model ==="
    python3 "$SCRIPT_DIR/validate-model.py" \
        --new-model "$MODEL_NAME" \
        --only-new
    echo ""
else
    echo "=== Step 4: Validation skipped ==="
    echo ""
fi

# ----- Done -----
echo "======================================================"
echo "  Fine-tuning complete!"
echo "======================================================"
echo ""
echo "  Model: $MODEL_NAME"
echo "  Test:  ollama run $MODEL_NAME 'Predict: Will BTC be above \$100k tomorrow? YES=62c NO=38c'"
echo "  Use:   Settings → LLM → Model Name → $MODEL_NAME"
echo ""
echo "  To compare with baseline:"
echo "    python3 scripts/validate-model.py --old-model polytrader --new-model $MODEL_NAME"
echo ""
