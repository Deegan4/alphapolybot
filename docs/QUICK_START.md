# Quick start

From a fresh clone to recording signals, with no real orders placed.

## 1. Start the app

```bash
git checkout fix/typecheck-and-runtime-bugs   # until PR #36 is merged
npm run preflight                              # installs, smoke-tests the API, starts the app
```

The app opens at http://localhost:4000. It must be served by this dev server: the
live feeds go through a bridge that only the dev server provides.

In a cloud session there is nothing to open locally: ask Claude to start the app
and use the preview it offers.

## 2. Connect your key

1. Create an API key at polymarket.us/developer. The secret is shown once.
2. In the app: Settings → Wallet → paste the key id and secret → Connect.
   The secret is stored in your browser only.
3. The header balance should match the Polymarket US app.

## 3. Confirm nothing can trade

- Settings → Trading: **Dry Run** is ON (it is by default).
- Settings → Trading → Order Execution: turn on **Record Signals Only**.

## 4. Check the feeds

Settings → API: both live feeds should read `connected`, with `0` in the 429 column.

## 5. Start recording

Start **Microstructure Momentum** and **BTC Up/Down** from the strategy menu.
The banner reads RECORDING SIGNALS ONLY.

## 6. Read the evidence

After a few days: Dashboard → Analytics. The two signal panels show what each
entry threshold and confidence level would have returned after fees.

Before turning Dry Run off, work through `docs/DRY_RUN_CHECKLIST.md`.
