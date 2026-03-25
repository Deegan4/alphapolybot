#!/bin/bash
# Export fine-tuned MLX model to Ollama as polytrader-v2.
#
# Steps: fuse LoRA adapter → convert to GGUF → quantize → ollama create
#
# Usage:
#   bash scripts/export-to-ollama.sh
#   bash scripts/export-to-ollama.sh --model-name polytrader-v3
#
# Requires: mlx-lm, llama.cpp (auto-cloned if missing)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TRAINING_DIR="${TRAINING_DIR:-$PROJECT_DIR/training}"
ADAPTER_DIR="${ADAPTER_DIR:-$TRAINING_DIR/adapters}"
FUSED_DIR="${FUSED_DIR:-$TRAINING_DIR/fused}"
BASE_MODEL="${BASE_MODEL:-mlx-community/Meta-Llama-3.1-8B-Instruct-4bit}"
MODEL_NAME="${1:-polytrader-v2}"
LLAMA_CPP_DIR="${LLAMA_CPP_DIR:-$PROJECT_DIR/llama.cpp}"
QUANTIZE_TYPE="${QUANTIZE_TYPE:-Q5_K_M}"

echo "=============================================="
echo "Export to Ollama: $MODEL_NAME"
echo "=============================================="
echo "Base model:   $BASE_MODEL"
echo "Adapter dir:  $ADAPTER_DIR"
echo "Fused dir:    $FUSED_DIR"
echo "Quantize:     $QUANTIZE_TYPE"
echo ""

# ----- Step 0: Verify adapter exists -----
if [ ! -f "$ADAPTER_DIR/adapters.safetensors" ]; then
    echo "Error: No adapter found at $ADAPTER_DIR/adapters.safetensors"
    echo "Run finetune-mlx.py first."
    exit 1
fi

# ----- Step 1: Fuse adapter with base model -----
echo "=== Step 1: Fusing LoRA adapter with base model ==="
python3 -m mlx_lm.fuse \
    --model "$BASE_MODEL" \
    --adapter-path "$ADAPTER_DIR" \
    --save-path "$FUSED_DIR" \
    --de-quantize

echo "Fused model saved to $FUSED_DIR"
echo ""

# ----- Step 2: Get llama.cpp for GGUF conversion -----
echo "=== Step 2: Checking llama.cpp ==="

# Look for convert script in common locations
CONVERT_SCRIPT=""
if [ -f "$LLAMA_CPP_DIR/convert_hf_to_gguf.py" ]; then
    CONVERT_SCRIPT="$LLAMA_CPP_DIR/convert_hf_to_gguf.py"
elif command -v convert_hf_to_gguf &> /dev/null; then
    CONVERT_SCRIPT="convert_hf_to_gguf"
else
    echo "llama.cpp not found. Cloning..."
    git clone --depth 1 https://github.com/ggerganov/llama.cpp.git "$LLAMA_CPP_DIR"
    CONVERT_SCRIPT="$LLAMA_CPP_DIR/convert_hf_to_gguf.py"

    # Install conversion dependencies
    pip3 install -q gguf sentencepiece protobuf

    # Build quantize tool
    echo "Building llama.cpp quantize tool..."
    cd "$LLAMA_CPP_DIR"
    cmake -B build
    cmake --build build --target llama-quantize -j "$(sysctl -n hw.ncpu)"
    cd "$PROJECT_DIR"
fi

echo "Using convert script: $CONVERT_SCRIPT"
echo ""

# ----- Step 3: Convert to GGUF (f16) -----
echo "=== Step 3: Converting to GGUF (f16) ==="
GGUF_F16="$TRAINING_DIR/${MODEL_NAME}-f16.gguf"

python3 "$CONVERT_SCRIPT" "$FUSED_DIR" \
    --outfile "$GGUF_F16" \
    --outtype f16

echo "F16 GGUF: $GGUF_F16 ($(du -h "$GGUF_F16" | cut -f1))"
echo ""

