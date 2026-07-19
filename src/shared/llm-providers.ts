export interface LlmModelDef {
	id: string;
	label: string;
	contextWindow?: number;
}

export interface LlmProviderDef {
	id: string;
	label: string;
	baseUrl: string;
	docsUrl: string;
	keyHint: string;
	models: LlmModelDef[];
}

export const CUSTOM_PROVIDER_ID = "custom";

export const LLM_PROVIDERS: LlmProviderDef[] = [
	{
		id: "deepseek",
		label: "DeepSeek",
		baseUrl: "https://api.deepseek.com/v1",
		docsUrl: "https://platform.deepseek.com/api_keys",
		keyHint: "在 DeepSeek 开放平台创建 API Key，填入上方密钥框。",
		models: [
			{ id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", contextWindow: 1_000_000 },
			{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", contextWindow: 1_000_000 },
			{ id: "deepseek-v3.2", label: "DeepSeek V3.2", contextWindow: 160_000 },
			{ id: "deepseek-chat", label: "DeepSeek Chat (V3)", contextWindow: 128_000 },
			{ id: "deepseek-reasoner", label: "DeepSeek Reasoner (R1)", contextWindow: 64_000 }
		]
	},
	{
		id: "dashscope",
		label: "通义千问",
		baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		docsUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key",
		keyHint: "使用阿里云百炼 / DashScope API Key（sk- 开头）。",
		models: [
			{ id: "qwen3.7-max", label: "Qwen3.7 Max", contextWindow: 1_000_000 },
			{ id: "qwen3.7-plus", label: "Qwen3.7 Plus", contextWindow: 1_000_000 },
			{ id: "qwen3.6-flash", label: "Qwen3.6 Flash", contextWindow: 128_000 },
			{ id: "qwen3.5-omni", label: "Qwen3.5 Omni", contextWindow: 128_000 },
			{ id: "qwen3-235b-a22b", label: "Qwen3 235B", contextWindow: 128_000 }
		]
	},
	{
		id: "zhipu",
		label: "智谱 GLM",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		docsUrl: "https://bigmodel.cn/apikey/platform",
		keyHint: "在智谱开放平台创建 API Key。",
		models: [
			{ id: "glm-5.2", label: "GLM-5.2", contextWindow: 1_000_000 },
			{ id: "glm-5.1", label: "GLM-5.1", contextWindow: 200_000 },
			{ id: "glm-5", label: "GLM-5", contextWindow: 1_000_000 },
			{ id: "glm-5-turbo", label: "GLM-5 Turbo", contextWindow: 128_000 },
			{ id: "glm-4.9", label: "GLM-4.9", contextWindow: 128_000 }
		]
	},
	{
		id: "moonshot",
		label: "Kimi",
		baseUrl: "https://api.moonshot.cn/v1",
		docsUrl: "https://platform.moonshot.cn/console/api-keys",
		keyHint: "在 Moonshot 开放平台创建 API Key。",
		models: [
			{ id: "kimi-k2.6", label: "Kimi K2.6", contextWindow: 262_144 },
			{ id: "kimi-k2.5", label: "Kimi K2.5", contextWindow: 262_144 },
			{ id: "kimi-k2.7-code", label: "Kimi K2.7 Code", contextWindow: 262_144 },
			{ id: "kimi-k2.7-code-highspeed", label: "Kimi K2.7 Code Highspeed", contextWindow: 262_144 },
			{ id: "moonshot-v1-128k", label: "Moonshot V1 128K", contextWindow: 128_000 }
		]
	},
	{
		id: "doubao",
		label: "豆包",
		baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
		docsUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
		keyHint: "火山方舟 API Key；可直接使用模型名称或在控制台创建的推理接入点 ID（ep- 开头）。",
		models: [
			{ id: "doubao-seed-2-1-pro-260628", label: "豆包 2.1 Pro", contextWindow: 256_000 },
			{ id: "doubao-seed-2-1-turbo-260628", label: "豆包 2.1 Turbo", contextWindow: 256_000 },
			{ id: "doubao-seed-evolving", label: "豆包 Evolving", contextWindow: 256_000 },
			{ id: "doubao-seed-2-0-pro-260215", label: "豆包 2.0 Pro", contextWindow: 256_000 },
			{ id: "doubao-seed-2-0-lite-260428", label: "豆包 2.0 Lite", contextWindow: 256_000 }
		]
	},
	{
		id: "minimax",
		label: "MiniMax",
		baseUrl: "https://api.minimax.chat/v1",
		docsUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
		keyHint: "在 MiniMax 开放平台创建 API Key。",
		models: [
			{ id: "MiniMax-M3", label: "MiniMax M3", contextWindow: 1_000_000 },
			{ id: "MiniMax-M2.7", label: "MiniMax M2.7", contextWindow: 204_800 },
			{ id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed", contextWindow: 204_800 },
			{ id: "MiniMax-M2.5", label: "MiniMax M2.5", contextWindow: 204_800 },
			{ id: "MiniMax-M2.1", label: "MiniMax M2.1", contextWindow: 204_800 }
		]
	}
];

export const CUSTOM_PROVIDER: LlmProviderDef = {
	id: CUSTOM_PROVIDER_ID,
	label: "自定义",
	baseUrl: "",
	docsUrl: "",
	keyHint: "手动填写 OpenAI 兼容 API 地址与模型名称。",
	models: []
};

export interface LlmSelection {
	providerId: string;
	modelId: string;
	endpoint: string;
	modelLabel: string;
}

function normalizeEndpoint(endpoint: string): string {
	return endpoint.trim().replace(/\/+$/, "").toLowerCase();
}

export function getProvider(id: string): LlmProviderDef | undefined {
	if (id === CUSTOM_PROVIDER_ID) return CUSTOM_PROVIDER;
	return LLM_PROVIDERS.find((p) => p.id === id);
}

export function getAllProviders(): LlmProviderDef[] {
	return LLM_PROVIDERS;
}

export function findProviderByEndpoint(endpoint: string): LlmProviderDef | undefined {
	const normalized = normalizeEndpoint(endpoint);
	if (!normalized) return undefined;
	return LLM_PROVIDERS.find((p) => normalizeEndpoint(p.baseUrl) === normalized);
}

export function findModelInProvider(providerId: string, modelId: string): LlmModelDef | undefined {
	const provider = getProvider(providerId);
	if (!provider || provider.id === CUSTOM_PROVIDER_ID) return undefined;
	return provider.models.find((m) => m.id === modelId);
}

export function resolveSelection(providerId: string, modelId: string): LlmSelection {
	if (providerId === CUSTOM_PROVIDER_ID) {
		return {
			providerId: CUSTOM_PROVIDER_ID,
			modelId,
			endpoint: "",
			modelLabel: modelId
		};
	}
	const provider = getProvider(providerId);
	if (!provider) {
		return {
			providerId: CUSTOM_PROVIDER_ID,
			modelId,
			endpoint: "",
			modelLabel: modelId
		};
	}
	const model = provider.models.find((m) => m.id === modelId) ?? provider.models[0];
	const resolvedModelId = model?.id ?? modelId;
	return {
		providerId: provider.id,
		modelId: resolvedModelId,
		endpoint: provider.baseUrl,
		modelLabel: modelDisplayLabel(resolvedModelId, provider.id)
	};
}

export function inferProviderId(endpoint: string, model: string, savedId?: string): string {
	if (savedId && getProvider(savedId)) return savedId;
	const byEndpoint = findProviderByEndpoint(endpoint);
	if (byEndpoint) return byEndpoint.id;
	if (/^ep-[a-z0-9-]+$/i.test(model)) return "doubao";
	for (const provider of LLM_PROVIDERS) {
		if (provider.models.some((m) => m.id === model)) return provider.id;
	}
	return CUSTOM_PROVIDER_ID;
}

export function providerDisplayLabel(providerId?: string, endpoint?: string): string {
	if (!providerId || providerId === CUSTOM_PROVIDER_ID) {
		if (endpoint) {
			try {
				const host = new URL(endpoint).hostname.replace(/^www\./, "");
				return host || CUSTOM_PROVIDER.label;
			} catch {
				return CUSTOM_PROVIDER.label;
			}
		}
		return CUSTOM_PROVIDER.label;
	}
	return getProvider(providerId)?.label ?? CUSTOM_PROVIDER.label;
}

export function modelDisplayLabel(modelId: string, providerId?: string): string {
	if (!modelId) return "未配置模型";
	if (modelId === "ep-xxxxxxxx") {
		return "豆包（请填写接入点）";
	}
	if (providerId === "doubao" && /^ep-[a-z0-9-]+$/i.test(modelId)) {
		return "豆包接入点";
	}
	if (providerId) {
		const model = findModelInProvider(providerId, modelId);
		if (model) return model.label;
	}
	for (const provider of LLM_PROVIDERS) {
		const model = provider.models.find((m) => m.id === modelId);
		if (model) return model.label;
	}
	return modelId;
}

export function isKnownModel(modelId: string, providerId?: string): boolean {
	if (providerId && providerId !== CUSTOM_PROVIDER_ID) {
		return Boolean(findModelInProvider(providerId, modelId));
	}
	return LLM_PROVIDERS.some((p) => p.models.some((m) => m.id === modelId));
}

export function getModelContextWindow(modelId: string, providerId?: string): number | undefined {
	if (providerId) {
		const model = findModelInProvider(providerId, modelId);
		if (model?.contextWindow) return model.contextWindow;
	}
	for (const provider of LLM_PROVIDERS) {
		const model = provider.models.find((m) => m.id === modelId);
		if (model?.contextWindow) return model.contextWindow;
	}
	return undefined;
}

/** True for智谱 GLM chat models (glm-*). */
export function isGlmModel(modelId: string): boolean {
	return /^glm-/i.test(modelId.trim());
}

/**
 * GLM-5.2+ supports `reasoning_effort` (docs: medium/low→high, xhigh→max).
 * Older GLM thinking models only accept `thinking.type`.
 */
export function supportsGlmReasoningEffort(modelId: string): boolean {
	const id = modelId.trim().toLowerCase();
	if (!id.startsWith("glm-")) return false;
	const match = id.match(/^glm-(\d+)(?:\.(\d+))?/);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2] || "0");
	return major > 5 || (major === 5 && minor >= 2);
}

/**
 * Extra chat/completions body fields for GLM deep-thinking control.
 * Agent tool loops default to `reasoning_effort: high` — GLM-5.2's implicit `max`
 * routinely emits 10k–70k-char Wait/Hmm rumination before a single tool call.
 */
export function buildProviderThinkingFields(modelId: string): Record<string, unknown> {
	if (!isGlmModel(modelId)) return {};
	const fields: Record<string, unknown> = {
		thinking: { type: "enabled" }
	};
	if (supportsGlmReasoningEffort(modelId)) {
		fields.reasoning_effort = "high";
	}
	return fields;
}

/** Per-million-token list prices in CNY (元) for cost estimates. */
export interface ProviderPricing {
	inputMiss: number;
	inputHit: number;
	output: number;
}

/**
 * DeepSeek 中文官网人民币标价（元 / 百万 tokens）。
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 */
const DEEPSEEK_CNY_BY_MODEL: Record<string, ProviderPricing> = {
	"deepseek-v4-flash": { inputHit: 0.02, inputMiss: 1, output: 2 },
	"deepseek-v4-pro": { inputHit: 0.025, inputMiss: 3, output: 6 },
	// Legacy aliases → V4 Flash pricing
	"deepseek-chat": { inputHit: 0.02, inputMiss: 1, output: 2 },
	"deepseek-reasoner": { inputHit: 0.02, inputMiss: 1, output: 2 },
	"deepseek-v3.2": { inputHit: 0.02, inputMiss: 1, output: 2 }
};

const DEFAULT_PRICING: ProviderPricing = DEEPSEEK_CNY_BY_MODEL["deepseek-v4-flash"];

const PROVIDER_PRICING: Record<string, ProviderPricing> = {
	deepseek: DEFAULT_PRICING,
	dashscope: { inputMiss: 2.0, inputHit: 0.5, output: 6.0 },
	zhipu: { inputMiss: 5.0, inputHit: 1.0, output: 5.0 },
	moonshot: { inputMiss: 12.0, inputHit: 12.0, output: 12.0 },
	doubao: { inputMiss: 0.8, inputHit: 0.8, output: 2.0 },
	minimax: { inputMiss: 1.0, inputHit: 0.1, output: 1.0 },
	stepfun: { inputMiss: 5.0, inputHit: 5.0, output: 20.0 },
	baichuan: { inputMiss: 0.5, inputHit: 0.5, output: 0.5 },
	lingyi: { inputMiss: 2.5, inputHit: 2.5, output: 2.5 },
	siliconflow: { inputMiss: 1.0, inputHit: 0.5, output: 1.0 },
	qianfan: { inputMiss: 3.0, inputHit: 3.0, output: 6.0 }
};

export function getProviderPricing(providerId?: string): ProviderPricing {
	if (!providerId || providerId === CUSTOM_PROVIDER_ID) return DEFAULT_PRICING;
	return PROVIDER_PRICING[providerId] ?? DEFAULT_PRICING;
}

/** Prefer model-specific rates (DeepSeek Flash vs Pro); fall back to provider defaults. */
export function getModelPricing(providerId?: string, modelId?: string): ProviderPricing {
	const model = (modelId || "").toLowerCase().trim();
	if (providerId === "deepseek" || (!providerId && model.startsWith("deepseek"))) {
		if (model.includes("v4-pro") || model.includes("v4_pro")) {
			return DEEPSEEK_CNY_BY_MODEL["deepseek-v4-pro"];
		}
		const exact = DEEPSEEK_CNY_BY_MODEL[model];
		if (exact) return exact;
		if (model.includes("v4-flash") || model.includes("v4_flash") || model.includes("flash")) {
			return DEEPSEEK_CNY_BY_MODEL["deepseek-v4-flash"];
		}
		if (model.includes("pro")) {
			return DEEPSEEK_CNY_BY_MODEL["deepseek-v4-pro"];
		}
		return DEEPSEEK_CNY_BY_MODEL["deepseek-v4-flash"];
	}
	return getProviderPricing(providerId);
}
