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
			{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", contextWindow: 1_000_000 },
			{ id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", contextWindow: 1_000_000 },
			{ id: "deepseek-chat", label: "DeepSeek Chat (V3)", contextWindow: 128_000 },
			{ id: "deepseek-reasoner", label: "DeepSeek Reasoner (R1)", contextWindow: 128_000 }
		]
	},
	{
		id: "dashscope",
		label: "通义千问",
		baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		docsUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key",
		keyHint: "使用阿里云百炼 / DashScope API Key（sk- 开头）。",
		models: [
			{ id: "qwen-max", label: "Qwen Max", contextWindow: 128_000 },
			{ id: "qwen-plus", label: "Qwen Plus", contextWindow: 128_000 },
			{ id: "qwen-turbo", label: "Qwen Turbo", contextWindow: 128_000 },
			{ id: "qwen3-235b-a22b", label: "Qwen3 235B", contextWindow: 128_000 },
			{ id: "qwen3-32b", label: "Qwen3 32B", contextWindow: 128_000 }
		]
	},
	{
		id: "zhipu",
		label: "智谱 GLM",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		docsUrl: "https://bigmodel.cn/apikey/platform",
		keyHint: "在智谱开放平台创建 API Key。",
		models: [
			{ id: "glm-5.2", label: "GLM-5.2", contextWindow: 128_000 },
			{ id: "glm-5.1", label: "GLM-5.1", contextWindow: 128_000 },
			{ id: "glm-5-turbo", label: "GLM-5 Turbo", contextWindow: 128_000 },
			{ id: "glm-5", label: "GLM-5", contextWindow: 1_000_000 }
		]
	},
	{
		id: "moonshot",
		label: "Kimi",
		baseUrl: "https://api.moonshot.cn/v1",
		docsUrl: "https://platform.moonshot.cn/console/api-keys",
		keyHint: "在 Moonshot 开放平台创建 API Key。",
		models: [
			{ id: "moonshot-v1-8k", label: "Kimi 8K", contextWindow: 8_000 },
			{ id: "moonshot-v1-32k", label: "Kimi 32K", contextWindow: 32_000 },
			{ id: "moonshot-v1-128k", label: "Kimi 128K", contextWindow: 128_000 },
			{ id: "kimi-k2-turbo-preview", label: "Kimi K2 Turbo", contextWindow: 128_000 }
		]
	},
	{
		id: "doubao",
		label: "豆包",
		baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
		docsUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
		keyHint: "火山方舟 API Key；模型名称填你在控制台创建的推理接入点 ID（ep- 开头），在下方模型框填写。",
		models: []
	},
	{
		id: "minimax",
		label: "MiniMax",
		baseUrl: "https://api.minimax.chat/v1",
		docsUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
		keyHint: "在 MiniMax 开放平台创建 API Key。",
		models: [
			{ id: "abab6.5s-chat", label: "ABAB 6.5s Chat", contextWindow: 128_000 },
			{ id: "abab6.5g-chat", label: "ABAB 6.5g Chat", contextWindow: 128_000 },
			{ id: "abab6.5t-chat", label: "ABAB 6.5t Chat", contextWindow: 128_000 }
		]
	},
	{
		id: "siliconflow",
		label: "硅基流动",
		baseUrl: "https://api.siliconflow.cn/v1",
		docsUrl: "https://cloud.siliconflow.cn/account/ak",
		keyHint: "在硅基流动控制台创建 API Key；模型名使用平台提供的完整模型 ID。",
		models: [
			{ id: "deepseek-ai/DeepSeek-V3", label: "DeepSeek V3", contextWindow: 128_000 },
			{ id: "Qwen/Qwen2.5-72B-Instruct", label: "Qwen2.5 72B", contextWindow: 32_000 },
			{ id: "THUDM/glm-4-9b-chat", label: "GLM-4 9B", contextWindow: 128_000 }
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

/** Rough CNY per-million-tokens pricing for cost estimates. */
export interface ProviderPricing {
	inputMiss: number;
	inputHit: number;
	output: number;
}

const DEFAULT_PRICING: ProviderPricing = { inputMiss: 0.27, inputHit: 0.07, output: 1.1 };

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
