import test from "node:test";
import assert from "node:assert/strict";

import {
  getModelTargetFormat,
  getModelsByProviderId,
  supportsClaudeMaxEffort,
  supportsXHighEffort,
} from "../../open-sse/config/providerModels.ts";
import { getUnsupportedParams } from "../../open-sse/config/providerRegistry.ts";
import { modelHasNativeContext1m } from "../../open-sse/config/claudeCodeCompatibleIdentity.ts";
import { modelSupportsContext1mBeta } from "../../open-sse/config/context1m.ts";
import { normalizeClaudeAdaptiveThinking } from "../../open-sse/services/claudeAdaptiveThinking.ts";
import { getNextFamilyFallback } from "../../open-sse/services/modelFamilyFallback.ts";
import { getModelPricing } from "../../open-sse/services/providerCostData.ts";
import { getStaticModelsForProvider } from "../../src/lib/providers/staticModels.ts";
import { getDefaultPricing } from "../../src/shared/constants/pricing.ts";
import {
  getModelSpec,
  normalizeForcedToolChoiceForModel,
  normalizeThinkingForModel,
} from "../../src/shared/constants/modelSpecs.ts";

const MODEL_ID = "claude-fable-5-2";
const BEDROCK_MODEL_ID = "anthropic.claude-fable-5-2";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

test("Claude Fable 5.2 is registered only on verified launch surfaces", () => {
  for (const [providerId, modelId] of [
    ["anthropic", MODEL_ID],
    ["claude", MODEL_ID],
  ] as const) {
    const model = getModelsByProviderId(providerId).find((entry) => entry.id === modelId);
    assert.ok(model, `${providerId} must expose ${modelId}`);
    if (providerId === "vertex" || providerId === "vertex-partner") {
      assert.equal(model.targetFormat, "claude", `${providerId} wire format`);
    } else {
      assert.equal(model.contextLength, 1_000_000, `${providerId} context window`);
      assert.equal(model.maxOutputTokens, 128_000, `${providerId} max output`);
      assert.deepEqual(model.supportedThinkingEfforts, EFFORTS, `${providerId} effort levels`);
    }
  }


  assert.ok(
    getStaticModelsForProvider("claude")?.some((entry) => entry.id === MODEL_ID),
    "Claude OAuth static discovery must expose Fable 5.2"
  );
  assert.equal(
    getNextFamilyFallback(`claude/${MODEL_ID}`, new Set([`claude/${MODEL_ID}`])),
    "claude/claude-fable-5-1"
  );
});

test("Claude Fable 5.2 has native 1M context and adaptive-only thinking", () => {
  assert.equal(modelHasNativeContext1m(MODEL_ID), true);
  assert.equal(modelHasNativeContext1m(BEDROCK_MODEL_ID), true);
  assert.equal(modelSupportsContext1mBeta(MODEL_ID), false);

  const spec = getModelSpec(MODEL_ID);
  assert.equal(spec?.contextWindow, 1_000_000);
  assert.equal(spec?.maxOutputTokens, 128_000);
  assert.equal(spec?.supportsThinking, true);
  assert.equal(spec?.supportsTools, true);
  assert.equal(spec?.supportsVision, true);
  assert.equal(spec?.adaptiveThinkingOnly, true);
  assert.equal(spec?.rejectsThinkingDisabled, true);
  assert.equal(
    (spec as typeof spec & { rejectsForcedToolChoice?: boolean })?.rejectsForcedToolChoice,
    true
  );

  assert.equal(getModelSpec(`global.${BEDROCK_MODEL_ID}`), spec);
  assert.equal(supportsXHighEffort("claude", MODEL_ID), true);
  assert.equal(supportsClaudeMaxEffort(MODEL_ID), true);
});

test("Claude Fable 5.2 strips unsupported sampling parameters", () => {
  for (const providerId of ["anthropic", "claude"] as const) {
    const unsupported = getUnsupportedParams(providerId, MODEL_ID);
    for (const param of ["temperature", "top_p", "top_k"]) {
      assert.ok(unsupported.includes(param), `${providerId}/${MODEL_ID} must strip ${param}`);
    }
  }
});

test("Claude Fable 5.2 normalizes disabled and manual thinking to adaptive", () => {
  const withoutDisabled = normalizeThinkingForModel(
    { model: MODEL_ID, thinking: { type: "disabled" }, marker: true },
    MODEL_ID
  );
  assert.equal("thinking" in withoutDisabled, false);
  assert.equal(withoutDisabled.marker, true);

  const adaptive = normalizeClaudeAdaptiveThinking(
    { model: MODEL_ID, thinking: { type: "enabled", budget_tokens: 64_000 } },
    MODEL_ID
  );
  assert.deepEqual(adaptive.thinking, { type: "adaptive" });
});

test("Claude Fable 5.2 relaxes forced tool choices without removing tools", () => {
  for (const toolChoice of [
    "required",
    "any",
    { type: "any" },
    { type: "tool", name: "read_file" },
    { type: "function", function: { name: "read_file" } },
  ]) {
    const tools = [{ name: "read_file", input_schema: { type: "object" } }];
    const result = normalizeForcedToolChoiceForModel(
      { model: MODEL_ID, tools, tool_choice: toolChoice, marker: true },
      MODEL_ID
    );
    assert.equal("tool_choice" in result, false);
    assert.equal(result.tools, tools);
    assert.equal(result.marker, true);
  }

  const auto = { model: MODEL_ID, tool_choice: { type: "auto" } };
  assert.equal(normalizeForcedToolChoiceForModel(auto, MODEL_ID), auto);

  const older = { model: "claude-fable-5", tool_choice: { type: "tool", name: "read_file" } };
  assert.equal(normalizeForcedToolChoiceForModel(older, "claude-fable-5"), older);
});

test("Claude Fable 5.2 pricing matches Anthropic's published rates", () => {
  for (const providerId of ["anthropic", "cc"] as const) {
    const price = getDefaultPricing()[providerId][MODEL_ID];
    assert.equal(price.input, 8);
    assert.equal(price.output, 40);
    assert.equal(price.cached, 0.2);
    assert.equal(price.reasoning, 40);
    assert.equal(price.cache_creation, 10);
  }

  assert.deepEqual(getModelPricing("anthropic", MODEL_ID), {
    inputCostPer1M: 8,
    outputCostPer1M: 40,
    isFree: false,
    isEstimated: false,
  });
});
