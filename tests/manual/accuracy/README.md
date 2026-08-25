# Accuracy evaluation

This manual suite measures whether MemoGrafter forms the intended topics and memories, retrieves relevant facts, builds useful graft context, and produces a supported answer. It is intentionally separate from live smoke tests, which focus on sanity, performance, and efficiency.

The final-answer call receives the recall and graft context but not the original transcript. This prevents recent chat history from hiding a retrieval failure.

The default run performs deterministic structural and concept checks. `--judge` adds an OpenAI semantic judge with temperature-independent structured scoring. System and evaluator LLM usage are reported separately.

```bash
npm run accuracy:memory
npm run accuracy:memory -- --judge
npm run accuracy:memory -- --write-doc
npm run accuracy:memory -- --judge --write-doc
npm run accuracy:retrieval-impact
```

`accuracy:retrieval-impact` is a deterministic, provider-free A/B regression case. It compares the former similarity-cutoff/top-10 flow with top-40 candidate generation and adaptive selection, and fails unless the new path recovers a relevant high-confidence fact that the legacy path discards.

Use `--strict` only when you want the current baseline thresholds to fail the command. Without it, accuracy misses are reported for analysis while operational failures still return a failing exit code.

Required environment variables: `DATABASE_URL` and `OPENAI_API_KEY`. Set `ACCURACY_JUDGE_MODEL` to choose a different judge model.