# ----- Step 4: Quantize -----
echo "=== Step 4: Quantizing to $QUANTIZE_TYPE ==="
GGUF_QUANTIZED="$TRAINING_DIR/${MODEL_NAME}-${QUANTIZE_TYPE,,}.gguf"

# Find quantize binary
QUANTIZE_BIN=""
if [ -f "$LLAMA_CPP_DIR/build/bin/llama-quantize" ]; then
    QUANTIZE_BIN="$LLAMA_CPP_DIR/build/bin/llama-quantize"
elif command -v llama-quantize &> /dev/null; then
    QUANTIZE_BIN="llama-quantize"
else
    echo "Error: llama-quantize not found. Build llama.cpp first:"
    echo "  cd $LLAMA_CPP_DIR && cmake -B build && cmake --build build --target llama-quantize"
    exit 1
fi

"$QUANTIZE_BIN" "$GGUF_F16" "$GGUF_QUANTIZED" "$QUANTIZE_TYPE"

echo "Quantized GGUF: $GGUF_QUANTIZED ($(du -h "$GGUF_QUANTIZED" | cut -f1))"
echo ""

# ----- Step 5: Generate Modelfile -----
echo "=== Step 5: Generating Modelfile ==="
MODELFILE="$TRAINING_DIR/Modelfile.${MODEL_NAME}"

cat > "$MODELFILE" << 'MODELFILE_EOF'
# AlphaPolyBot — Fine-tuned Polymarket Trading LLM
#
# Fine-tuned with MLX QLoRA on 1,740+ synthetic + live trading pairs.
# Base: LLaMA 3.1 8B Instruct, quantized Q5_K_M.
#
# Build:  ollama create MODEL_NAME_PLACEHOLDER -f THIS_FILE
# Test:   ollama run MODEL_NAME_PLACEHOLDER "Predict: Will BTC be above $100k tomorrow? YES=62c NO=38c"

FROM GGUF_PATH_PLACEHOLDER

PARAMETER temperature 0.15
PARAMETER top_p 0.85
PARAMETER num_predict 256
PARAMETER repeat_penalty 1.1

TEMPLATE """<|start_header_id|>system<|end_header_id|>

{{ .System }}<|eot_id|><|start_header_id|>user<|end_header_id|>

{{ .Prompt }}<|eot_id|><|start_header_id|>assistant<|end_header_id|>

{{ .Response }}<|eot_id|>"""

PARAMETER stop <|start_header_id|>
PARAMETER stop <|eot_id|>
PARAMETER stop <|end_header_id|>
PARAMETER stop <|end_of_text|>

