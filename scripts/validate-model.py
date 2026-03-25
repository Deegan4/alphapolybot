#!/usr/bin/env python3
"""
A/B validation of polytrader vs polytrader-v2 via Ollama API.

Runs 10 canonical test prompts through both models and compares:
- JSON parse success rate
- Schema validity
- Confidence ranges
- Expected confirm/veto decisions

Usage:
    python scripts/validate-model.py
    python scripts/validate-model.py --old-model polytrader --new-model polytrader-v2
    python scripts/validate-model.py --new-model polytrader-v2 --only-new
"""

import argparse
import json
import sys
import urllib.request
import urllib.error

OLLAMA_URL = "http://localhost:11434/v1/chat/completions"

SYSTEM_PROMPT = """You are a quantitative trading analyst for Polymarket prediction markets.
You output ONLY valid JSON — no markdown, no explanation, no preamble."""

# 10 canonical test prompts with expected outcomes
TEST_CASES = [
    # --- Signal confirmations: should CONFIRM (3) ---
    {
        "name": "Strong 4h DOWN signal",
        "type": "signal-confirmation",
        "expected_confirm": True,
        "prompt": """You are confirming a mechanical trading signal for a Polymarket crypto up/down binary market.

MARKET: "BTC 4-hour: Will Bitcoin be above $105000 at 0:00 UTC?"
ASSET: BTC
WINDOW: 4h (130 min remaining)

PRICE DATA:
- Current BTC price: $101200
- Window open price: $104800
- Displacement: -3.4%
- Down outcome price: 62c

SIGNAL FACTORS:
- Momentum (25%): -85%
- Velocity (25%): -72%
- Time Decay (20%): 58%
- Value Bet (15%): 38%
- Order Flow (15%): -60%
- Regime: trending (ST=0.52, LT=0.48) | RSI: 42 | Volatility: 2.1%

MECHANICAL SIGNAL:
- Direction: DOWN
- Composite confidence: 68%

Respond ONLY with JSON:
{"confirm":true/false,"confidence_adjustment":-20 to +20,"reasoning":"1-2 sentences"}""",
    },
    {
        "name": "Good 1h UP signal",
        "type": "signal-confirmation",
        "expected_confirm": True,
        "prompt": """You are confirming a mechanical trading signal for a Polymarket crypto up/down binary market.

MARKET: "BTC 1-hour: Will Bitcoin be above $98500 at 15:00 UTC?"
ASSET: BTC
WINDOW: 1h (35 min remaining)

PRICE DATA:
- Current BTC price: $99200
- Window open price: $98400
- Displacement: +0.8%
- Up outcome price: 56c

SIGNAL FACTORS:
- Momentum (25%): 62%
- Velocity (25%): 55%
- Time Decay (20%): 48%
- Value Bet (15%): 30%
- Order Flow (15%): 45%
- Regime: trending (ST=0.55, LT=0.50) | RSI: 58 | Volatility: 0.9%

MECHANICAL SIGNAL:
- Direction: UP
- Composite confidence: 55%

Respond ONLY with JSON:
{"confirm":true/false,"confidence_adjustment":-20 to +20,"reasoning":"1-2 sentences"}""",
    },
    {
        "name": "Large 24h displacement",
        "type": "signal-confirmation",
        "expected_confirm": True,
        "prompt": """You are confirming a mechanical trading signal for a Polymarket crypto up/down binary market.

MARKET: "BTC 24-hour: Will Bitcoin be above $95000 at 0:00 UTC?"
ASSET: BTC
WINDOW: 24h (600 min remaining)

PRICE DATA:
- Current BTC price: $99500
- Window open price: $95200
- Displacement: +4.5%
- Up outcome price: 68c

SIGNAL FACTORS:
- Momentum (25%): 78%
- Velocity (25%): 65%
- Time Decay (20%): 40%
- Value Bet (15%): 22%
- Order Flow (15%): 55%
- Regime: trending (ST=0.58, LT=0.52) | RSI: 62 | Volatility: 1.5%

MECHANICAL SIGNAL:
- Direction: UP
- Composite confidence: 62%

Respond ONLY with JSON:
{"confirm":true/false,"confidence_adjustment":-20 to +20,"reasoning":"1-2 sentences"}""",
    },
    # --- Signal confirmations: should VETO (3) ---
    {
        "name": "Tiny displacement, low confidence",
        "type": "signal-confirmation",
        "expected_confirm": False,
        "prompt": """You are confirming a mechanical trading signal for a Polymarket crypto up/down binary market.

MARKET: "BTC 5-minute: Will Bitcoin be above $100200 at 12:05 UTC?"
ASSET: BTC
WINDOW: 5m (1 min remaining)

PRICE DATA:
- Current BTC price: $100150
- Window open price: $100180
- Displacement: -0.03%
- Down outcome price: 48c

SIGNAL FACTORS:
- Momentum (25%): -8%
- Velocity (25%): -12%
- Time Decay (20%): 82%
- Value Bet (15%): 28%
- Order Flow (15%): 5%
- Regime: choppy (ST=0.38, LT=0.42) | RSI: 50 | Volatility: 0.15%

MECHANICAL SIGNAL:
- Direction: DOWN
- Composite confidence: 32%

Respond ONLY with JSON:
{"confirm":true/false,"confidence_adjustment":-20 to +20,"reasoning":"1-2 sentences"}""",
    },
    {
        "name": "Factors disagree",
        "type": "signal-confirmation",
        "expected_confirm": False,
        "prompt": """You are confirming a mechanical trading signal for a Polymarket crypto up/down binary market.

MARKET: "BTC 1-hour: Will Bitcoin be above $102000 at 18:00 UTC?"
ASSET: BTC
WINDOW: 1h (25 min remaining)

PRICE DATA:
- Current BTC price: $101500
- Window open price: $101800
- Displacement: -0.29%
- Down outcome price: 50c

SIGNAL FACTORS:
- Momentum (25%): -35%
- Velocity (25%): 20%
- Time Decay (20%): 55%
- Value Bet (15%): 15%
- Order Flow (15%): 40%
- Regime: choppy (ST=0.35, LT=0.40) | RSI: 55 | Volatility: 1.2%

MECHANICAL SIGNAL:
- Direction: DOWN
- Composite confidence: 38%

Respond ONLY with JSON:
{"confirm":true/false,"confidence_adjustment":-20 to +20,"reasoning":"1-2 sentences"}""",
    },
    {
        "name": "Choppy regime, weak signal",
        "type": "signal-confirmation",
        "expected_confirm": False,
        "prompt": """You are confirming a mechanical trading signal for a Polymarket crypto up/down binary market.

MARKET: "BTC 4-hour: Will Bitcoin be above $97000 at 4:00 UTC?"
ASSET: BTC
WINDOW: 4h (90 min remaining)

PRICE DATA:
- Current BTC price: $96800
- Window open price: $97100
- Displacement: -0.31%
- Down outcome price: 52c

SIGNAL FACTORS:
- Momentum (25%): -25%
- Velocity (25%): -18%
- Time Decay (20%): 40%
- Value Bet (15%): 20%
- Order Flow (15%): 10%
- Regime: choppy (ST=0.32, LT=0.38) | RSI: 48 | Volatility: 2.5%

MECHANICAL SIGNAL:
- Direction: DOWN
- Composite confidence: 35%

Respond ONLY with JSON:
{"confirm":true/false,"confidence_adjustment":-20 to +20,"reasoning":"1-2 sentences"}""",
    },
    # --- Direction predictions (2) ---
    {
        "name": "BTC direction - clear down",
        "type": "direction",
        "expected_direction": "down",
        "prompt": """Predict this market outcome. Respond ONLY with JSON.

Q: "BTC 4-hour: Will Bitcoin be above $106000 at 0:00 UTC?"
- Yes: 35%
- No: 62%
- BTC Price: $101500 (displacement: -2.8%)
- Window: 4h, Vol: $72.0B

{"direction":"up|down","confidence":0-100,"reasoning":"1 sentence"}""",
    },
    {
        "name": "BTC direction - slight up",
        "type": "direction",
        "expected_direction": "up",
        "prompt": """Predict this market outcome. Respond ONLY with JSON.

Q: "BTC 1-hour: Will Bitcoin be above $99000 at 14:00 UTC?"
- Yes: 60%
- No: 38%
- BTC Price: $99800 (displacement: +0.9%)
- Window: 1h, Vol: $45.0B

{"direction":"up|down","confidence":0-100,"reasoning":"1 sentence"}""",
    },
    # --- Market predictions (2) ---
    {
        "name": "Market prediction - likely yes",
        "type": "market",
        "expected_prediction": "yes",
        "prompt": """Predict this market outcome. Respond ONLY with JSON.

Q: "Will BTC be above $95000 at end of day?"
- Yes: 72%
- No: 26%
- BTC current: $98500
- 24h range: $96000 - $99200

{"prediction":"yes|no","confidence":0-100,"reasoning":"1 sentence"}""",
    },
    {
        "name": "Market prediction - uncertain",
        "type": "market",
        "prompt": """Predict this market outcome. Respond ONLY with JSON.

Q: "Will BTC be above $100000 at end of day?"
- Yes: 50%
- No: 48%
- BTC current: $99800
- 24h range: $98500 - $101200

{"prediction":"yes|no","confidence":0-100,"reasoning":"1 sentence"}""",
    },
]


