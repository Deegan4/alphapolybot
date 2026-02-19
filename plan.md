# Plan: HuggingFace Inference as LLM Provider Fallback

## Overview
Add HuggingFace Inference API as a fallback/alternative LLM provider in `OpenRouterService`. When OpenRouter fails (rate limit, downtime, budget exhausted), the service automatically retries via HF's OpenAI-compatible chat endpoint. Users can also select HF as their primary provider.

HF Inference Providers expose the same `/v1/chat/completions` shape that OpenRouter uses, so the integration is structurally minimal — same request format, same response parsing.

## Changes

### 1. Type: Add `'huggingface'` to `LLMConfig.provider` union
**File:** `src/types/api.ts`
- Change `provider: 'openrouter' | 'openai' | 'anthropic'` → `'openrouter' | 'openai' | 'anthropic' | 'huggingface'`

### 2. Settings Store: Add `hfApiKey` + setter
**File:** `src/stores/settingsStore.ts`
- Add `hfApiKey: string` to `AppSettingsState` (default `''`)
- Add `setHfApiKey: (key: string) => void` to `SettingsStore` interface
- Add setter impl (simple `set({ hfApiKey: key })` — no dynamic import needed, OpenRouterService reads it on demand)
- Bump version to **v28**

### 3. OpenRouterService: Add `callHuggingFace()` + fallback logic
**File:** `src/services/llm/OpenRouterService.ts`

**New private method `callHuggingFace()`:**
- Base URL: `https://router.huggingface.co/hf-inference/v1/chat/completions`
- Auth: `Bearer ${hfApiKey}` (read from settingsStore on each call)
- Model mapping: Use the same model slug if it's an HF model ID (e.g. `meta-llama/Llama-3.1-70B-Instruct`), otherwise map common OpenRouter slugs to HF equivalents
- Same request shape: `{ model, messages, temperature, max_tokens }`
- Same response shape: OpenAI-compatible `choices[0].message.content`
- Cost: HF free tier = $0.00, estimate from tokens if on paid tier
- No web search plugin support (HF doesn't have it — gracefully skip)

**Fallback in `callOpenRouter()`:**
- On failure (network error, 429, 500+, budget exhausted), if `hfApiKey` is configured, retry once via `callHuggingFace()`
- Log: `[OpenRouterService] Primary failed, falling back to HuggingFace`
- If HF also fails, throw the original OpenRouter error

**New public method `callWithProvider()`** (optional — only if user selects HF as primary):
- If `config.provider === 'huggingface'`, call HF directly (no OpenRouter attempt)
- Otherwise, existing behavior with fallback

### 4. Settings UI: Add HF API Key input + provider selector
**File:** `src/views/SettingsView.tsx`

In `APISettings` component:
- Add `hfApiKey` / `setHfApiKey` from store
- Add `MatrixInput` for HF API Key (placeholder `hf_...`, hint "Free tier available at huggingface.co/settings/tokens")
- Add status badge in the summary grid
- Add provider dropdown (OpenRouter / HuggingFace) that maps to `config.provider`

### 5. Env var support
**File:** `.env.example`
- Add `VITE_HF_API_KEY=` with comment

### 6. Tests
**File:** `src/services/llm/__tests__/OpenRouterService.test.ts`
- Test: HF fallback triggers on OpenRouter 429
- Test: HF fallback triggers on OpenRouter network error
- Test: HF fallback skipped when no HF key configured
- Test: HF as primary provider (config.provider = 'huggingface')
- Test: Model slug mapping (OpenRouter format → HF format)

## Model Mapping Strategy
| OpenRouter slug | HF model ID |
|---|---|
| `meta-llama/llama-3.1-70b-instruct` | `meta-llama/Llama-3.1-70B-Instruct` |
| `meta-llama/llama-3.1-8b-instruct` | `meta-llama/Llama-3.1-8B-Instruct` |
| `mistralai/mistral-7b-instruct` | `mistralai/Mistral-7B-Instruct-v0.3` |
| `qwen/qwen-2.5-72b-instruct` | `Qwen/Qwen2.5-72B-Instruct` |
| (unrecognized) | Pass through as-is |

## What This Does NOT Change
- No new files (everything fits in existing modules)
- No changes to `parsePrediction()` or prompt templates — HF returns the same OpenAI chat format
- No changes to budget tracking logic — HF calls still record cost
- No circular dependency risk — settingsStore setter is a simple `set()`, no dynamic import needed

## Risk Assessment
- **Low risk**: HF's OpenAI-compatible endpoint uses the exact same request/response format
- **Graceful degradation**: If HF key isn't set, fallback is silently skipped
- **No breaking changes**: Existing OpenRouter-only users see zero difference