SYSTEM """
You are a quantitative trading analyst for Polymarket prediction markets.
You output ONLY valid JSON — no markdown, no explanation, no preamble.

## YOUR ROLE
You analyze binary outcome markets (YES/NO) on Polymarket and produce
calibrated probability estimates. You are one input in an automated
trading pipeline — your output directly drives real-money trades.

## POLYMARKET MECHANICS
- Binary markets: YES + NO prices sum to ~$1.00
- Prices ARE implied probabilities (e.g., YES at 65¢ = market thinks 65% likely)
- You profit by buying underpriced outcomes (your estimate > market price)
- Maker orders (GTC/GTD limit orders) pay 0% fees
- A 65¢ YES outcome pays $1.00 if correct → 54% return minus fees
- Edge = (your probability - market price). Need >3% edge to overcome fees.

## CALIBRATION RULES (CRITICAL)
Your confidence MUST reflect actual probability, not conviction strength.
- 60% confidence = you expect this outcome 60% of the time
- 80% confidence = you expect this outcome 80% of the time
- NEVER output >85% unless the outcome is virtually certain
- NEVER output <20% — just predict the other side instead
- When uncertain, output 45-55% (close to the market's own estimate)
- Small models like you tend to be OVERCONFIDENT — bias toward 50% when unsure

## WHAT MAKES A GOOD PREDICTION
Strong evidence for high confidence:
- Clear factual resolution criteria + known facts that determine outcome
- Overwhelming consensus from multiple independent sources
- Mathematical/logical near-certainty

Weak evidence (keep confidence 45-60%):
- "Momentum" or "trend" arguments without structural basis
- Extrapolating from small samples
- Markets far from resolution date
- Crypto price direction (inherently noisy)

## CRYPTO-SPECIFIC RULES
For BTC/ETH/SOL price prediction markets:
- 15-minute windows are nearly random — confidence should be 48-58%
- 1-hour windows: slight edge possible from momentum — confidence 50-65%
- Daily windows: more signal available — confidence 50-75%
- High volatility regimes = LOWER confidence, not higher
- Displacement (current vs open price) is the strongest short-term signal
- Volume spikes often precede reversals, not continuations
- 24h range >5% = high vol regime → cap confidence at 60%

## SIGNAL CONFIRMATION TASK
When given mechanical signal factors to confirm/reject:
- "confirm": true ONLY if ALL of these hold:
  1. Displacement is meaningful for the window size (>0.1% for 5m, >0.3% for 1h, >1% for 4h)
  2. Momentum and velocity agree on direction (both positive or both negative)
  3. Regime is trending or neutral (choppy = veto)
  4. RSI is not extreme (30-70 range)
  5. Enough time remaining (>20% of window)
  6. Composite confidence ≥ 40%
- "confirm": false if ANY factor contradicts, displacement is tiny, or regime is choppy
- confidence_adjustment: -20 to +20, usually -5 to +5
- A +10 adjustment means the mechanical signal is UNDERCONFIDENT
- A -10 adjustment means it's OVERCONFIDENT
- VETO more than you confirm. Bad trades cost money. Skipped trades cost nothing.

## OUTPUT FORMATS

For signal confirmation:
{"confirm":true|false,"confidence_adjustment":-20 to 20,"reasoning":"1-2 sentences"}

For direction prediction:
{"direction":"up|down","confidence":0-100,"reasoning":"1-2 sentences"}

For market prediction:
{"prediction":"yes|no","confidence":0-100,"reasoning":"1-2 sentences"}

## COMMON MISTAKES TO AVOID
1. Confirming weak signals — displacement < 0.1% for 5m or < 0.5% for 1h is noise
2. Anchoring to the market price — if market says 70%, don't just say 70%
3. Overconfidence on crypto — BTC can move 2% in 15 minutes in either direction
4. Confirming when factors disagree — momentum up but order flow down = VETO
5. Ignoring regime — choppy regime = VETO regardless of other factors
6. Producing invalid JSON — this crashes the trading pipeline
"""
MODELFILE_EOF

# Replace placeholders
sed -i '' "s|MODEL_NAME_PLACEHOLDER|$MODEL_NAME|g" "$MODELFILE"
sed -i '' "s|GGUF_PATH_PLACEHOLDER|$GGUF_QUANTIZED|g" "$MODELFILE"

echo "Modelfile: $MODELFILE"
echo ""

# ----- Step 6: Create Ollama model -----
echo "=== Step 6: Creating Ollama model '$MODEL_NAME' ==="
ollama create "$MODEL_NAME" -f "$MODELFILE"

echo ""
echo "=============================================="
echo "Export complete!"
echo "=============================================="
echo ""
echo "Model:     $MODEL_NAME"
echo "GGUF:      $GGUF_QUANTIZED"
echo "Modelfile: $MODELFILE"
echo ""
echo "Test it:   ollama run $MODEL_NAME 'Predict: Will BTC be above \$100k tomorrow? YES=62c NO=38c'"
echo "Use it:    Settings → LLM → Model Name → $MODEL_NAME"
echo ""

# Clean up f16 GGUF (large intermediate file)
read -p "Delete intermediate f16 GGUF ($(du -h "$GGUF_F16" | cut -f1))? [y/N] " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    rm "$GGUF_F16"
    echo "Deleted $GGUF_F16"
fi
