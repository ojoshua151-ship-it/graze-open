# Graze Open

**Every AI call on the cheapest open model that can do the job.**

Entry for the Nebius x NVIDIA Global AI Hackathon, **Best Apps and Agents** track.

**Honest status:** live answers on the hosted demo come from NVIDIA Nemotron models on NVIDIA's API catalog. The Nebius Token Factory path is implemented and can be tested with a Nebius key (see below).

Live demo: https://graze-open-vercel-1.vercel.app/ (add `?mock=1` to the address to see the AI answer flow without an API key)

## The problem

Most AI calls are simple, like pulling a phone number out of text, sorting an inbox or summarizing a ticket. Apps often send everything to one expensive model, so people pay top prices for easy work.

## What it does

Graze Open scores each request and sends it to the smallest NVIDIA Nemotron model that can handle it. Each answer comes back with the model used, the tokens, and an estimated cost next to what a closed frontier model would have charged.

Four tools show it working: a data extractor, an inbox triage, a toil spotter that finds repeated steps and suggests how to automate them, and a data analyst. Each gives an instant rule based result in the browser, plus an AI answer from a Nemotron model when live calls are on.

## For judges: requirements checklist

- **Open source license:** MIT (see `LICENSE`).
- **Setup instructions:** see "Setup and run" below.
- **NVIDIA Nemotron models:** every live answer comes from an NVIDIA Nemotron open source model. The small tier uses `nemotron-3.5-lightning-30b-a3b`, the mid tier uses `nemotron-3.5-super-vl-120b-a12b`, and the large tier uses `nemotron-3-ultra-550b-a55b` (names are set in `api/ai.js` and can be overridden with environment variables).
- **Nebius Token Factory:** the Token Factory call is implemented in `api/ai.js` (OpenAI-compatible chat completions endpoint) and is used whenever a Nebius key is available. I could not create my own Token Factory key because billing registration is not available in my country, so I have not been able to run Token Factory calls from my own account, and I do not claim that Token Factory accelerated my workflow. The hosted demo therefore calls NVIDIA's API catalog for the same Nemotron models. To test the Token Factory path, paste your own Nebius key into the box on the demo page, or set `NEBIUS_API_KEY` on your own deployment.
- **Other Nebius tools or services:** none were used.

## How it uses NVIDIA models, Nebius and the NVIDIA API catalog

- **NVIDIA Nemotron open source models:** a small Nemotron model handles easy, high volume tasks, a mid size one handles the middle tier, and the large Nemotron Ultra model is kept for the hardest or longest requests.
- **Where the live demo runs today:** the hosted demo calls NVIDIA's API catalog (`https://integrate.api.nvidia.com/v1`), because the author could not create a Nebius Token Factory key (billing registration is not available in the author's country). The page labels every answer with the provider that produced it.
- **Nebius Token Factory path:** `api/ai.js` also makes a runtime call to the Token Factory inference API (`https://api.tokenfactory.nebius.com/v1/chat/completions`) whenever a Nebius key is available, either set as `NEBIUS_API_KEY` on the server or pasted by a visitor into the key box on the demo page. Judges can use this to test the Token Factory path with their own key.
- **Routing:** each task has a base tier (extract and triage start small, toil and analyze start mid). The score goes up by one for input over 1,200 characters, one more over 2,500, and one more for over 40 lines. Score 0 is small, 1 is mid, 2 or more is large.
- **Cost:** the function returns tokens and an estimated cost against a frontier model price, so the savings are visible per call.
- **Resilience:** 15 second timeout, per IP and global rate limits, and if a model name is rejected or retired, the function tries the other models in turn.

## What is new in this project

Graze Open was built during the hackathon submission period. The page also shows a "frontier layer" section with simulated demos (agent mode, learning router, model arena). Those are illustrations of where the idea goes next, not live features, and the prices shown are examples.

## Files

- `index.html` is the whole site. The tools work with simple rules in the browser, so the page is useful with no key.
- `api/ai.js` is the Vercel serverless function at `/api/ai`.
- `vercel.json` and `package.json` set the function time limit and basic security headers.
- `.env.example` lists every setting.
- `LICENSE` is MIT.

## Setup and run

1. Get a Nebius Token Factory API key.
2. Push this folder to a Git repo, or run `vercel` from it.
3. In Vercel, open Project Settings, then Environment Variables, and add `NEBIUS_API_KEY`. Check the model ids in your Token Factory model list and set `MODEL_SMALL`, `MODEL_MID` and `MODEL_LARGE` if they differ from the defaults in `.env.example`.
4. Redeploy so the function picks up the key.
5. Open the site, use any tool, and look for the "AI answer" card with the model name.

To run locally: install the Vercel CLI (`npm i -g vercel`), put your settings in a `.env.local` file, and run `vercel dev`.

## Optional fallback: NVIDIA API catalog

If no Nebius key is set, `api/ai.js` can use a free NVIDIA API catalog key (`NVIDIA_API_KEY`, from build.nvidia.com) to call the same NVIDIA Nemotron open models through NVIDIA's OpenAI-compatible endpoint (`https://integrate.api.nvidia.com/v1`). The page labels the source of each answer ("on NVIDIA API catalog" or "on Nebius"). Provider order: a visitor's own Nebius key, then `NEBIUS_API_KEY`, then `NVIDIA_API_KEY`. The Nebius Token Factory path is the main one and is what the hackathon requires.

## Test with your own key (for judges)

On the live page, open "Have a Nebius Token Factory key? Test live answers" under the tools, paste your own Token Factory API key and click Use key. Every tool then makes a real runtime call to Token Factory with Nemotron models. The key is kept only in your browser tab (session storage), is sent in a request header through `api/ai.js` to Nebius for that one request, and is never stored or logged. Close the tab to forget it.

## Test without a key

Open the site with `?mock=1` on the end. The function runs the real routing and cost maths and returns a canned answer marked "mock". Remove `?mock=1` for real calls.

## Behavior to know about

- No key: the function returns `{ live: false, reason: "no_key" }` and the page stays silent about it.
- Other failures (timeout, Nebius error, rate limit) show a short note under the rule based result. Details are in the Vercel function logs.
- The rate limit lives in memory, so each warm instance has its own counters and they reset on cold start. For a hard limit, move the counters to Vercel KV or Upstash Redis.
- Prices on the page and in the cost estimate are examples. Set the `PRICE_*` variables to your real rates.