def query_ollama(model: str, prompt: str, system: str = SYSTEM_PROMPT) -> dict:
    """Send a prompt to Ollama and return the parsed result."""
    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.15,
        "max_tokens": 256,
    }).encode()

    req = urllib.request.Request(
        OLLAMA_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
            content = data["choices"][0]["message"]["content"].strip()
            return {"raw": content, "error": None}
    except urllib.error.URLError as e:
        return {"raw": "", "error": f"Connection error: {e}"}
    except Exception as e:
        return {"raw": "", "error": str(e)}


def validate_response(response: dict, test_case: dict) -> dict:
    """Validate a model response against expected schema and values."""
    result = {
        "json_valid": False,
        "schema_valid": False,
        "decision_correct": None,
        "confidence_range_ok": None,
        "issues": [],
    }

    if response["error"]:
        result["issues"].append(f"API error: {response['error']}")
        return result

    raw = response["raw"]

    # Parse JSON
    try:
        parsed = json.loads(raw)
        result["json_valid"] = True
    except json.JSONDecodeError:
        # Try extracting JSON from potential markdown wrapper
        import re
        match = re.search(r'\{[^{}]+\}', raw)
        if match:
            try:
                parsed = json.loads(match.group())
                result["json_valid"] = True
                result["issues"].append("JSON was wrapped in non-JSON text")
            except json.JSONDecodeError:
                result["issues"].append(f"Invalid JSON: {raw[:100]}")
                return result
        else:
            result["issues"].append(f"Invalid JSON: {raw[:100]}")
            return result

    # Schema validation
    test_type = test_case["type"]

    if test_type == "signal-confirmation":
        required = {"confirm", "confidence_adjustment", "reasoning"}
        if required.issubset(parsed.keys()):
            result["schema_valid"] = True
        else:
            result["issues"].append(f"Missing keys: {required - set(parsed.keys())}")

        # Check confirm decision
        if "expected_confirm" in test_case and "confirm" in parsed:
            result["decision_correct"] = parsed["confirm"] == test_case["expected_confirm"]

        # Check confidence_adjustment range
        if "confidence_adjustment" in parsed:
            adj = parsed["confidence_adjustment"]
            result["confidence_range_ok"] = -20 <= adj <= 20
            if not result["confidence_range_ok"]:
                result["issues"].append(f"Adjustment {adj} outside [-20, 20]")

    elif test_type == "direction":
        required = {"direction", "confidence", "reasoning"}
        if required.issubset(parsed.keys()):
            result["schema_valid"] = True
        else:
            result["issues"].append(f"Missing keys: {required - set(parsed.keys())}")

        if "expected_direction" in test_case and "direction" in parsed:
            result["decision_correct"] = parsed["direction"] == test_case["expected_direction"]

        if "confidence" in parsed:
            conf = parsed["confidence"]
            result["confidence_range_ok"] = 20 <= conf <= 85
            if not result["confidence_range_ok"]:
                result["issues"].append(f"Confidence {conf} outside [20, 85]")

    elif test_type == "market":
        required = {"prediction", "confidence", "reasoning"}
        if required.issubset(parsed.keys()):
            result["schema_valid"] = True
        else:
            result["issues"].append(f"Missing keys: {required - set(parsed.keys())}")

        if "expected_prediction" in test_case and "prediction" in parsed:
            result["decision_correct"] = parsed["prediction"] == test_case["expected_prediction"]

        if "confidence" in parsed:
            conf = parsed["confidence"]
            result["confidence_range_ok"] = 20 <= conf <= 85
            if not result["confidence_range_ok"]:
                result["issues"].append(f"Confidence {conf} outside [20, 85]")

    return result


def check_ollama_model(model: str) -> bool:
    """Check if a model exists in Ollama."""
    try:
        req = urllib.request.Request(
            "http://localhost:11434/api/tags",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            models = [m["name"].split(":")[0] for m in data.get("models", [])]
            return model in models
    except Exception:
        return False


def print_table(results: dict):
    """Print comparison table."""
    models = list(results.keys())
    header = f"{'#':<3} {'Test Case':<30} "
    for model in models:
        header += f"{'JSON':>5} {'Schema':>7} {'Decision':>9} {'Conf':>5}  "
    print(header)
    print("-" * len(header))

    for i, case in enumerate(TEST_CASES):
        row = f"{i+1:<3} {case['name'][:29]:<30} "
        for model in models:
            r = results[model][i]
            json_ok = "Y" if r["json_valid"] else "N"
            schema_ok = "Y" if r["schema_valid"] else "N"
            decision = "Y" if r["decision_correct"] else ("N" if r["decision_correct"] is False else "-")
            conf = "Y" if r["confidence_range_ok"] else ("N" if r["confidence_range_ok"] is False else "-")
            row += f"{json_ok:>5} {schema_ok:>7} {decision:>9} {conf:>5}  "
        print(row)


def main():
    parser = argparse.ArgumentParser(description="Validate polytrader models via Ollama")
    parser.add_argument("--old-model", default="polytrader", help="Baseline model (default: polytrader)")
    parser.add_argument("--new-model", default="polytrader-v2", help="Fine-tuned model (default: polytrader-v2)")
    parser.add_argument("--only-new", action="store_true", help="Only test the new model")
    args = parser.parse_args()

    # Check Ollama is running
    try:
        urllib.request.urlopen("http://localhost:11434/api/tags", timeout=5)
    except Exception:
        print("Error: Ollama not running. Start it with: ollama serve", file=sys.stderr)
        sys.exit(1)

    models = [args.new_model] if args.only_new else [args.old_model, args.new_model]

    # Check models exist
    for model in models:
        if not check_ollama_model(model):
            print(f"Error: Model '{model}' not found in Ollama. Run: ollama list", file=sys.stderr)
            sys.exit(1)

    print(f"Testing models: {', '.join(models)}")
    print(f"Running {len(TEST_CASES)} test cases per model...\n")

    results = {model: [] for model in models}

    for i, case in enumerate(TEST_CASES):
        print(f"  [{i+1}/{len(TEST_CASES)}] {case['name']}...", end=" ", flush=True)
        for model in models:
            response = query_ollama(model, case["prompt"])
            validation = validate_response(response, case)
            results[model].append(validation)
        print("done")

    # Print results
    print(f"\n{'=' * 70}")
    print("Validation Results")
    print(f"{'=' * 70}\n")
    print_table(results)

    # Summary per model
    print(f"\n{'=' * 70}")
    all_pass = True
    for model in models:
        model_results = results[model]
        json_pass = sum(1 for r in model_results if r["json_valid"])
        schema_pass = sum(1 for r in model_results if r["schema_valid"])
        decision_correct = sum(1 for r in model_results if r["decision_correct"])
        decision_total = sum(1 for r in model_results if r["decision_correct"] is not None)
        conf_ok = sum(1 for r in model_results if r["confidence_range_ok"])
        conf_total = sum(1 for r in model_results if r["confidence_range_ok"] is not None)

        print(f"\n{model}:")
        print(f"  JSON valid:       {json_pass}/{len(TEST_CASES)}")
        print(f"  Schema valid:     {schema_pass}/{len(TEST_CASES)}")
        print(f"  Decision correct: {decision_correct}/{decision_total}")
        print(f"  Confidence range: {conf_ok}/{conf_total}")

        # Issues
        for i, r in enumerate(model_results):
            if r["issues"]:
                for issue in r["issues"]:
                    print(f"  ⚠ Test {i+1} ({TEST_CASES[i]['name']}): {issue}")

        if model == args.new_model:
            if json_pass < len(TEST_CASES):
                all_pass = False
                print(f"\n  FAIL: {model} has JSON parse failures")
            if schema_pass < len(TEST_CASES):
                all_pass = False
                print(f"\n  FAIL: {model} has schema failures")

    if all_pass:
        print(f"\nPASS: {args.new_model} produces valid JSON for all test cases.")
    else:
        print(f"\nFAIL: {args.new_model} has regressions.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
