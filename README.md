# DeltaX Receiving Desk

A receiver enters the ordered carton quantity and a dock note. Firebase AI Logic extracts physical observations. The receiver can correct a count, change the unit, or flag a conflict. The application shows the resulting full, partial, or hold recommendation and preserves the original extraction for comparison. Inventory changes require a separate human workflow.

## Try the test build

Use Node 22.12+ and pnpm. Run `pnpm install --frozen-lockfile` and `pnpm dev`, then open the localhost address. The sample, manual review and recorded benchmark work without credentials. To try live device extraction, use a desktop Chrome installation with the Prompt API and downloaded Gemini Nano model. The first model download needs an internet connection. Enter “Slip lists 10 shipped. I counted 8 cartons on arrival.” with an order of ten. Run extraction and inspect the actual inference source, then flag an unresolved conflict and observe the hold.

For hybrid mode, create a Firebase web app, enable Firebase AI Logic with the Gemini Developer API, register App Check for your origin, and provide these Vite variables before starting the server or building:

- `VITE_FIREBASE_CONFIG` is the Firebase web app configuration as one JSON object.
- `VITE_RECAPTCHA_SITE_KEY` is the public key for the registered reCAPTCHA Enterprise site. For development on localhost, `VITE_LOCAL_APP_CHECK` can instead contain a registered private debug token in a local ignored environment file. Never distribute a debug build or a token.
- Select “Prefer On-Device” for SDK fallback. Cloud generation requires provider quota. Without a Firebase configuration, the build uses device-only extraction. The live extraction source is taken from the SDK response.

The receipt evidence is available offline from this checkout. Run `node --test tests/*.test.js`, `node scripts/compare.js`, and `pnpm build`. The comparison command rebuilds the replay from recorded observations and receipts without calling Evaluate. The production output is in `dist/`. Serve it over localhost or HTTPS. Configuration and supported Chrome hardware are described in [Firebase’s hybrid setup guide](https://firebase.google.com/docs/ai-logic/hybrid/web/get-started).

## What happened in the frozen benchmark

On November 18, 2026, both selectors matched **8 of 12** expected dispositions from the unedited on-device drafts. Each made one incorrect full recommendation and three unnecessary holds. Each correctly held five of six cases requiring review. On R04 the model treated a packing-slip quantity as a physical count. Human verification matters even when both selectors agree.

The service returned twelve distinct hosted receipts for the device drafts. Both selectors received the same candidate choices and locally computed support. This experiment measures agreement and traceability with shared evidence. It does not demonstrate a hosted accuracy advantage. See [case notes](benchmark/cases.json), [protocol](benchmark/protocol.md), [model observations](benchmark/observations), [service receipts](benchmark/receipts) and [matched outcomes](public/data/benchmark.json).

An isolated fallback probe on the same Mac successfully returned eight via the SDK’s cloud route. During the twelve-case benchmark, Google denied free-tier access to the project's cloud generation requests. We retained all twelve failures. The cloud cases therefore have no model drafts, hosted calls or comparable decision accuracy. The benchmark runner saves each completed observation in browser storage. The first development run reloaded before its observations could be preserved.

## Credits

Receiving Desk, the fictional receiving cases, the deterministic policy, the review interface and the benchmark were built for this contest. Antigravity assisted with the interface and policy. The pre-existing hosted Evaluate service and its adapted Apache-2.0 transport are credited in [NOTICE](NOTICE). Firebase's SDK performs all generative inference. The project is licensed under [Apache 2.0](LICENSE).
